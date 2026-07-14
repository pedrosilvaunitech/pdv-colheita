/**
 * Histórico de tentativas de impressão (últimas 50), persistido em localStorage.
 * Usado pelo painel de diagnóstico da impressora.
 */

const LS_KEY = "print_history_v1";
const MAX = 50;

export interface PrintHistoryEntry {
  ts: number;
  channel: "agent" | "usb" | "serial" | "none";
  ok: boolean;
  printer?: string;
  paperWidth?: 58 | 80;
  saleId?: string;
  error?: string;
}

export function getPrintHistory(): PrintHistoryEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PrintHistoryEntry[]) : [];
  } catch { return []; }
}

export function appendPrintHistory(entry: PrintHistoryEntry): void {
  try {
    const list = getPrintHistory();
    list.unshift(entry);
    if (list.length > MAX) list.length = MAX;
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch { /* noop */ }
}

export function clearPrintHistory(): void {
  try { localStorage.removeItem(LS_KEY); } catch { /* noop */ }
}
