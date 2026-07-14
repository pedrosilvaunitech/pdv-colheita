/**
 * Sincroniza o histórico local de impressão com a tabela `print_logs`
 * no Cloud. Faz upload apenas das entradas ainda não sincronizadas
 * (flag `synced` no localStorage).
 */
import { supabase } from "@/integrations/supabase/client";
import { getCurrentStoreId } from "@/lib/current-store";
import { getPrintHistory, markHistorySynced, type PrintHistoryEntry } from "./print-history";

export interface SyncResult {
  uploaded: number;
  skipped: number;
  error?: string;
}

export async function syncPrintHistoryToCloud(): Promise<SyncResult> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { uploaded: 0, skipped: 0, error: "Usuário não autenticado" };

  const history = getPrintHistory();
  const pending: Array<{ i: number; entry: PrintHistoryEntry }> = [];
  history.forEach((entry, i) => { if (!entry.synced) pending.push({ i, entry }); });

  if (pending.length === 0) return { uploaded: 0, skipped: history.length };

  const storeId = getCurrentStoreId();
  const rows = pending.map(({ entry }) => ({
    user_id: user.id,
    store_id: storeId ?? null,
    ts: new Date(entry.ts).toISOString(),
    channel: entry.channel,
    ok: entry.ok,
    printer: entry.printer ?? null,
    paper_width: entry.paperWidth ?? null,
    sale_id: entry.saleId ?? null,
    error: entry.error ?? null,
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
  }));

  const { error } = await supabase.from("print_logs").insert(rows);
  if (error) return { uploaded: 0, skipped: pending.length, error: error.message };

  markHistorySynced(pending.map((p) => p.i));
  return { uploaded: rows.length, skipped: history.length - rows.length };
}

/** Contagem de tentativas do Cloud (últimos 30 dias). */
export async function countCloudPrintLogs(): Promise<number | null> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { count, error } = await supabase
    .from("print_logs")
    .select("id", { count: "exact", head: true })
    .gte("ts", since);
  if (error) return null;
  return count ?? 0;
}
