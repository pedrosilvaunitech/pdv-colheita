/**
 * Agendador de emissão de NFC-e — fila compartilhada por terminal.
 *
 * O estado da fila vive no banco (`fiscal_queue`), não mais em localStorage.
 * Isso resolve três problemas de operação com múltiplos caixas:
 *
 *  1. Dois caixas não emitem a mesma venda ao mesmo tempo — o job é reservado
 *     atomicamente (`claim_fiscal_jobs` usa FOR UPDATE SKIP LOCKED);
 *  2. Venda de um caixa desligado não fica órfã — outro caixa assume depois de
 *     5 minutos sem sinal de vida do dono;
 *  3. O backoff (1min → 4min → 16min → 1h) sobrevive a reinstalação do PC.
 *
 * Rejeições de conteúdo (XML/CSC/certificado) são marcadas como definitivas e
 * saem do ciclo automático — só voltam por ação manual na tela de erros.
 */

import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { emitDirectFiscal, ENGINE_LABEL } from "@/lib/direct-fiscal";
import { decideRetry, ERROR_CLASS_LABEL } from "@/lib/fiscal-retry-policy";
import {
  claimFiscalJobs,
  completeFiscalJob,
  enqueueFiscalJob,
  type FiscalJob,
} from "@/lib/fiscal-queue";
import { recordTerminalAlert, resolveTerminalAlerts } from "@/lib/terminal-alerts";

/** Intervalo entre varreduras da fila. */
const TICK_MS = 60_000;
/** Quantos jobs um caixa reserva por rodada. */
const BATCH = 6;
/**
 * Emissões simultâneas dentro de um mesmo caixa.
 *
 * Emitir em paralelo é seguro: `reserve_nfce_number` incrementa a numeração
 * em um único UPDATE ... RETURNING atômico, então dois caixas (ou duas
 * emissões do mesmo caixa) nunca recebem o mesmo número. O limite existe só
 * para não saturar o motor local / a SEFAZ com dezenas de conexões.
 */
const CONCURRENCY = 3;

/**
 * Executa `worker` sobre `items` com no máximo `limit` tarefas em voo.
 * Preserva a ordem dos resultados e nunca rejeita — cada worker trata o erro.
 */
async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const lanes = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(lanes);
  return results;
}

