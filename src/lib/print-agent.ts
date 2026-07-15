/**
 * Cliente HTTP para o Agente de Impressão Local (ver `desktop/agent.cjs`).
 *
 * O agente escuta em http://127.0.0.1:9100 e roteia impressões pelo:
 *  - spooler do Windows (impressoras com driver instalado) — canal "windows"
 *  - USB bruto via libusb — canal "agent"
 *
 * A UI mescla essa lista com WebUSB autorizada (canal "webusb") num único
 * seletor, com escolha automática e memória por loja/terminal.
 *
 * Endpoints:
 *   GET  /status   → { version, printers: AgentPrinter[] }
 *   GET  /printers → mesma resposta (endpoint dedicado)
 *   POST /print    → body: bytes ESC/POS · Headers: X-Printer, X-Printer-Source
 */

import { getCurrentStoreIdSync } from "./current-store";

const AGENT_URL = "http://127.0.0.1:9100";
const LS_KEY = "print_agent_enabled_v1";
const LS_PRINTER_LEGACY = "print_agent_selected_printer_v1";
const LS_SELECTION = "printer.selection.v2";
const LS_TERMINAL_ID = "terminal.id";
const LS_LAST_ERR = "print_agent_last_error_v1";

export type PrinterSource = "agent" | "windows" | "webusb";
export type PrinterStatus = "online" | "offline" | "error";

export interface AgentPrinter {
  name: string;
  source: PrinterSource;
  status: PrinterStatus;
  statusMessage?: string;
  paperWidth?: 58 | 80;
  isDefault?: boolean;
  model?: string;
  vendorId?: number;
  productId?: number;
}

export interface AgentStatus {
  online: boolean;
  version?: string;
  printers?: AgentPrinter[];
}

export interface StoredPrinterSelection {
  name: string;
  source: PrinterSource;
}

// ─────────────────────────────────────────────────────────────
// Flags de habilitação e último erro
// ─────────────────────────────────────────────────────────────

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

export function getLastPrintError(): string | null {
  try { return localStorage.getItem(LS_LAST_ERR); } catch { return null; }
}
export function setLastPrintError(msg: string | null): void {
  try {
    if (msg) localStorage.setItem(LS_LAST_ERR, msg);
    else localStorage.removeItem(LS_LAST_ERR);
  } catch { /* noop */ }
}

// ─────────────────────────────────────────────────────────────
// Terminal ID (por navegador/PC) e seleção por loja+terminal
// ─────────────────────────────────────────────────────────────

/** UUID persistente do terminal (um por navegador/PC). */
export function getTerminalId(): string {
  try {
    let id = localStorage.getItem(LS_TERMINAL_ID);
    if (!id) {
      id = (crypto as Crypto).randomUUID
        ? crypto.randomUUID()
        : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(LS_TERMINAL_ID, id);
    }
    return id;
  } catch {
    return "t-unknown";
  }
}

/** Rótulo curto (últimos 4 chars) para mostrar na UI. */
export function getTerminalLabel(): string {
  const id = getTerminalId();
  return id.slice(-4).toUpperCase();
}

type SelectionMap = Record<string, StoredPrinterSelection>;

function keyFor(storeId: string | null): string {
  return `${storeId ?? "no-store"}::${getTerminalId()}`;
}

function readSelectionMap(): SelectionMap {
  try {
    const raw = localStorage.getItem(LS_SELECTION);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SelectionMap) : {};
  } catch { return {}; }
}

function writeSelectionMap(map: SelectionMap): void {
  try { localStorage.setItem(LS_SELECTION, JSON.stringify(map)); } catch { /* noop */ }
}

/**
 * Migração one-shot: se existir a chave antiga (nome global), converte
 * para a nova chave usando o storeId atual + terminalId e remove a antiga.
 * Assume `source: "agent"` (comportamento anterior).
 */
function migrateLegacySelectionOnce(storeId: string | null): void {
  try {
    const legacy = localStorage.getItem(LS_PRINTER_LEGACY);
    if (!legacy) return;
    const map = readSelectionMap();
    const k = keyFor(storeId);
    if (!map[k]) {
      map[k] = { name: legacy, source: "agent" };
      writeSelectionMap(map);
    }
    localStorage.removeItem(LS_PRINTER_LEGACY);
  } catch { /* noop */ }
}

export function getSelectedPrinterForStore(storeId: string | null): StoredPrinterSelection | null {
  migrateLegacySelectionOnce(storeId);
  return readSelectionMap()[keyFor(storeId)] ?? null;
}

