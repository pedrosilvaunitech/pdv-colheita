/**
 * Cliente TEF — fala exclusivamente com o Agente Local (127.0.0.1:9100).
 *
 * O navegador JAMAIS acessa o PIN Pad por USB: toda a comunicação com o
 * hardware e com o SDK do provedor acontece dentro do agente instalado no PC
 * do caixa. Aqui só existe HTTP local + SSE de eventos.
 */

export type TefPaymentType = "credit" | "debit";

export type TefState =
  | "idle" | "waiting_card" | "insert_card" | "tap_card" | "remove_card"
  | "pin_required" | "processing" | "approved" | "denied" | "cancelled"
  | "timeout" | "error" | "receipt_ready";

export interface TefEvent {
  provider?: string;
  state: TefState;
  at: string;
  message?: string;
  result?: TefResult;
}

/** Formato único de resposta — idêntico para qualquer provedor. */
export interface TefResult {
  success: boolean;
  status: string;
  nsu: string | null;
  authorizationCode: string | null;
  acquirer: string | null;
  provider: string | null;
  cardBrand: string | null;
  cardType: string | null;
  installments: number;
  amount: number;
  orderId: string | null;
  transactionId: string | null;
  receiptCustomer: string | null;
  receiptMerchant: string | null;
  message?: string | null;
  timestamp: string;
}

export interface TefProviderInfo {
  id: string;
  name: string;
  requiresSdk: boolean;
  available: boolean;
  active: boolean;
  reason?: string;
}

export interface TefConfig {
  provider: string;
  timeout: number;
  autoReconnect: boolean;
  log: boolean;
  mode: "homologacao" | "producao";
  simulateStepMs?: number;
  simulateDenied?: boolean;
}

const AGENT_URLS = ["http://127.0.0.1:9100", "http://localhost:9100"] as const;
const ENABLED_KEY = "bastion.tef.enabled";

let activeUrl: string = AGENT_URLS[0];

export function isTefEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ENABLED_KEY) === "1";
}

export function setTefEnabled(v: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ENABLED_KEY, v ? "1" : "0");
}

async function call<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const bases = [activeUrl, ...AGENT_URLS.filter((u) => u !== activeUrl)];
  let lastError: unknown = null;
  for (const base of bases) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
      activeUrl = base;
      const json = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok && res.status !== 402) throw new Error(json.error || `HTTP ${res.status}`);
      return json;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    /failed to fetch|load failed|abort/i.test(msg)
      ? "Agente Local não respondeu. Instale/atualize o Bastion POS Agent (v1.5.0+) no PC do caixa."
      : msg,
  );
}

export function listTefProviders() {
  return call<{ ok: boolean; providers: TefProviderInfo[]; config: TefConfig }>("/tef/providers", { cache: "no-store" });
}

export function getTefConfig() {
  return call<{ ok: boolean; config: TefConfig }>("/tef/config", { cache: "no-store" });
}

export function saveTefConfig(patch: Partial<TefConfig>) {
  return call<{ ok: boolean; config: TefConfig }>("/tef/config", { method: "POST", body: JSON.stringify(patch) });
}

export function getTefStatus() {
  return call<{ ok: boolean; provider: string; state: TefState; mode: string; error?: string }>("/tef/status", { cache: "no-store" });
}

export interface TefSaleRequest {
  amount: number;
  paymentType: TefPaymentType;
  installments?: number;
  orderId: string;
  operator?: string | null;
  terminal?: string | null;
}

export function startTefSale(req: TefSaleRequest, timeoutMs = 180000) {
  return call<TefResult & { ok: boolean; error?: string }>("/tef/sale", { method: "POST", body: JSON.stringify(req) }, timeoutMs);
}

export function cancelTefSale(nsu?: string | null) {
  return call<{ ok: boolean } & Partial<TefResult>>("/tef/cancel", { method: "POST", body: JSON.stringify({ nsu, reason: "operator" }) });
}

export function reprintTefReceipt() {
  return call<{ ok: boolean; receiptCustomer?: string; receiptMerchant?: string; error?: string }>("/tef/reprint", { method: "POST", body: "{}" });
}

/**
 * Assina o stream de eventos do agente. Retorna função de cancelamento.
 * Reconecta sozinho quando o agente reinicia (EventSource já faz retry).
 */
export function subscribeTefEvents(onEvent: (ev: TefEvent) => void): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return () => {};
  const source = new EventSource(`${activeUrl}/tef/events`);
  source.onmessage = (msg) => {
    try { onEvent(JSON.parse(msg.data) as TefEvent); }
    catch { /* evento malformado é ignorado */ }
  };
  source.onerror = () => { /* EventSource reconecta automaticamente */ };
  return () => source.close();
}

export const TEF_STATE_LABEL: Record<TefState, string> = {
  idle: "Pronto",
  waiting_card: "Aguardando cartão…",
  insert_card: "Insira o cartão",
  tap_card: "Aproxime o cartão",
  remove_card: "Retire o cartão",
  pin_required: "Digite a senha",
  processing: "Processando…",
  approved: "Aprovado",
  denied: "Recusado",
  cancelled: "Cancelado",
  timeout: "Tempo esgotado",
  error: "Erro",
  receipt_ready: "Comprovante pronto",
};