/** Vendas fiscais aguardando autorização, mais antigas primeiro. */
export async function listPendingFiscalSales(storeId: string, limit = 50) {
  const { data, error } = await supabase
    .from("sales")
    .select("id, total, finalized_at, fiscal_status, created_at, terminal_key")
    .eq("store_id", storeId)
    .in("fiscal_status", ["pendente", "falha"])
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/**
 * Garante que toda venda pendente/falha tenha um job na fila. Vendas criadas
 * antes desta versão (ou enfileiradas por um caixa que caiu antes de gravar)
 * entram aqui.
 */
export async function syncPendingSalesToQueue(storeId: string): Promise<number> {
  const pending = await listPendingFiscalSales(storeId);
  if (pending.length === 0) return 0;

  const { data: existing } = await supabase
    .from("fiscal_queue")
    .select("sale_id")
    .eq("store_id", storeId)
    .in("status", ["pendente", "processando"]);

  const queued = new Set((existing ?? []).map((r) => (r as { sale_id: string }).sale_id));
  let added = 0;
  for (const sale of pending) {
    if (queued.has(sale.id)) continue;
    const id = await enqueueFiscalJob(storeId, sale.id);
    if (id) added += 1;
  }
  return added;
}

export interface RunRetryResult {
  attempted: number;
  authorized: number;
  failed: number;
}

/** Processa um job reservado e devolve o desfecho. */
async function processJob(storeId: string, job: FiscalJob): Promise<boolean> {
  const r = await emitDirectFiscal({ storeId, saleId: job.sale_id });
  // Política única de retentativa: classifica o erro e decide se o job volta
  // ao ciclo automático ou vira pendência manual (ver `fiscal-retry-policy`).
  const decision = decideRetry(r.error, job.attempts + 1);
  const permanent = !r.ok && decision.permanent;

  await completeFiscalJob({
    jobId: job.id,
    ok: r.ok,
    error: r.error ?? null,
    channel: r.engine ?? r.channel,
    permanent,
  });

  if (r.ok) {
    await resolveTerminalAlerts(storeId, ["fiscal_emit_failed", "fiscal_queue_stuck"]);
    if (r.fellBackToVps && r.engine) {
      // Emitiu, mas pelo motor reserva: sinal de que o principal está doente.
      await recordTerminalAlert({
        storeId,
        kind: "fiscal_fallback_used",
        severity: "aviso",
        title: "Emissão usou o motor reserva",
        detail: `A nota foi autorizada por "${ENGINE_LABEL[r.engine]}" após falha do motor principal.`,
        context: { sale_id: job.sale_id, attempts: r.attempts ?? [] },
      });
    }
    return true;
  }

  await recordTerminalAlert({
    storeId,
    kind: "fiscal_emit_failed",
    severity: permanent ? "critico" : "aviso",
    title: permanent ? "Nota rejeitada — exige correção" : "Falha ao emitir NFC-e",
    detail: r.error ?? "Erro desconhecido na emissão.",
    context: { sale_id: job.sale_id, attempts: r.attempts ?? [], permanent },
  });
  return false;
}

/**
 * Executa uma rodada da fila deste caixa.
 * `force` reprocessa imediatamente as vendas informadas, ignorando o backoff.
 */
export async function runFiscalRetryPass(
  storeId: string,
  opts?: { force?: boolean; saleIds?: string[] },
): Promise<RunRetryResult> {
  const result: RunRetryResult = { attempted: 0, authorized: 0, failed: 0 };

  // Modo forçado por venda: emite direto, sem passar pela reserva da fila.
  if (opts?.force && opts.saleIds?.length) {
    const outcomes = await runPool(opts.saleIds, CONCURRENCY, async (saleId) => {
      const r = await emitDirectFiscal({ storeId, saleId });
      if (r.ok) {
        await supabase
          .from("fiscal_queue")
          .update({ status: "concluida", last_error: null, locked_by: null })
          .eq("sale_id", saleId)
          .in("status", ["pendente", "processando", "falha"]);
        return true;
      }
      await recordTerminalAlert({
        storeId,
        kind: "fiscal_emit_failed",
        severity: "aviso",
        title: "Falha ao reemitir NFC-e",
        detail: r.error ?? "Erro desconhecido.",
        context: { sale_id: saleId },
      });
      return false;
    });
    result.attempted = outcomes.length;
    result.authorized = outcomes.filter(Boolean).length;
    result.failed = outcomes.length - result.authorized;
    return result;
  }

  await syncPendingSalesToQueue(storeId);

  if (opts?.force) {
    // "Reemitir todas": libera o backoff dos jobs pendentes deste caixa.
    await supabase
      .from("fiscal_queue")
      .update({ next_attempt_at: new Date().toISOString(), permanent: false })
      .eq("store_id", storeId)
      .in("status", ["pendente", "falha"]);
  }

  const jobs = await claimFiscalJobs(storeId, opts?.force ? BATCH * 3 : BATCH);

  // Emissão concorrente: várias notas deste caixa saem ao mesmo tempo, e os
  // demais caixas seguem emitindo em paralelo (cada um reserva os próprios
  // jobs via SKIP LOCKED). A numeração continua atômica no banco.
  const outcomes = await runPool(jobs, CONCURRENCY, (job) => processJob(storeId, job));

  result.attempted = outcomes.length;
  result.authorized = outcomes.filter(Boolean).length;
  result.failed = outcomes.length - result.authorized;

  return result;
}

/**
 * Hook de background: varre a fila a cada minuto enquanto a aba está visível.
 * Cada caixa processa a própria fatia, então pode ficar montado em todos os
 * PDVs simultaneamente sem risco de emissão duplicada.
 */
export function useFiscalRetryScheduler(storeId: string | null | undefined, enabled = true) {
  const running = useRef(false);

  useEffect(() => {
    if (!storeId || !enabled) return;

    let cancelled = false;

    const tick = async () => {
      if (running.current || cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      running.current = true;
      try {
        await runFiscalRetryPass(storeId);
      } catch (e) {
        console.warn("[fiscal-scheduler] falha na rodada de reemissão:", e);
      } finally {
        running.current = false;
      }
    };

    // Primeira rodada com atraso curto para não competir com o carregamento.
    const kickoff = window.setTimeout(tick, 15_000);
    const interval = window.setInterval(tick, TICK_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(kickoff);
      window.clearInterval(interval);
    };
  }, [storeId, enabled]);
}
