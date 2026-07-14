/**
 * Cliente HTTP para o Agente de Impressão Local (ver `desktop/agent.cjs`).
 *
 * O agente é um pequeno servidor Node.js instalado no PDV do cliente
 * (via .exe/.msi/.pkg) que escuta em http://127.0.0.1:9100 e converte
 * requisições HTTP em impressões USB usando node-usb + node-thermal-printer.
 *
 * Vantagens sobre WebUSB/Web Serial:
 *  - Zero configuração no Windows (não exige Zadig/WinUSB).
 *  - Funciona em qualquer navegador (Firefox, Safari) além do Chrome/Edge.
 *  - Persiste entre sessões — o operador não precisa reconectar a cada uso.
 *  - Suporta múltiplas impressoras selecionadas por nome.
 *
 * Endpoint aceito pelo agente:
 *   POST http://127.0.0.1:9100/print
 *   Content-Type: application/octet-stream
 *   Body: bytes ESC/POS crus
 *   Header opcional: X-Printer: <nome> (default: primeira encontrada)
 */

const AGENT_URL = "http://127.0.0.1:9100";
const LS_KEY = "print_agent_enabled_v1";
const LS_PRINTER = "print_agent_selected_printer_v1";
const LS_LAST_ERR = "print_agent_last_error_v1";

export interface AgentPrinter {
  name: string;
  paperWidth?: 58 | 80;
  status?: string;
}

export interface AgentStatus {
  online: boolean;
  version?: string;
  printers?: AgentPrinter[];
}

export function isPrintAgentEnabled(): boolean {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(LS_KEY) === "1"; }
  catch { return false; }
}
export function setPrintAgentEnabled(v: boolean): void {
  try {
    if (v) localStorage.setItem(LS_KEY, "1");
    else localStorage.removeItem(LS_KEY);
  } catch { /* noop */ }
}

export function getSelectedPrinter(): string | null {
  try { return localStorage.getItem(LS_PRINTER); } catch { return null; }
}
export function setSelectedPrinter(name: string | null): void {
  try {
    if (name) localStorage.setItem(LS_PRINTER, name);
    else localStorage.removeItem(LS_PRINTER);
  } catch { /* noop */ }
}

export function getLastPrintError(): string | null {
  try { return localStorage.getItem(LS_LAST_ERR); } catch { return null; }
}
export function setLastPrintError(msg: string | null): void {
  try {
    if (msg) localStorage.setItem(LS_LAST_ERR, msg);
    else localStorage.removeItem(LS_LAST_ERR);
  } catch { /* noop */ }
}

function normalizePrinters(raw: unknown): AgentPrinter[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    if (typeof p === "string") return { name: p };
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      const pw = o.paperWidth === 58 || o.paperWidth === 80 ? (o.paperWidth as 58 | 80) : undefined;
      const status = typeof o.status === "string" ? o.status : undefined;
      return { name, paperWidth: pw, status };
    }
    return { name: String(p) };
  }).filter((p) => p.name);
}

export const PRINT_AGENT_EVENT = "print-agent-status";

let lastAgentSignature = "";
function emitAgentStatus(st: AgentStatus): void {
  if (typeof window === "undefined") return;
  const sig = `${st.online ? "1" : "0"}:${st.version ?? ""}:${(st.printers ?? []).map((p) => p.name).join("|")}`;
  if (sig === lastAgentSignature) return;
  lastAgentSignature = sig;
  window.dispatchEvent(new CustomEvent<AgentStatus>(PRINT_AGENT_EVENT, { detail: st }));
}

export async function pingPrintAgent(timeoutMs = 800): Promise<AgentStatus> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${AGENT_URL}/status`, { signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) { const off: AgentStatus = { online: false }; emitAgentStatus(off); return off; }
    const j = await r.json() as { version?: string; printers?: unknown };
    const st: AgentStatus = { online: true, version: j.version, printers: normalizePrinters(j.printers) };
    emitAgentStatus(st);
    return st;
  } catch { const off: AgentStatus = { online: false }; emitAgentStatus(off); return off; }
  finally { clearTimeout(t); }
}

export async function printViaAgent(payload: Uint8Array, printerName?: string | null): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  const target = printerName ?? getSelectedPrinter();
  if (target) headers["X-Printer"] = target;
  const body = new Blob([new Uint8Array(payload)]);
  try {
    const r = await fetch(`${AGENT_URL}/print`, { method: "POST", headers, body });
    if (!r.ok) {
      const msg = await r.text().catch(() => r.statusText);
      const err = `Agente ${r.status}: ${msg}`;
      setLastPrintError(err);
      throw new Error(err);
    }
    setLastPrintError(null);
  } catch (e) {
    if (e instanceof Error && !e.message.startsWith("Agente ")) setLastPrintError(e.message);
    throw e;
  }
}
