/**
 * Limpeza de registros fiscais de erro/teste.
 *
 * Durante a implantação é normal acumular lixo fiscal: notas emitidas em
 * HOMOLOGAÇÃO (ambiente de teste, sem valor fiscal), rascunhos criados sem
 * certificado instalado e jobs de fila que nunca vão sair porque a venda era
 * de teste. Esse lixo poluí a auditoria e assusta o lojista.
 *
 * Regras (aplicadas no banco por `purge_fiscal_errors`, aqui só espelhadas):
 *  - HOMOLOGAÇÃO: pode apagar qualquer nota — não tem validade fiscal;
 *  - PRODUÇÃO: só rascunho / rejeitada / processando. Nota AUTORIZADA ou
 *    CANCELADA nunca é removida, mesmo por administrador (obrigação legal);
 *  - a fila fiscal só perde itens em falha ou travados (>15 min), a não
 *    ser que o gerente selecione itens específicos;
 *  - toda limpeza fica registrada na trilha de auditoria (`rpc_audit_log`).
 */

import { supabase } from "@/integrations/supabase/client";

export type PurgeEnvironment = "homologacao" | "producao" | "todos";

export interface PurgeFiscalOptions {
  /** Ambiente alvo; "todos" deixa o filtro em aberto. */
  environment?: PurgeEnvironment;
  /** Remover itens da fila fiscal (falha/travados). */
  includeQueue?: boolean;
  /** Remover notas não autorizadas / notas de homologação. */
  includeInvoices?: boolean;
  /** Restringe a notas específicas (seleção manual na tela). */
  invoiceIds?: string[];
  /** Restringe a itens de fila específicos. */
  queueIds?: string[];
}

export interface PurgeFiscalResult {
  invoicesDeleted: number;
  queueDeleted: number;
  total: number;
}

/** Contagem prévia — o gerente precisa saber o que vai perder antes de confirmar. */
export interface PurgePreview {
  homologacaoInvoices: number;
  producaoDraftInvoices: number;
  rejectedInvoices: number;
  failedJobs: number;
  stuckJobs: number;
}

const STUCK_MINUTES = 15;

export async function previewFiscalPurge(storeId: string): Promise<PurgePreview> {
  const stuckBefore = new Date(Date.now() - STUCK_MINUTES * 60_000).toISOString();

  const [homolog, drafts, rejected, failed, stuck] = await Promise.all([
    supabase
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("environment", "homologacao"),
    supabase
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("environment", "producao")
      .in("status", ["rascunho", "processando"]),
    supabase
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("environment", "producao")
      .eq("status", "rejeitada"),
    supabase
      .from("fiscal_queue")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("status", "falha"),
    supabase
      .from("fiscal_queue")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .in("status", ["pendente", "processando"])
      .lt("created_at", stuckBefore),
  ]);

  return {
    homologacaoInvoices: homolog.count ?? 0,
    producaoDraftInvoices: drafts.count ?? 0,
    rejectedInvoices: rejected.count ?? 0,
    failedJobs: failed.count ?? 0,
    stuckJobs: stuck.count ?? 0,
  };
}

/**
 * Executa a limpeza. Falha com mensagem clara quando o usuário não é
 * gerente/administrador da loja — a decisão é do banco, não do front.
 */
export async function purgeFiscalErrors(
  storeId: string,
  options: PurgeFiscalOptions = {},
): Promise<PurgeFiscalResult> {
  const env = options.environment && options.environment !== "todos" ? options.environment : undefined;

  const { data, error } = await supabase.rpc("purge_fiscal_errors", {
    _store_id: storeId,
    ...(env ? { _environment: env } : {}),
    _include_queue: options.includeQueue ?? true,
    _include_invoices: options.includeInvoices ?? true,
    ...(options.invoiceIds ? { _invoice_ids: options.invoiceIds } : {}),
    ...(options.queueIds ? { _queue_ids: options.queueIds } : {}),
  });


  if (error) throw new Error(error.message);

  const payload = (data ?? {}) as { invoices_deleted?: number; queue_deleted?: number };
  const invoicesDeleted = Number(payload.invoices_deleted ?? 0);
  const queueDeleted = Number(payload.queue_deleted ?? 0);
  return { invoicesDeleted, queueDeleted, total: invoicesDeleted + queueDeleted };
}

// ── seleção item a item ──────────────────────────────────────────────────────

export interface PurgeableInvoice {
  id: string;
  label: string;
  environment: string;
  status: string;
  reason: string | null;
  createdAt: string;
  total: number;
}

export interface PurgeableJob {
  id: string;
  saleId: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export interface PurgeableRecords {
  invoices: PurgeableInvoice[];
  jobs: PurgeableJob[];
}

/**
 * Lista exatamente o que o gerente PODE apagar, para escolher item a item.
 * O filtro repete a regra do banco: homologação inteira + produção apenas
 * quando a nota nunca foi autorizada.
 */
export async function listPurgeableRecords(
  storeId: string,
  environment: PurgeEnvironment = "todos",
  limit = 200,
): Promise<PurgeableRecords> {
  const stuckBefore = new Date(Date.now() - STUCK_MINUTES * 60_000).toISOString();

  let invoiceQuery = supabase
    .from("invoices")
    .select("id, type, series, number, status, environment, rejection_reason, total, created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (environment !== "todos") invoiceQuery = invoiceQuery.eq("environment", environment);

  const [invRes, jobRes] = await Promise.all([
    invoiceQuery,
    supabase
      .from("fiscal_queue")
      .select("id, sale_id, status, attempts, last_error, created_at")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  if (invRes.error) throw new Error(invRes.error.message);
  if (jobRes.error) throw new Error(jobRes.error.message);

  const invoices: PurgeableInvoice[] = (invRes.data ?? [])
    .filter(
      (i) =>
        String(i.environment) === "homologacao" ||
        ["rascunho", "rejeitada", "processando"].includes(String(i.status)),
    )
    .map((i) => ({
      id: i.id,
      label: `${String(i.type).toUpperCase()} ${i.series}/${i.number}`,
      environment: String(i.environment),
      status: String(i.status),
      reason: i.rejection_reason ?? null,
      createdAt: i.created_at,
      total: Number(i.total ?? 0),
    }));

  const jobs: PurgeableJob[] = (jobRes.data ?? [])
    .filter(
      (j) =>
        j.status === "falha" ||
        (["pendente", "processando"].includes(j.status) && j.created_at < stuckBefore),
    )
    .map((j) => ({
      id: j.id,
      saleId: j.sale_id,
      status: j.status,
      attempts: Number(j.attempts ?? 0),
      lastError: j.last_error ?? null,
      createdAt: j.created_at,
    }));

  return { invoices, jobs };
}

// ── auditoria das limpezas realizadas ────────────────────────────────────────

export interface PurgeAuditRow {
  id: string;
  createdAt: string;
  userId: string | null;
  allowed: boolean;
  detail: string | null;
}

/** Histórico das limpezas (permitidas e negadas) registrado em `rpc_audit_log`. */
export async function listPurgeAudit(storeId: string, limit = 200): Promise<PurgeAuditRow[]> {
  const { data, error } = await supabase
    .from("rpc_audit_log")
    .select("id, created_at, user_id, allowed, detail")
    .eq("store_id", storeId)
    .eq("function_name", "purge_fiscal_errors")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  return (data ?? []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    userId: r.user_id ?? null,
    allowed: Boolean(r.allowed),
    detail: r.detail ?? null,
  }));
}
