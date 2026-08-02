/**
 * Notificação de erros fiscais em segundo plano.
 *
 * O risco real do PDV não é a nota que falha na tela — é a que falha DEPOIS,
 * enquanto o operador já atende o próximo cliente. Sem aviso ativo, a loja
 * descobre a pilha de notas rejeitadas no fim do mês.
 *
 * Este hook observa, a cada 60 segundos:
 *  - `fiscal_queue`: jobs em falha e jobs travados (pendentes há muito tempo);
 *  - `invoices`: notas rejeitadas pela SEFAZ nas últimas 24h.
 *
 * Cuidados deliberados:
 *  - avisa apenas o que é NOVO (guarda a última assinatura vista por loja), para
 *    o caixa não receber o mesmo toast a cada minuto;
 *  - toast sempre, notificação de sistema só se o lojista autorizou;
 *  - falha de rede é silenciosa: monitoramento não pode virar fonte de alarme.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const POLL_MS = 60_000;
const LS_ENABLED = "fiscal.notify.enabled.v1";
const LS_SEEN = "fiscal.notify.seen.v1";
/** Job pendente por mais que isso está travado, não "em andamento". */
const STUCK_MINUTES = 15;

export interface FiscalErrorSnapshot {
  failedJobs: number;
  stuckJobs: number;
  rejectedInvoices: number;
  total: number;
}

const EMPTY: FiscalErrorSnapshot = { failedJobs: 0, stuckJobs: 0, rejectedInvoices: 0, total: 0 };

export function isFiscalNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(LS_ENABLED) !== "0";
  } catch {
    return true;
  }
}

export function setFiscalNotifyEnabled(value: boolean): void {
  try {
    localStorage.setItem(LS_ENABLED, value ? "1" : "0");
  } catch {
    /* noop */
  }
}

/** Pede permissão de notificação do sistema. Só funciona dentro de um clique. */
export async function requestFiscalNotifyPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

function readSeen(storeId: string): string | null {
  try {
    const raw = localStorage.getItem(LS_SEEN);
    if (!raw) return null;
    return (JSON.parse(raw) as Record<string, string>)[storeId] ?? null;
  } catch {
    return null;
  }
}

function writeSeen(storeId: string, signature: string): void {
  try {
    const raw = localStorage.getItem(LS_SEEN);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    map[storeId] = signature;
    localStorage.setItem(LS_SEEN, JSON.stringify(map));
  } catch {
    /* noop */
  }
}

function describe(snapshot: FiscalErrorSnapshot): string {
  const parts: string[] = [];
  if (snapshot.failedJobs) parts.push(`${snapshot.failedJobs} nota(s) em falha`);
  if (snapshot.stuckJobs) parts.push(`${snapshot.stuckJobs} na fila há mais de ${STUCK_MINUTES} min`);
  if (snapshot.rejectedInvoices) parts.push(`${snapshot.rejectedInvoices} rejeitada(s) pela SEFAZ`);
  return parts.join(" · ");
}

async function fetchSnapshot(storeId: string): Promise<FiscalErrorSnapshot> {
  const stuckBefore = new Date(Date.now() - STUCK_MINUTES * 60_000).toISOString();
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

  const [failed, stuck, rejected] = await Promise.all([
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
    supabase
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("status", "rejeitada")
      .gte("created_at", since),
  ]);

  const failedJobs = failed.count ?? 0;
  const stuckJobs = stuck.count ?? 0;
  const rejectedInvoices = rejected.count ?? 0;
  return { failedJobs, stuckJobs, rejectedInvoices, total: failedJobs + stuckJobs + rejectedInvoices };
}

export interface UseFiscalErrorNotificationsResult {
  snapshot: FiscalErrorSnapshot;
  /** Força uma verificação imediata (botão "Verificar agora"). */
  refresh: () => Promise<void>;
}

/**
 * @param storeId loja observada; `null` desliga o monitoramento.
 * @param onOpen ação do botão do toast (normalmente navegar para /fiscal-erros).
 */
export function useFiscalErrorNotifications(
  storeId: string | null,
  onOpen?: () => void,
): UseFiscalErrorNotificationsResult {
  const [snapshot, setSnapshot] = useState<FiscalErrorSnapshot>(EMPTY);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  const check = useCallback(async () => {
    if (!storeId) return;
    let next: FiscalErrorSnapshot;
    try {
      next = await fetchSnapshot(storeId);
    } catch {
      return; // rede instável não deve gerar alarme falso
    }
    setSnapshot(next);

    if (next.total === 0) {
      writeSeen(storeId, "0");
      return;
    }
    if (!isFiscalNotifyEnabled()) return;

    // Só avisa quando o quadro MUDA — evita repetir o mesmo toast a cada minuto.
    const signature = `${next.failedJobs}:${next.stuckJobs}:${next.rejectedInvoices}`;
    if (readSeen(storeId) === signature) return;
    writeSeen(storeId, signature);

    const detail = describe(next);
    toast.error("Pendências fiscais", {
      description: detail,
      duration: 12_000,
      action: openRef.current ? { label: "Ver erros", onClick: () => openRef.current?.() } : undefined,
    });

    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification("Pendências fiscais no PDV", { body: detail, tag: "fiscal-errors" });
      } catch {
        /* alguns navegadores exigem service worker: toast já cobriu */
      }
    }
  }, [storeId]);

  useEffect(() => {
    if (!storeId) {
      setSnapshot(EMPTY);
      return;
    }
    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    // Voltar para a aba é o momento mais provável de o gerente agir.
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [storeId, check]);

  return { snapshot, refresh: check };
}
