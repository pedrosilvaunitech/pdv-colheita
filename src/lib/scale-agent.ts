/**
 * Cliente da balança serial exposta pelo Agente Local (127.0.0.1:9100).
 *
 * O navegador só fala com balança serial via Web Serial (Chromium desktop,
 * com prompt de porta). No caixa isso quebra facilmente. Quando o Agente
 * Local está instalado, ele abre a porta COM diretamente e o PDV apenas
 * consome HTTP local — funciona em qualquer navegador e no PWA.
 */

export type AgentScaleProtocol = "prix3" | "prix4-p0" | "prix4-p1" | "generic";

export interface AgentScaleConfig {
  enabled: boolean;
  path: string;
  protocol: AgentScaleProtocol;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: "none" | "even" | "odd";
  requestTimeoutMs: number;
  autoConnect: boolean;
}

export interface AgentSerialPort {
  path: string;
  manufacturer: string | null;
  serialNumber: string | null;
  vendorId: string | null;
  productId: string | null;
  friendly: string;
}

export interface AgentScalePreset {
  id: string;
  label: string;
  protocol: AgentScaleProtocol;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: "none" | "even" | "odd";
}

export interface AgentScaleReading {
  weightKg: number;
  status: "ok" | "unstable" | "overload" | "zero" | "unknown";
  raw: string;
  at: number;
}

export interface AgentScaleStatus {
  ok: boolean;
  available: boolean;
  reason: string | null;
  connected: boolean;
  config: AgentScaleConfig;
  lastReading: AgentScaleReading | null;
  lastError: string | null;
}

const BASES = ["http://127.0.0.1:9100", "http://localhost:9100"] as const;
let activeBase: string = BASES[0];

async function call<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const bases = [activeBase, ...BASES.filter((b) => b !== activeBase)];
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
      activeBase = base;
      const json = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
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
      ? "Agente Local não respondeu. Instale/atualize o Bastion POS Agent (v1.6.0+) no PC do caixa."
      : msg,
  );
}

export function listScalePorts() {
  return call<{
    ok: boolean;
    available: boolean;
    reason: string | null;
    ports: AgentSerialPort[];
    presets: AgentScalePreset[];
    config: AgentScaleConfig;
  }>("/scale/ports", { cache: "no-store" });
}

export function getScaleStatus() {
  return call<AgentScaleStatus>("/scale/status", { cache: "no-store" });
}

export function saveScaleConfig(patch: Partial<AgentScaleConfig>) {
  return call<{ ok: boolean; config: AgentScaleConfig }>("/scale/config", {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export function connectScale(patch?: Partial<AgentScaleConfig>) {
  return call<{ ok: boolean; path: string; protocol: string; baudRate: number }>("/scale/connect", {
    method: "POST",
    body: JSON.stringify(patch ?? {}),
  });
}

export function disconnectScale() {
  return call<{ ok: boolean }>("/scale/disconnect", { method: "POST", body: "{}" });
}

export function readScaleWeight(timeoutMs = 4000) {
  return call<{ ok: boolean } & AgentScaleReading>(
    `/scale/read?timeout=${Math.max(500, timeoutMs)}`,
    { cache: "no-store" },
    timeoutMs + 2000,
  );
}

export function testScale(patch?: Partial<AgentScaleConfig>) {
  return call<{ ok: boolean; elapsedMs: number; reading?: AgentScaleReading; error?: string }>(
    "/scale/test",
    { method: "POST", body: JSON.stringify(patch ?? {}) },
    12000,
  );
}

export interface AgentScaleCandidate {
  path: string;
  friendly: string;
  manufacturer: string | null;
  protocol: AgentScaleProtocol;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: "none" | "even" | "odd";
  reading: AgentScaleReading;
  score: number;
}

export interface AgentScaleAutodetectResult {
  ok: boolean;
  available: boolean;
  applied?: boolean;
  scannedPorts?: number;
  candidates: AgentScaleCandidate[];
  attempts: Array<{ path: string; label: string; ok: boolean; error?: string; weightKg?: number }>;
  config?: AgentScaleConfig;
  error: string | null;
}

/**
 * Varredura automática: o agente testa cada porta COM com as combinações de
 * protocolo/baud mais comuns. Pode levar dezenas de segundos em máquinas com
 * muitas portas virtuais, por isso o timeout é generoso (3 min).
 */
export function autodetectScale(opts?: { apply?: boolean; timeoutMs?: number; ports?: string[] }) {
  return call<AgentScaleAutodetectResult>(
    "/scale/autodetect",
    { method: "POST", body: JSON.stringify(opts ?? {}) },
    180000,
  );
}



/** true se o agente estiver instalado, com driver serial e porta aberta. */
export async function isAgentScaleReady(): Promise<boolean> {
  try {
    const st = await getScaleStatus();
    return !!st.available && !!st.connected;
  } catch {
    return false;
  }
}
