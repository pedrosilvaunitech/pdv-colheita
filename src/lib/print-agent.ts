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

export interface AgentStatus {
  online: boolean;
  version?: string;
  printers?: string[];
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

export async function pingPrintAgent(timeoutMs = 800): Promise<AgentStatus> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${AGENT_URL}/status`, { signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) return { online: false };
    const j = await r.json() as { version?: string; printers?: string[] };
    return { online: true, version: j.version, printers: j.printers };
  } catch { return { online: false }; }
  finally { clearTimeout(t); }
}

export async function printViaAgent(payload: Uint8Array, printerName?: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  if (printerName) headers["X-Printer"] = printerName;
  const body = new Blob([new Uint8Array(payload)]);
  const r = await fetch(`${AGENT_URL}/print`, { method: "POST", headers, body });
  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText);
    throw new Error(`Agente respondeu ${r.status}: ${msg}`);
  }
}
