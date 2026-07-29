/**
 * Alertas de saúde e falhas por caixa.
 *
 * Todo evento relevante do terminal (agente offline, impressora sumida,
 * motor fiscal ausente, balança fora, emissão fiscal falhando) vira um alerta
 * deduplicado no banco via RPC `record_terminal_alert`. A deduplicação usa a
 * chave `terminal_key:kind`, então um agente que fica 40 minutos offline gera
 * UM alerta com `occurrences = 40`, não 40 linhas de ruído.
 *
 * Quando o problema some, o cliente chama `resolveTerminalAlerts` com os tipos
 * que voltaram ao normal — o alerta é fechado com data/hora e autor.
 */

import { supabase } from "@/integrations/supabase/client";
import { getTerminalId } from "@/lib/print-agent";

/** Tipos conhecidos — string livre no banco, catálogo fechado no app. */
export type AlertKind =
  | "agent_offline"
  | "printer_missing"
  | "fiscal_engine_missing"
  | "scale_offline"
  | "tef_offline"
  | "fiscal_emit_failed"
  | "fiscal_queue_stuck"
  | "fiscal_fallback_used"
  | "terminal_unprovisioned";

export type AlertSeverity = "info" | "aviso" | "critico";

export interface TerminalAlertRow {
  id: string;
  store_id: string;
  terminal_key: string | null;
  terminal_name: string | null;
  kind: string;
  severity: AlertSeverity;
  title: string;
  detail: string | null;
  context: Record<string, unknown>;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

export interface RecordAlertInput {
  storeId: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail?: string | null;
  context?: Record<string, unknown>;
  /** Por padrão usa o terminal deste navegador. */
  terminalKey?: string | null;
}

/** Rótulos amigáveis para a UI (evita expor a chave técnica ao operador). */
export const ALERT_KIND_LABEL: Record<string, string> = {
  agent_offline: "Agente local offline",
  printer_missing: "Impressora indisponível",
  fiscal_engine_missing: "Motor fiscal ausente",
  scale_offline: "Balança desconectada",
  tef_offline: "Pinpad/TEF indisponível",
  fiscal_emit_failed: "Falha na emissão fiscal",
  fiscal_queue_stuck: "Fila fiscal travada",
  fiscal_fallback_used: "Emissão usou o motor reserva",
  terminal_unprovisioned: "Caixa não provisionado",
};

export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "Informativo",
  aviso: "Atenção",
  critico: "Crítico",
};

/**
 * Registra (ou incrementa) um alerta. Nunca lança: alerta é telemetria e não
 * pode derrubar o fluxo de venda.
 */
export async function recordTerminalAlert(input: RecordAlertInput): Promise<string | null> {
  if (!input.storeId) return null;
  try {
    const { data, error } = await supabase.rpc("record_terminal_alert", {
      _store_id: input.storeId,
      _terminal_key: (input.terminalKey === undefined ? getTerminalId() : input.terminalKey) ?? undefined,
      _kind: input.kind,
      _severity: input.severity,
      _title: input.title,
      _detail: input.detail ?? undefined,
      _context: (input.context ?? {}) as never,
    });
    if (error) {
      console.warn("[terminal-alerts] falha ao registrar alerta:", error.message);
      return null;
    }
    return (data as string | null) ?? null;
  } catch (e) {
    console.warn("[terminal-alerts] erro inesperado:", e);
    return null;
  }
}

/** Fecha alertas abertos dos tipos informados neste terminal. Nunca lança. */
export async function resolveTerminalAlerts(
  storeId: string,
  kinds: AlertKind[],
  terminalKey: string | null = getTerminalId(),
): Promise<number> {
  if (!storeId || kinds.length === 0) return 0;
  try {
    const { data, error } = await supabase.rpc("resolve_terminal_alerts", {
      _store_id: storeId,
      _terminal_key: terminalKey ?? undefined,
      _kinds: kinds,
    });
    if (error) {
      console.warn("[terminal-alerts] falha ao resolver alertas:", error.message);
      return 0;
    }
    return Number(data ?? 0);
  } catch {
    return 0;
  }
}

export interface ListAlertsOptions {
  /** `false` traz também os já resolvidos (histórico). */
  onlyOpen?: boolean;
  terminalKey?: string | null;
  limit?: number;
}

export async function listTerminalAlerts(
  storeId: string,
  options: ListAlertsOptions = {},
): Promise<TerminalAlertRow[]> {
  const { onlyOpen = true, terminalKey, limit = 50 } = options;
  let query = supabase
    .from("terminal_alerts")
    .select("*")
    .eq("store_id", storeId)
    .order("last_seen_at", { ascending: false })
    .limit(limit);

  if (onlyOpen) query = query.is("resolved_at", null);
  if (terminalKey) query = query.eq("terminal_key", terminalKey);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as TerminalAlertRow[];
}

/** Marca um alerta específico como resolvido manualmente. */
export async function dismissTerminalAlert(id: string): Promise<void> {
  const { error } = await supabase
    .from("terminal_alerts")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

/** Prioridade de ordenação/estilo: crítico > aviso > info. */
export function severityRank(severity: AlertSeverity): number {
  return severity === "critico" ? 2 : severity === "aviso" ? 1 : 0;
}
