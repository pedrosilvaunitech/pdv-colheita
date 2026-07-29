/**
 * Cliente do motor fiscal embarcado no Agente Local (Bastion POS Agent v1.4+).
 *
 * O agente expõe em 127.0.0.1:9100:
 *   GET  /nfce/config       → { ok, engine_ready, config }
 *   POST /nfce/config       → grava fiscal.json local (CNPJ, CSC, UF, ambiente)
 *   GET  /nfce/certificate  → metadados do A1 instalado
 *   GET  /nfce/status       → consulta status do serviço na SEFAZ
 *
 * Toda a comunicação é local: certificado e senha nunca saem da máquina.
 */

const BASES = ["http://127.0.0.1:9100", "http://localhost:9100"] as const;

export interface NfceEngineStatus {
  /** Agente respondeu em alguma das bases locais. */
  agentOnline: boolean;
  /** Motor NFC-e carregado (node-dfe presente). */
  engineReady: boolean;
  /** Config fiscal local já gravada no agente (mascarada). */
  config: Record<string, unknown> | null;
  error?: string;
}

export interface AgentFiscalConfigInput {
  cnpj: string;
  uf: string;
  environment: "homologacao" | "producao";
  csc_id?: string | null;
  csc_token?: string | null;
  serie?: number | null;
  proximo_numero?: number | null;
  crt?: string | null;
  ie?: string | null;
  razao_social?: string | null;
  municipio_ibge?: string | null;
}

async function agentFetch(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  let lastError: unknown = null;
  for (const base of BASES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(`${base}${path}`, { cache: "no-store", ...init, signal: ctrl.signal });
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  if (/failed to fetch|load failed|abort|networkerror/i.test(msg)) {
    throw new Error(
      "Agente Local não respondeu em 127.0.0.1:9100. Abra o Bastion POS Agent (ícone na bandeja) e tente de novo.",
    );
  }
  throw new Error(msg);
}

/** Status do motor fiscal local — nunca lança, sempre devolve um estado. */
export async function getNfceEngineStatus(): Promise<NfceEngineStatus> {
  try {
    const res = await agentFetch("/nfce/config", {}, 8000);
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      engine_ready?: boolean;
      config?: Record<string, unknown> | null;
      error?: string;
    };
    if (res.status === 501) {
      return {
        agentOnline: true,
        engineReady: false,
        config: null,
        error:
          json.error ??
          "Motor NFC-e não carregado. Rode `npm install` na pasta do agente para instalar o node-dfe.",
      };
    }
    if (!res.ok) return { agentOnline: true, engineReady: false, config: null, error: json.error ?? `HTTP ${res.status}` };
    return {
      agentOnline: true,
      engineReady: Boolean(json.engine_ready),
      config: json.config ?? null,
      error: json.engine_ready
        ? undefined
        : (json.error ??
          "Motor NFC-e não carregado. Rode `npm run install:fiscal` na pasta do agente e reinicie."),
    };
  } catch (e) {
    return { agentOnline: false, engineReady: false, config: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Envia a configuração fiscal da loja para o agente (fiscal.json local). */
export async function syncFiscalConfigToAgent(input: AgentFiscalConfigInput): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await agentFetch("/nfce/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Metadados do certificado A1 instalado na máquina do caixa. */
export async function getAgentCertificate(): Promise<{ ok: boolean; cn?: string; expiresOn?: string; error?: string }> {
  try {
    const res = await agentFetch("/nfce/certificate", {}, 10000);
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      cn?: string;
      subject?: string;
      validTo?: string;
      expires_on?: string;
      error?: string;
    };
    if (!res.ok || json.ok === false) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    return { ok: true, cn: json.cn ?? json.subject, expiresOn: json.validTo ?? json.expires_on };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Consulta status do serviço na SEFAZ pelo agente (equivale ao "testar conexão"). */
export async function testSefazViaAgent(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await agentFetch("/nfce/status", {}, 20000);
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      cStat?: string;
      xMotivo?: string;
      motivo?: string;
      error?: string;
    };
    if (res.status === 501) {
      return {
        ok: false,
        message:
          json.error ??
          "Motor NFC-e não carregado no agente. Rode `npm install` na pasta desktop e reinicie o Bastion POS Agent.",
      };
    }
    if (!res.ok || json.ok === false) {
      return { ok: false, message: json.error ?? json.xMotivo ?? `SEFAZ respondeu HTTP ${res.status}.` };
    }
    const motivo = json.xMotivo ?? json.motivo ?? "Serviço em operação";
    return { ok: true, message: `SEFAZ respondeu: ${motivo}${json.cStat ? ` (cStat ${json.cStat})` : ""}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────
// Validação profunda do motor fiscal + instalação assistida
// ─────────────────────────────────────────────────────────────

export interface EngineCheck {
  key: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix: string | null;
}

export interface EngineValidation {
  ok: boolean;
  ready: boolean;
  summary: string;
  engine_error?: string | null;
  versions?: Record<string, string | null>;
  checks: EngineCheck[];
}

/** Bateria de checagens do node-dfe no PC do caixa. Nunca lança. */
export async function validateNfceEngine(): Promise<EngineValidation> {
  try {
    const res = await agentFetch("/nfce/engine", {}, 15000);
    const json = (await res.json().catch(() => ({}))) as Partial<EngineValidation> & { error?: string };
    if (!res.ok || !json.checks) {
      return {
        ok: false,
        ready: false,
        summary: json.error ?? `Agente respondeu HTTP ${res.status}.`,
        checks: [
          {
            key: "agent",
            label: "Agente Local",
            status: "fail",
            detail: json.error ?? `HTTP ${res.status}`,
            fix: "Atualize o Bastion POS Agent para a versão 1.8.1 ou superior.",
          },
        ],
      };
    }
    return json as EngineValidation;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      ready: false,
      summary: msg,
      checks: [
        {
          key: "agent",
          label: "Agente Local",
          status: "fail",
          detail: msg,
          fix: "Abra o Bastion POS Agent na bandeja do Windows e tente novamente.",
        },
      ],
    };
  }
}

export interface EngineInstallState {
  running: boolean;
  ok: boolean | null;
  error: string | null;
  log: string[];
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** Dispara `npm run install:fiscal` no caixa (roda em background no agente). */
export async function startNfceEngineInstall(): Promise<{ ok: boolean; error?: string; state?: EngineInstallState }> {
  try {
    const res = await agentFetch("/nfce/engine/install", { method: "POST" }, 20000);
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; state?: EngineInstallState };
    if (!res.ok || json.ok === false) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    return { ok: true, state: json.state };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Progresso da instalação (polling). */
export async function getNfceEngineInstallState(): Promise<EngineInstallState | null> {
  try {
    const res = await agentFetch("/nfce/engine/install", {}, 10000);
    const json = (await res.json().catch(() => ({}))) as { state?: EngineInstallState };
    return json.state ?? null;
  } catch {
    return null;
  }
}
