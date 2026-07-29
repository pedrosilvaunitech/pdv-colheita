/**
 * Identidade de terminal (caixa) — suporte a múltiplos caixas simultâneos.
 *
 * Cada PC/navegador tem um `terminalKey` persistente (UUID em localStorage,
 * reaproveitado de `print-agent`). Esse mesmo identificador é:
 *
 *  1. Registrado na tabela `terminals` (por loja) com nome amigável,
 *     impressora escolhida, versão do agente e último "sinal de vida";
 *  2. Enviado em todo request ao Agente Local no header `X-Terminal-Id`,
 *     e o agente rejeita comandos de um terminal diferente do que ele está
 *     vinculado — impedindo que o Caixa 2 imprima na impressora do Caixa 1;
 *  3. Gravado em `sales.terminal_key` e `invoices.terminal_key` para
 *     auditoria de qual caixa gerou cada venda/nota.
 *
 * A numeração de NFC-e continua atômica no banco (`reserve_nfce_number`),
 * então vários caixas emitindo ao mesmo tempo nunca repetem número.
 */

import { supabase } from "@/integrations/supabase/client";
import { getTerminalId, getTerminalLabel, getSelectedPrinterForStore } from "@/lib/print-agent";

const LS_TERMINAL_NAME = "terminal.name";
const AGENT_BASES = ["http://127.0.0.1:9100", "http://localhost:9100"] as const;

export interface TerminalRow {
  id: string;
  store_id: string;
  terminal_key: string;
  name: string;
  agent_id: string | null;
  agent_version: string | null;
  printer_name: string | null;
  printer_source: string | null;
  scale_port: string | null;
  tef_provider: string | null;
  user_agent: string | null;
  last_seen_at: string;
}

export interface AgentIdentity {
  agent_id: string;
  terminal_key: string | null;
  terminal_name: string | null;
  store_id: string | null;
  version?: string;
}

export { getTerminalId, getTerminalLabel };

/** Nome amigável do caixa neste PC (ex.: "Caixa 01"). */
export function getTerminalName(): string {
  try {
    return localStorage.getItem(LS_TERMINAL_NAME) || `Caixa ${getTerminalLabel()}`;
  } catch {
    return `Caixa ${getTerminalLabel()}`;
  }
}

export function setTerminalName(name: string): void {
  try {
    const clean = name.trim();
    if (clean) localStorage.setItem(LS_TERMINAL_NAME, clean);
    else localStorage.removeItem(LS_TERMINAL_NAME);
  } catch {
    /* noop */
  }
}

/** true se este terminal é o dono do registro (mesma máquina/navegador). */
export function isThisTerminal(row: { terminal_key: string }): boolean {
  return row.terminal_key === getTerminalId();
}

// ─────────────────────────────────────────────────────────────
// Agente local — leitura e vínculo de identidade
// ─────────────────────────────────────────────────────────────

async function agentFetch(path: string, init: RequestInit = {}, timeoutMs = 6000): Promise<Response> {
  let lastError: unknown = null;
  for (const base of AGENT_BASES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(`${base}${path}`, { cache: "no-store", ...init, signal: ctrl.signal });
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : "Agente local offline.");
}

/** Lê a identidade do agente instalado nesta máquina. Nunca lança. */
export async function getAgentIdentity(): Promise<AgentIdentity | null> {
  try {
    const res = await agentFetch("/identity");
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<AgentIdentity> & { ok?: boolean };
    if (!json.agent_id) return null;
    return {
      agent_id: json.agent_id,
      terminal_key: json.terminal_key ?? null,
      terminal_name: json.terminal_name ?? null,
      store_id: json.store_id ?? null,
      version: json.version,
    };
  } catch {
    return null;
  }
}

/**
 * Vincula o agente desta máquina a este terminal/loja. Depois disso o agente
 * recusa comandos vindos de outro `X-Terminal-Id` (HTTP 409).
 */
export async function bindAgentToTerminal(storeId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await agentFetch("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        terminal_key: getTerminalId(),
        terminal_name: getTerminalName(),
        store_id: storeId,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Remove o vínculo — usado ao trocar o PC de caixa. */
export async function unbindAgent(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await agentFetch("/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terminal_key: null, terminal_name: null, store_id: null }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────
// Registro / heartbeat na nuvem
// ─────────────────────────────────────────────────────────────

export interface RegisterTerminalInput {
  storeId: string;
  agentVersion?: string | null;
  agentId?: string | null;
  scalePort?: string | null;
  tefProvider?: string | null;
}

/** Cria ou atualiza o registro deste caixa na loja. Nunca lança. */
export async function registerTerminal(input: RegisterTerminalInput): Promise<TerminalRow | null> {
  const { storeId } = input;
  if (!storeId) return null;
  const printer = getSelectedPrinterForStore(storeId);
  try {
    const { data, error } = await supabase
      .from("terminals")
      .upsert(
        {
          store_id: storeId,
          terminal_key: getTerminalId(),
          name: getTerminalName(),
          agent_id: input.agentId ?? null,
          agent_version: input.agentVersion ?? null,
          printer_name: printer?.name ?? null,
          printer_source: printer?.source ?? null,
          scale_port: input.scalePort ?? null,
          tef_provider: input.tefProvider ?? null,
          user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 300) : null,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "store_id,terminal_key" },
      )
      .select("*")
      .maybeSingle();
    if (error) {
      console.warn("[terminal] falha ao registrar terminal:", error.message);
      return null;
    }
    return (data as TerminalRow) ?? null;
  } catch (e) {
    console.warn("[terminal] erro inesperado no registro:", e);
    return null;
  }
}

/** Lista os caixas da loja, do mais recente ao mais antigo em atividade. */
export async function listTerminals(storeId: string): Promise<TerminalRow[]> {
  const { data, error } = await supabase
    .from("terminals")
    .select("*")
    .eq("store_id", storeId)
    .order("last_seen_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as TerminalRow[];
}

export async function renameTerminal(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("terminals").update({ name: name.trim() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function removeTerminal(id: string): Promise<void> {
  const { error } = await supabase.from("terminals").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Considera "online" quem deu sinal nos últimos 3 minutos. */
export function isTerminalOnline(row: { last_seen_at: string }): boolean {
  return Date.now() - new Date(row.last_seen_at).getTime() < 3 * 60_000;
}

/**
 * Inicia heartbeat periódico (2 min) e sincroniza o vínculo do agente.
 * Retorna função de cleanup para usar em `useEffect`.
 */
export function startTerminalHeartbeat(storeId: string): () => void {
  let cancelled = false;

  const tick = async () => {
    if (cancelled) return;
    const identity = await getAgentIdentity();
    await registerTerminal({
      storeId,
      agentId: identity?.agent_id ?? null,
      agentVersion: identity?.version ?? null,
    });
    // Auto-vincula o agente ao terminal quando ainda estiver livre.
    if (identity && !identity.terminal_key) await bindAgentToTerminal(storeId);

    // Telemetria de saúde: impressora, motor fiscal, balança e TEF.
    // Importada sob demanda para não pesar o carregamento inicial do PDV.
    try {
      const { collectTerminalHealth, publishTerminalHealth } = await import("@/lib/terminal-health");
      const snapshot = await collectTerminalHealth(storeId);
      if (!cancelled) await publishTerminalHealth(storeId, getTerminalId(), snapshot);
    } catch (e) {
      console.warn("[terminal] telemetria de saúde indisponível:", e);
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), 120_000);
  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}
