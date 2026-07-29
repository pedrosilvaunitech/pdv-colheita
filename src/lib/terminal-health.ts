/**
 * Saúde do terminal (caixa) — coleta, classificação e alertas.
 *
 * A cada heartbeat o PDV monta um retrato do caixa: agente local, impressora,
 * motor fiscal, balança e TEF. Esse retrato vira:
 *
 *  1. `terminals.health_status` + `health_detail` (RPC `record_terminal_health`);
 *  2. Alertas deduplicados em `terminal_alerts` para o que estiver quebrado;
 *  3. Fechamento automático dos alertas do que voltou a funcionar.
 *
 * Classificação: `critico` quando o caixa não consegue vender/imprimir,
 * `alerta` para degradação (balança/TEF fora), `ok` quando tudo responde.
 */

import { fetchAgentDiagnostics, type AgentDiagnostics } from "@/lib/agent-diagnostics";
import { getSelectedPrinterForStore } from "@/lib/print-agent";
import { supabase } from "@/integrations/supabase/client";
import {
  type AlertKind,
  type AlertSeverity,
  recordTerminalAlert,
  resolveTerminalAlerts,
} from "@/lib/terminal-alerts";

export type HealthStatus = "ok" | "alerta" | "critico" | "offline" | "desconhecido";

export interface HealthCheck {
  key: AlertKind;
  label: string;
  ok: boolean;
  severity: AlertSeverity;
  detail: string;
}

export interface TerminalHealthSnapshot {
  status: HealthStatus;
  checkedAt: string;
  agentVersion: string | null;
  agentId: string | null;
  checks: HealthCheck[];
}

const HEALTH_RANK: Record<HealthStatus, number> = {
  ok: 0,
  desconhecido: 1,
  alerta: 2,
  critico: 3,
  offline: 4,
};

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  return HEALTH_RANK[a] >= HEALTH_RANK[b] ? a : b;
}

/**
 * Monta o retrato de saúde deste caixa. Nunca lança — agente offline é um
 * resultado válido (e o mais importante de reportar).
 */
export async function collectTerminalHealth(storeId: string): Promise<TerminalHealthSnapshot> {
  const checkedAt = new Date().toISOString();
  let diagnostics: AgentDiagnostics | null = null;
  let agentError: string | null = null;

  try {
    diagnostics = await fetchAgentDiagnostics(8000);
  } catch (e) {
    agentError = e instanceof Error ? e.message : String(e);
  }

  const checks: HealthCheck[] = [];

  // 1) Agente local — sem ele o caixa perde impressora, gaveta, balança e TEF.
  checks.push({
    key: "agent_offline",
    label: "Agente local",
    ok: Boolean(diagnostics?.ok),
    severity: "critico",
    detail: diagnostics?.ok
      ? `Agente v${diagnostics.version} respondendo em 127.0.0.1:9100.`
      : (agentError ?? "Agente local não respondeu."),
  });

  // 2) Impressora — a selecionada para esta loja precisa existir no agente.
  const selected = getSelectedPrinterForStore(storeId);
  const printers = diagnostics?.printers ?? [];
  const printerFound = selected ? printers.some((p) => p.name === selected.name) : printers.length > 0;
  checks.push({
    key: "printer_missing",
    label: "Impressora",
    ok: Boolean(diagnostics?.ok) && printerFound,
    severity: "critico",
    detail: !diagnostics?.ok
      ? "Não verificada (agente offline)."
      : selected
        ? printerFound
          ? `Impressora "${selected.name}" disponível.`
          : `Impressora "${selected.name}" não foi encontrada no agente.`
        : printers.length > 0
          ? `${printers.length} impressora(s) detectada(s), nenhuma selecionada.`
          : "Nenhuma impressora detectada neste PC.",
  });

  // 3) Motor fiscal embarcado (node-dfe) — só é crítico para emissão direta.
  const engineReady = Boolean(diagnostics?.modules?.nfce && diagnostics?.nfce?.available);
  checks.push({
    key: "fiscal_engine_missing",
    label: "Motor fiscal",
    ok: engineReady,
    severity: "aviso",
    detail: engineReady
      ? "Motor NFC-e carregado no agente."
      : "Motor NFC-e indisponível — a emissão vai usar o servidor fiscal central.",
  });

  // 4) Balança serial — degradação, não bloqueio de venda.
  const scaleConfigured = Boolean(diagnostics?.scale?.config?.enabled && diagnostics?.scale?.config?.path);
  const scaleOk = !scaleConfigured || Boolean(diagnostics?.scale?.connected);
  checks.push({
    key: "scale_offline",
    label: "Balança",
    ok: scaleOk,
    severity: "aviso",
    detail: !scaleConfigured
      ? "Nenhuma balança configurada neste caixa."
      : scaleOk
        ? `Balança conectada em ${String(diagnostics?.scale?.config?.path)}.`
        : (diagnostics?.scale?.lastError ?? "Balança configurada não respondeu."),
  });

  // 5) TEF / pinpad — degradação: o caixa ainda vende em dinheiro/PIX.
  const tefConfigured = Boolean(diagnostics?.tef?.provider);
  const tefOk = !tefConfigured || Boolean(diagnostics?.tef?.ok);
  checks.push({
    key: "tef_offline",
    label: "TEF / Pinpad",
    ok: tefOk,
    severity: "aviso",
    detail: !tefConfigured
      ? "Nenhum provedor TEF configurado."
      : tefOk
        ? `Provedor ${String(diagnostics?.tef?.provider)} pronto.`
        : (diagnostics?.tef?.error ?? "Pinpad não respondeu."),
  });

  let status: HealthStatus = diagnostics?.ok ? "ok" : "offline";
  for (const c of checks) {
    if (c.ok) continue;
    status = worst(status, c.severity === "critico" ? "critico" : "alerta");
  }

  return {
    status,
    checkedAt,
    agentVersion: diagnostics?.version ?? null,
    agentId: (diagnostics as unknown as { agent_id?: string } | null)?.agent_id ?? null,
    checks,
  };
}

/**
 * Publica o retrato no banco e sincroniza os alertas: abre o que quebrou,
 * fecha o que voltou. Nunca lança.
 */
export async function publishTerminalHealth(
  storeId: string,
  terminalKey: string,
  snapshot: TerminalHealthSnapshot,
): Promise<void> {
  try {
    await supabase.rpc("record_terminal_health", {
      _store_id: storeId,
      _terminal_key: terminalKey,
      _health_status: snapshot.status,
      _detail: {
        checked_at: snapshot.checkedAt,
        agent_version: snapshot.agentVersion,
        checks: snapshot.checks.map((c) => ({ key: c.key, ok: c.ok, detail: c.detail })),
      } as never,
    });
  } catch (e) {
    console.warn("[terminal-health] falha ao publicar saúde:", e);
  }

  const broken = snapshot.checks.filter((c) => !c.ok);
  const healed = snapshot.checks.filter((c) => c.ok).map((c) => c.key);

  for (const c of broken) {
    await recordTerminalAlert({
      storeId,
      terminalKey,
      kind: c.key,
      severity: c.severity,
      title: c.label,
      detail: c.detail,
      context: { agent_version: snapshot.agentVersion },
    });
  }
  if (healed.length > 0) await resolveTerminalAlerts(storeId, healed, terminalKey);
}

/** Rótulo/estilo do estado de saúde para a UI. */
export function healthLabel(status: HealthStatus): string {
  switch (status) {
    case "ok":
      return "Saudável";
    case "alerta":
      return "Degradado";
    case "critico":
      return "Crítico";
    case "offline":
      return "Offline";
    default:
      return "Desconhecido";
  }
}
