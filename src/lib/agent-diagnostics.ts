/**
 * Cliente do endpoint de diagnóstico do Agente Local (v1.7.0+).
 *
 * O objetivo é dar ao operador do caixa — e ao suporte — uma visão única do
 * ambiente: versão do agente, módulos carregados, impressoras, portas seriais
 * e permissões do Windows. Sem isso, cada falha de hardware vira tentativa e
 * erro no telefone.
 */

import type { AgentScaleConfig, AgentSerialPort } from "./scale-agent";
import type { AgentPrinter } from "./print-agent";

export interface AgentSystemInfo {
  platform: string;
  arch: string;
  release: string;
  hostname: string;
  node: string;
  /** Processo rodando como administrador (Windows) / root (Unix). */
  elevated: boolean;
  uptime_s: number;
  dataDir: string;
  dataDirWritable: boolean;
}

export interface AgentModuleFlags {
  spooler: boolean;
  usb: boolean;
  scale: boolean;
  nfce: boolean;
  tef: boolean;
}

export interface AgentDiagnostics {
  ok: boolean;
  version: string;
  system: AgentSystemInfo;
  modules: AgentModuleFlags;
  printers: AgentPrinter[];
  scale: {
    loaded: boolean;
    driverInstalled?: boolean;
    reason?: string | null;
    connected?: boolean;
    config?: AgentScaleConfig;
    lastError?: string | null;
    ports?: AgentSerialPort[];
  };
  tef: { ok: boolean; error?: string; provider?: string; connected?: boolean };
  nfce: { available: boolean; config?: Record<string, unknown> };
}

const BASES = ["http://127.0.0.1:9100", "http://localhost:9100"] as const;

/**
 * Busca o diagnóstico tentando as duas bases locais. Erro de rede vira uma
 * mensagem acionável em vez de "Failed to fetch".
 */
export async function fetchAgentDiagnostics(timeoutMs = 12000): Promise<AgentDiagnostics> {
  let lastError: unknown = null;
  for (const base of BASES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/diagnostics`, { cache: "no-store", signal: ctrl.signal });
      const json = (await res.json().catch(() => ({}))) as AgentDiagnostics & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      return json;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  if (/failed to fetch|load failed|abort|networkerror/i.test(msg)) {
    throw new Error(
      "Agente Local não respondeu em 127.0.0.1:9100. Verifique se o Bastion POS Agent está aberto (ícone na bandeja) e atualizado para a v1.7.0.",
    );
  }
  if (/404/.test(msg)) {
    throw new Error("Agente encontrado, mas sem a rota /diagnostics. Atualize o Bastion POS Agent para a v1.7.0.");
  }
  throw new Error(msg);
}

/** Capacidades do navegador atual — checadas no cliente, não no agente. */
export interface BrowserCapabilities {
  secureContext: boolean;
  webusb: boolean;
  webserial: boolean;
  standalone: boolean;
  userAgent: string;
}

export function getBrowserCapabilities(): BrowserCapabilities {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return {
    secureContext: typeof window !== "undefined" ? window.isSecureContext : false,
    webusb: !!nav && "usb" in nav,
    webserial: !!nav && "serial" in nav,
    standalone:
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(display-mode: standalone)").matches,
    userAgent: nav?.userAgent ?? "",
  };
}
