/**
 * Histórico de tentativas de impressão (últimas 50), persistido em localStorage.
 * Usado pelo painel de diagnóstico da impressora.
 *
 * Também expõe:
 *  - `PRINT_HISTORY_EVENT` disparado sempre que uma entrada é adicionada,
 *    permitindo que qualquer componente reaja em tempo real.
 *  - `getLastReceipt`/`setLastReceipt` para reimpressão da última tentativa.
 */
import type { ReceiptData } from "./receipt";

const LS_KEY = "print_history_v1";
const LS_LAST_RECEIPT = "print_last_receipt_v1";
const MAX = 50;

export const PRINT_HISTORY_EVENT = "print-history-changed";

export interface PrintHistoryEntry {
  ts: number;
  channel: "agent" | "usb" | "serial" | "none";
  ok: boolean;
  printer?: string;
  paperWidth?: 58 | 80;
  saleId?: string;
  error?: string;
  synced?: boolean;
}

export function getPrintHistory(): PrintHistoryEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PrintHistoryEntry[]) : [];
  } catch { return []; }
}

function writeAll(list: PrintHistoryEntry[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, MAX)));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(PRINT_HISTORY_EVENT, { detail: list[0] }));
    }
  } catch { /* noop */ }
}

export function appendPrintHistory(entry: PrintHistoryEntry): void {
  const list = getPrintHistory();
  list.unshift(entry);
  writeAll(list);
}

export function markHistorySynced(indices: number[]): void {
  const list = getPrintHistory();
  for (const i of indices) if (list[i]) list[i].synced = true;
  writeAll(list);
}

export function clearPrintHistory(): void {
  try {
    localStorage.removeItem(LS_KEY);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(PRINT_HISTORY_EVENT, { detail: null }));
    }
  } catch { /* noop */ }
}

/** Guarda o último recibo enviado para reimpressão manual (após falha). */
export function setLastReceipt(r: ReceiptData): void {
  try {
    const payload = { ...r, issued_at: r.issued_at.toISOString() };
    localStorage.setItem(LS_LAST_RECEIPT, JSON.stringify(payload));
  } catch { /* noop */ }
}
export function getLastReceipt(): ReceiptData | null {
  try {
    const raw = localStorage.getItem(LS_LAST_RECEIPT);
    if (!raw) return null;
    const p = JSON.parse(raw) as ReceiptData & { issued_at: string };
    return { ...p, issued_at: new Date(p.issued_at) };
  } catch { return null; }
}
