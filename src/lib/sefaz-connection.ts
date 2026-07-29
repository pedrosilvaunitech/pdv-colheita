/**
 * Controle de conexões com a SEFAZ / motores fiscais.
 *
 * Motivação: cada emissão abria conexões novas — ping no agente (`/status`,
 * duas URLs), depois `/nfce/emit`, e nada impedia que a mesma venda fosse
 * despachada duas vezes (fila + botão manual + rodada de background). Isso
 * castiga o motor local e, principalmente, a SEFAZ, que trata excesso de
 * conexões simultâneas como abuso (cStat 656 "consumo indevido").
 *
 * Três mecanismos, todos em memória do caixa (por aba):
 *
 *  1. `resolveAgentBaseUrl` — descoberta do agente com cache TTL, evitando
 *     3 requisições de sonda por nota emitida;
 *  2. `withSefazSlot` — semáforo global: no máximo N transmissões em voo,
 *     independentemente de quantos lugares do app chamem a emissão;
 *  3. `singleFlight` — deduplicação por venda: chamadas concorrentes para a
 *     MESMA venda compartilham a mesma promessa em vez de abrir duas conexões
 *     (e potencialmente consumir dois números de NFC-e).
 */

/** Transmissões simultâneas permitidas por caixa. */
export const MAX_SEFAZ_CONNECTIONS = 3;

/** Quanto tempo a URL do agente é considerada válida sem nova sonda. */
const AGENT_URL_TTL_MS = 60_000;

const AGENT_BASE_URLS = ["http://127.0.0.1:9100", "http://localhost:9100"];

interface AgentUrlCache {
  url: string | null;
  at: number;
}

let agentCache: AgentUrlCache = { url: null, at: 0 };
let agentProbe: Promise<string | null> | null = null;

/** Invalida o cache — chamar quando uma requisição ao agente falhar por rede. */
export function invalidateAgentUrlCache(): void {
  agentCache = { url: null, at: 0 };
}

/**
 * Devolve a base do agente local, reaproveitando a descoberta anterior.
 * Sondas concorrentes compartilham a mesma promessa (single-flight interno).
 */
export async function resolveAgentBaseUrl(timeoutMs = 2000): Promise<string | null> {
  const fresh = Date.now() - agentCache.at < AGENT_URL_TTL_MS;
  if (fresh && agentCache.url) return agentCache.url;
  if (agentProbe) return agentProbe;

  agentProbe = (async () => {
    // Tenta primeiro a última URL que funcionou.
    const candidates = agentCache.url
      ? [agentCache.url, ...AGENT_BASE_URLS.filter((u) => u !== agentCache.url)]
      : AGENT_BASE_URLS;

    for (const base of candidates) {
      try {
        const r = await fetch(`${base}/status`, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) {
          agentCache = { url: base, at: Date.now() };
          return base;
        }
      } catch {
        /* tenta o próximo host */
      }
    }
    agentCache = { url: null, at: Date.now() };
    return null;
  })().finally(() => {
    agentProbe = null;
  });

  return agentProbe;
}

// ─────────────────────────────────────────────────────────────
// Semáforo de transmissões
// ─────────────────────────────────────────────────────────────

let inFlight = 0;
const waiters: Array<() => void> = [];

/** Quantas transmissões estão abertas agora (telemetria do painel). */
export function currentSefazConnections(): number {
  return inFlight;
}

/** Quantas chamadas estão esperando um slot livre. */
export function queuedSefazConnections(): number {
  return waiters.length;
}

async function acquire(limit: number): Promise<void> {
  if (inFlight < limit) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight += 1;
}

function release(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

/**
 * Executa `fn` ocupando um slot de conexão. Sempre libera o slot, mesmo em
 * erro — um throw não pode vazar capacidade do caixa.
 */
export async function withSefazSlot<T>(fn: () => Promise<T>, limit = MAX_SEFAZ_CONNECTIONS): Promise<T> {
  await acquire(Math.max(1, limit));
  try {
    return await fn();
  } finally {
    release();
  }
}

// ─────────────────────────────────────────────────────────────
// Deduplicação por chave (venda)
// ─────────────────────────────────────────────────────────────

const flights = new Map<string, Promise<unknown>>();

/**
 * Garante uma única execução em voo por `key`. Chamadas concorrentes recebem
 * a mesma promessa — nunca uma segunda transmissão da mesma venda.
 */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = flights.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const p = (async () => fn())().finally(() => {
    flights.delete(key);
  });
  flights.set(key, p);
  return p;
}

/** Há uma transmissão em voo para esta venda? */
export function isInFlight(key: string): boolean {
  return flights.has(key);
}