export function setSelectedPrinterForStore(storeId: string | null, sel: StoredPrinterSelection | null): void {
  const map = readSelectionMap();
  const k = keyFor(storeId);
  if (sel) map[k] = sel;
  else delete map[k];
  writeSelectionMap(map);
  emitSelectionChanged();
}

/** Compat: retorna apenas o nome para chamadores antigos (usa store atual). */
export function getSelectedPrinter(): string | null {
  const s = getSelectedPrinterForStore(getCurrentStoreIdSync());
  return s?.name ?? null;
}

/** Compat: define a impressora atual assumindo source "agent". */
export function setSelectedPrinter(name: string | null): void {
  setSelectedPrinterForStore(
    getCurrentStoreIdSync(),
    name ? { name, source: "agent" } : null,
  );
}

export const PRINTER_SELECTION_EVENT = "printer-selection-changed";
function emitSelectionChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PRINTER_SELECTION_EVENT));
}

// ─────────────────────────────────────────────────────────────
// Auto-detecção — prioriza TM-T20X → TM-* → default Windows → primeira
// ─────────────────────────────────────────────────────────────

const AUTO_PRIORITY: Array<(p: AgentPrinter) => boolean> = [
  (p) => /TM[-\s]?T20X/i.test(`${p.name} ${p.model ?? ""}`),
  (p) => /TM[-\s]?T20/i.test(`${p.name} ${p.model ?? ""}`),
  (p) => /TM[-\s]?T88/i.test(`${p.name} ${p.model ?? ""}`),
  (p) => /Epson/i.test(`${p.name} ${p.model ?? ""}`),
  (p) => Boolean(p.isDefault),
  (p) => p.status === "online",
];

export function pickBestPrinter(printers: AgentPrinter[]): AgentPrinter | null {
  if (printers.length === 0) return null;
  for (const test of AUTO_PRIORITY) {
    const match = printers.find(test);
    if (match) return match;
  }
  return printers[0];
}

// ─────────────────────────────────────────────────────────────
// Normalização e polling do agente
// ─────────────────────────────────────────────────────────────

function normalizePrinters(raw: unknown): AgentPrinter[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p): AgentPrinter | null => {
    if (typeof p === "string") return { name: p, source: "windows", status: "online" };
    if (!p || typeof p !== "object") return null;
    const o = p as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    if (!name) return null;
    const rawSource = typeof o.source === "string" ? o.source.toLowerCase() : "";
    const source: PrinterSource = rawSource === "agent" || rawSource === "windows"
      ? rawSource
      : (o.channel === "usb" ? "agent" : "windows");
    const rawStatus = typeof o.status === "string" ? o.status.toLowerCase() : "";
    const status: PrinterStatus = rawStatus === "online" || rawStatus === "offline" || rawStatus === "error"
      ? rawStatus
      : "online";
    const pw = o.paperWidth === 58 || o.paperWidth === 80
      ? (o.paperWidth as 58 | 80)
      : (o.paperWidth === 76 ? 80 : undefined);
    return {
      name,
      source,
      status,
      statusMessage: typeof o.statusMessage === "string" ? o.statusMessage : undefined,
      paperWidth: pw,
      isDefault: Boolean(o.isDefault),
      model: typeof o.model === "string" ? o.model : undefined,
      vendorId: typeof o.vendorId === "number" ? o.vendorId : undefined,
      productId: typeof o.productId === "number" ? o.productId : undefined,
    };
  }).filter((p): p is AgentPrinter => p !== null);
}

export const PRINT_AGENT_EVENT = "print-agent-status";

let lastAgentSignature = "";
function emitAgentStatus(st: AgentStatus): void {
  if (typeof window === "undefined") return;
  const sig = `${st.online ? "1" : "0"}:${st.version ?? ""}:${(st.printers ?? []).map((p) => `${p.source}/${p.name}/${p.status}`).join("|")}`;
  if (sig === lastAgentSignature) return;
  lastAgentSignature = sig;
  window.dispatchEvent(new CustomEvent<AgentStatus>(PRINT_AGENT_EVENT, { detail: st }));
}

export async function pingPrintAgent(timeoutMs = 1200): Promise<AgentStatus> {
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

// ─────────────────────────────────────────────────────────────
// Envio de bytes ESC/POS via agente
// ─────────────────────────────────────────────────────────────

export async function printViaAgent(
  payload: Uint8Array,
  printerName?: string | null,
  source?: PrinterSource | null,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  const sel = printerName || source
    ? { name: printerName ?? "", source: source ?? "agent" as PrinterSource }
    : getSelectedPrinterForStore(getCurrentStoreIdSync());
  if (sel?.name) headers["X-Printer"] = sel.name;
  if (sel?.source && sel.source !== "webusb") headers["X-Printer-Source"] = sel.source;
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
