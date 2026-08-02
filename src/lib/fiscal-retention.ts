/**
 * Política de RETENÇÃO dos dados fiscais.
 *
 * O agendamento antigo (localStorage) só roda enquanto um caixa está com o PDV
 * aberto — se a loja fecha o navegador, o lixo fiscal volta a acumular. Aqui a
 * regra passa a viver no banco (`fiscal_purge_settings`) e é executada por
 * pg_cron todos os dias às 03:20, independente de haver alguém logado.
 *
 * Decisões deliberadas:
 *  - retenção separada por natureza do dado: homologação (descartável),
 *    produção não autorizada (delicada), fila fiscal e trilha de auditoria;
 *  - produção só entra na limpeza automática com opt-in explícito, e mesmo
 *    assim o banco jamais apaga nota AUTORIZADA ou CANCELADA;
 *  - a permissão é decidida pelo banco (`can_manage_store`), não pelo front.
 */

import { supabase } from "@/integrations/supabase/client";

export interface FiscalRetentionSettings {
  storeId: string;
  enabled: boolean;
  purgeInvoices: boolean;
  purgeQueue: boolean;
  includeProducao: boolean;
  homologRetentionDays: number;
  producaoRetentionDays: number;
  queueRetentionDays: number;
  auditRetentionDays: number;
  lastRunAt: string | null;
  lastResult: RetentionResult | null;
}

export interface RetentionResult {
  homologacaoInvoices: number;
  producaoInvoices: number;
  queueItems: number;
  auditRows: number;
  total: number;
  ranAt?: string | null;
}

/** Prévia do que a retenção configurada removeria AGORA. */
export type RetentionPreview = RetentionResult;

export const DEFAULT_RETENTION: Omit<FiscalRetentionSettings, "storeId" | "lastRunAt" | "lastResult"> = {
  enabled: false,
  purgeInvoices: true,
  purgeQueue: true,
  includeProducao: false,
  homologRetentionDays: 7,
  producaoRetentionDays: 30,
  queueRetentionDays: 3,
  auditRetentionDays: 365,
};

type RawResult = Record<string, unknown> | null;

function parseResult(raw: RawResult): RetentionResult | null {
  if (!raw || typeof raw !== "object") return null;
  const n = (k: string) => Number((raw as Record<string, unknown>)[k] ?? 0) || 0;
  const total = n("total");
  const parsed: RetentionResult = {
    homologacaoInvoices: n("homologacao_invoices"),
    producaoInvoices: n("producao_invoices"),
    queueItems: n("queue_items"),
    auditRows: n("audit_rows"),
    total,
    ranAt: typeof (raw as Record<string, unknown>)["ran_at"] === "string"
      ? String((raw as Record<string, unknown>)["ran_at"])
      : null,
  };
  return parsed;
}

/** Lê a política da loja; devolve os padrões quando nunca foi configurada. */
export async function getFiscalRetention(storeId: string): Promise<FiscalRetentionSettings> {
  const { data, error } = await supabase
    .from("fiscal_purge_settings")
    .select("*")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return { storeId, ...DEFAULT_RETENTION, lastRunAt: null, lastResult: null };

  return {
    storeId,
    enabled: Boolean(data.enabled),
    purgeInvoices: Boolean(data.purge_invoices),
    purgeQueue: Boolean(data.purge_queue),
    includeProducao: Boolean(data.include_producao),
    homologRetentionDays: Number(data.homolog_retention_days ?? 7),
    producaoRetentionDays: Number(data.producao_retention_days ?? 30),
    queueRetentionDays: Number(data.queue_retention_days ?? 3),
    auditRetentionDays: Number(data.audit_retention_days ?? 365),
    lastRunAt: data.last_run_at ?? null,
    lastResult: parseResult(data.last_result as RawResult),
  };
}

export type FiscalRetentionPatch = Partial<
  Omit<FiscalRetentionSettings, "storeId" | "lastRunAt" | "lastResult">
>;

/** Grava a política (upsert por loja). Falha com mensagem clara sem permissão. */
export async function saveFiscalRetention(
  storeId: string,
  current: FiscalRetentionSettings,
  patch: FiscalRetentionPatch,
): Promise<FiscalRetentionSettings> {
  const next = { ...current, ...patch };
  const clamp = (v: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)));

  const payload = {
    store_id: storeId,
    enabled: next.enabled,
    purge_invoices: next.purgeInvoices,
    purge_queue: next.purgeQueue,
    include_producao: next.includeProducao,
    homolog_retention_days: clamp(next.homologRetentionDays, 0, 3650),
    producao_retention_days: clamp(next.producaoRetentionDays, 1, 3650),
    queue_retention_days: clamp(next.queueRetentionDays, 0, 3650),
    audit_retention_days: clamp(next.auditRetentionDays, 30, 3650),
  };

  const { error } = await supabase
    .from("fiscal_purge_settings")
    .upsert(payload, { onConflict: "store_id" });

  if (error) {
    throw new Error(
      /row-level security|permission/i.test(error.message)
        ? "Apenas administradores e gerentes da loja podem alterar a retenção fiscal."
        : error.message,
    );
  }

  return getFiscalRetention(storeId);
}

/** Prévia (RPC no banco, usando os mesmos filtros da limpeza real). */
export async function previewFiscalRetention(storeId: string): Promise<RetentionPreview> {
  const { data, error } = await supabase.rpc("preview_fiscal_retention", { _store_id: storeId });
  if (error) throw new Error(error.message);
  return (
    parseResult(data as RawResult) ?? {
      homologacaoInvoices: 0,
      producaoInvoices: 0,
      queueItems: 0,
      auditRows: 0,
      total: 0,
    }
  );
}

/** Executa a retenção agora (mesma rotina que o pg_cron chama de madrugada). */
export async function applyFiscalRetention(storeId: string): Promise<RetentionResult> {
  const { data, error } = await supabase.rpc("apply_fiscal_retention", { _store_id: storeId });
  if (error) throw new Error(error.message);
  return (
    parseResult(data as RawResult) ?? {
      homologacaoInvoices: 0,
      producaoInvoices: 0,
      queueItems: 0,
      auditRows: 0,
      total: 0,
    }
  );
}
