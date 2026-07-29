/**
 * Fila de emissão fiscal por terminal.
 *
 * Antes, cada caixa guardava as tentativas em localStorage — dois caixas
 * podiam tentar emitir a MESMA venda ao mesmo tempo (risco de duplicidade na
 * SEFAZ) e uma venda ficava órfã se o PC dono fosse desligado.
 *
 * Agora a fila vive na tabela `fiscal_queue`:
 *  - `enqueueFiscalJob` registra a venda com o `terminal_key` de origem;
 *  - `claimFiscalJobs` reserva atomicamente (SKIP LOCKED) os jobs DESTE caixa
 *    e assume os órfãos de caixas offline há mais de 5 minutos;
 *  - `completeFiscalJob` fecha com sucesso, agenda o retry com backoff
 *    exponencial (1min → 4min → 16min → 1h) ou marca falha definitiva.
 */

import { supabase } from "@/integrations/supabase/client";
import { getTerminalId } from "@/lib/print-agent";

export type FiscalJobStatus = "pendente" | "processando" | "concluida" | "falha" | "cancelada";

export interface FiscalJob {
  id: string;
  store_id: string;
  sale_id: string;
  terminal_key: string | null;
  status: FiscalJobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  permanent: boolean;
  last_error: string | null;
  last_channel: string | null;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

export const JOB_STATUS_LABEL: Record<FiscalJobStatus, string> = {
  pendente: "Na fila",
  processando: "Emitindo",
  concluida: "Autorizada",
  falha: "Falhou",
  cancelada: "Cancelada",
};

/** Coloca a venda na fila do caixa atual. Idempotente por venda ativa. */
export async function enqueueFiscalJob(storeId: string, saleId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("enqueue_fiscal_job", {
      _store_id: storeId,
      _sale_id: saleId,
      _terminal_key: getTerminalId(),
    });
    if (error) {
      console.warn("[fiscal-queue] falha ao enfileirar:", error.message);
      return null;
    }
    return (data as string | null) ?? null;
  } catch (e) {
    console.warn("[fiscal-queue] erro inesperado ao enfileirar:", e);
    return null;
  }
}

/**
 * Reserva jobs para este caixa processar. Retorna vazio quando não há nada
 * elegível — nunca lança para não derrubar o loop de background.
 */
export async function claimFiscalJobs(storeId: string, limit = 3): Promise<FiscalJob[]> {
  try {
    const { data, error } = await supabase.rpc("claim_fiscal_jobs", {
      _store_id: storeId,
      _terminal_key: getTerminalId(),
      _limit: limit,
    });
    if (error) {
      console.warn("[fiscal-queue] falha ao reservar jobs:", error.message);
      return [];
    }
    return (data ?? []) as unknown as FiscalJob[];
  } catch (e) {
    console.warn("[fiscal-queue] erro inesperado ao reservar jobs:", e);
    return [];
  }
}

export interface CompleteJobInput {
  jobId: string;
  ok: boolean;
  error?: string | null;
  channel?: string | null;
  /** Rejeição de conteúdo: não adianta tentar de novo com o mesmo XML. */
  permanent?: boolean;
}

export async function completeFiscalJob(input: CompleteJobInput): Promise<void> {
  try {
    const { error } = await supabase.rpc("complete_fiscal_job", {
      _job_id: input.jobId,
      _ok: input.ok,
      _error: input.error ?? undefined,
      _channel: input.channel ?? undefined,
      _permanent: input.permanent ?? false,
    });
    if (error) console.warn("[fiscal-queue] falha ao fechar job:", error.message);
  } catch (e) {
    console.warn("[fiscal-queue] erro inesperado ao fechar job:", e);
  }
}

/** Reabre um job travado em falha (botão "tentar de novo"). */
export async function retryFiscalJob(jobId: string): Promise<void> {
  const { error } = await supabase.rpc("retry_fiscal_job", { _job_id: jobId });
  if (error) throw new Error(error.message);
}

export interface ListJobsOptions {
  statuses?: FiscalJobStatus[];
  terminalKey?: string;
  limit?: number;
}

export async function listFiscalJobs(storeId: string, options: ListJobsOptions = {}): Promise<FiscalJob[]> {
  const { statuses, terminalKey, limit = 100 } = options;
  let query = supabase
    .from("fiscal_queue")
    .select("*")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (statuses?.length) query = query.in("status", statuses);
  if (terminalKey) query = query.eq("terminal_key", terminalKey);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as FiscalJob[];
}

/** Contadores para o painel (fila, emitindo, falhas). */
export async function getQueueSummary(storeId: string): Promise<Record<FiscalJobStatus, number>> {
  const empty: Record<FiscalJobStatus, number> = {
    pendente: 0,
    processando: 0,
    concluida: 0,
    falha: 0,
    cancelada: 0,
  };
  const { data, error } = await supabase.from("fiscal_queue").select("status").eq("store_id", storeId);
  if (error) return empty;
  for (const row of data ?? []) {
    const s = (row as { status: FiscalJobStatus }).status;
    if (s in empty) empty[s] += 1;
  }
  return empty;
}
