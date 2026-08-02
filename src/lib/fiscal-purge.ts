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
  const env = options.environment && options.environment !== "todos" ? options.environment : null;

  const { data, error } = await supabase.rpc("purge_fiscal_errors", {
    _store_id: storeId,
    _environment: env,
    _include_queue: options.includeQueue ?? true,
    _include_invoices: options.includeInvoices ?? true,
    _invoice_ids: options.invoiceIds ?? null,
    _queue_ids: options.queueIds ?? null,
  });

  if (error) throw new Error(error.message);

  const payload = (data ?? {}) as { invoices_deleted?: number; queue_deleted?: number };
  const invoicesDeleted = Number(payload.invoices_deleted ?? 0);
  const queueDeleted = Number(payload.queue_deleted ?? 0);
  return { invoicesDeleted, queueDeleted, total: invoicesDeleted + queueDeleted };
}
