/**
 * Agendador de reemissão de NFC-e.
 *
 * Vendas marcadas como `fiscal_status = 'pendente' | 'falha'` são reemitidas
 * automaticamente em segundo plano enquanto o PDV estiver aberto. O estado de
 * tentativas vive em localStorage (por venda) para sobreviver a reloads e
 * evitar martelar a SEFAZ com a mesma nota rejeitada.
 *
 * Backoff exponencial: 1min, 4min, 16min, 64min… até MAX_ATTEMPTS.
 * Rejeições definitivas (schema/validação) não são reagendadas — só falhas de
 * disponibilidade (agente offline, timeout, VPS fora) merecem retry.
 */

import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { emitDirectFiscal } from "@/lib/direct-fiscal";

const STORAGE_KEY = "fiscal-retry-state-v1";
const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 60_000;
/** Intervalo entre varreduras da fila. */
const TICK_MS = 60_000;

export interface RetryEntry {
  saleId: string;
  attempts: number;
  nextAt: number;
  lastError?: string;
  /** true quando a SEFAZ rejeitou por conteúdo — exige correção manual. */
  permanent?: boolean;
}

type RetryState = Record<string, RetryEntry>;

function readState(): RetryState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RetryState) : {};
  } catch {
    return {};
  }
}

function writeState(state: RetryState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota cheia: agendamento vira best-effort na sessão atual */
  }
}

export function getRetryState(): RetryState {
  return readState();
}

export function getRetryEntry(saleId: string): RetryEntry | undefined {
  return readState()[saleId];
}

/** Zera o histórico de uma venda para permitir nova tentativa imediata. */
export function resetRetry(saleId: string) {
  const state = readState();
  delete state[saleId];
  writeState(state);
}

/**
 * Erros de rejeição fiscal (conteúdo inválido) não devem ser reagendados:
 * a nota vai ser rejeitada de novo com o mesmo payload.
 */
function isPermanentError(error?: string): boolean {
  if (!error) return false;
  return /rejei[çc][aã]o|rejected|inv[aá]lid|schema|xml|certificado|senha|assinatura|duplicidade|CSC|IE\b/i.test(error);
}

function scheduleNext(state: RetryState, saleId: string, error?: string) {
  const prev = state[saleId];
  const attempts = (prev?.attempts ?? 0) + 1;
  const permanent = isPermanentError(error) || attempts >= MAX_ATTEMPTS;
  state[saleId] = {
    saleId,
    attempts,
    lastError: error,
    permanent,
    nextAt: Date.now() + BASE_DELAY_MS * Math.pow(4, Math.min(attempts - 1, 3)),
  };
}

/** Vendas fiscais aguardando autorização, mais antigas primeiro. */
export async function listPendingFiscalSales(storeId: string, limit = 20) {
  const { data, error } = await supabase
    .from("sales")
    .select("id, total, finalized_at, fiscal_status, created_at")
    .eq("store_id", storeId)
    .in("fiscal_status", ["pendente", "falha"])
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export interface RunRetryResult {
  attempted: number;
  authorized: number;
  failed: number;
}

/**
 * Executa uma rodada da fila. `force` ignora o backoff (usado no botão
 * "Tentar agora" da tela de erros fiscais).
 */
export async function runFiscalRetryPass(storeId: string, opts?: { force?: boolean; saleIds?: string[] }): Promise<RunRetryResult> {
  const force = opts?.force ?? false;
  const state = readState();
  const now = Date.now();

  let candidates = opts?.saleIds
    ? opts.saleIds.map((id) => ({ id }))
    : (await listPendingFiscalSales(storeId)).map((s) => ({ id: s.id }));

  if (!force) {
    candidates = candidates.filter((c) => {
      const entry = state[c.id];
      if (!entry) return true;
      if (entry.permanent) return false;
      return entry.nextAt <= now;
    });
  }

  const result: RunRetryResult = { attempted: 0, authorized: 0, failed: 0 };

  // Sequencial de propósito: a numeração NFC-e é atômica por loja e emitir em
  // paralelo aumenta a chance de colisão de número/duplicidade na SEFAZ.
  for (const c of candidates) {
    result.attempted += 1;
    const r = await emitDirectFiscal({ storeId, saleId: c.id });
    if (r.ok) {
      result.authorized += 1;
      delete state[c.id];
    } else {
      result.failed += 1;
      scheduleNext(state, c.id, r.error);
    }
  }

  writeState(state);
  return result;
}

/**
 * Hook de background: varre a fila a cada minuto enquanto a aba está visível.
 * Montar uma única vez (app shell) para não duplicar emissões.
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
