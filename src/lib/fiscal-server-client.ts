/**
 * Conexão com o motor fiscal Node rodando na loja (no caixa ou num PC servidor).
 *
 * Por que este arquivo existe — o diagnóstico do problema "o servidor Node não
 * é reconhecido":
 *
 *  1. O teste de conexão saía do BACKEND publicado (server function). Esse
 *     backend roda na nuvem e não enxerga `localhost` nem `192.168.x.x` da loja.
 *     Qualquer endereço da rede interna dava "não respondeu" mesmo com o Node
 *     rodando perfeitamente ao lado.
 *  2. Chamar direto do navegador também falha para IP da rede: a página é HTTPS
 *     e `http://192.168.0.50:3737` é conteúdo misto — o Chrome bloqueia antes de
 *     sair o pacote.
 *
 * Solução, em ordem de tentativa:
 *
 *  - **Agente Local** (preferido em rede interna): o navegador fala com
 *    `http://127.0.0.1:9100` — permitido, pois loopback é tratado como origem
 *    confiável — e o AGENTE fala com o motor fiscal em qualquer IP da rede. O
 *    token fica salvo no PC, nunca na página.
 *  - **Direto** (quando o motor roda no mesmo PC em `localhost`, ou quando o
 *    servidor tem domínio HTTPS): `fetch` direto do navegador.
 *  - **Nuvem** (só endereços públicos): continua valendo o teste pelo backend,
 *    feito pela tela que já usa `pingFiscalServer`.
 *
 * Nada aqui lança por falha de rede: toda tentativa devolve um resultado
 * descritivo, porque no caixa a pergunta é sempre "e agora, o que eu faço?".
 */

const AGENT_BASES = ["http://127.0.0.1:9100", "http://localhost:9100"] as const;

export type AddressKind = "loopback" | "private" | "public" | "invalid";

export interface AddressInfo {
  kind: AddressKind;
  /** URL normalizada (protocolo + porta padrão 3737 quando ausente). */
  url: string | null;
  host: string;
  secure: boolean;
  /** Explicação do que esse tipo de endereço implica. */
  note: string;
}

/** Aceita "192.168.0.50", "192.168.0.50:3737", "http://host", "https://dominio". */
export function normalizeFiscalUrl(input: string): string | null {
  let value = (input || "").trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const u = new URL(value);
    if (!u.port && u.protocol === "http:") u.port = "3737";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const PRIVATE_RE =
  /^(10\.|127\.|0\.0\.0\.0$|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|.*\.local$)/i;

export function classifyAddress(input: string): AddressInfo {
  const url = normalizeFiscalUrl(input);
  if (!url) {
    return { kind: "invalid", url: null, host: "", secure: false, note: "Endereço não reconhecido." };
  }
  const u = new URL(url);
  const host = u.hostname;
  const secure = u.protocol === "https:";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return {
      kind: "loopback",
      url,
      host,
      secure,
      note: "Motor no mesmo computador do caixa — o navegador acessa direto.",
    };
  }
  if (PRIVATE_RE.test(host)) {
    return {
      kind: "private",
      url,
      host,
      secure,
      note: "Endereço da rede interna — o teste passa pelo Agente Local, não pela nuvem.",
    };
  }
  return {
    kind: "public",
    url,
    host,
    secure,
    note: secure
      ? "Domínio público com HTTPS — funciona pelo navegador e pela nuvem."
      : "Domínio público sem HTTPS: o navegador bloqueia. Use o Agente Local ou coloque HTTPS.",
  };
}

// ── configuração guardada no agente (PC do caixa) ────────────────────────────

export interface AgentFiscalServer {
  agentOnline: boolean;
  url: string | null;
  tokenSet: boolean;
  updatedAt: string | null;
  agentVersion?: string;
  error?: string;
}

async function agentFetch(path: string, init: RequestInit = {}, timeoutMs = 12000): Promise<Response> {
  let lastError: unknown = null;
  for (const base of AGENT_BASES) {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(`${base}${path}`, { cache: "no-store", ...init, signal: ctrl.signal });
    } catch (e) {
      lastError = e;
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw new Error(
    lastError instanceof Error && !/failed to fetch|load failed|abort/i.test(lastError.message)
      ? lastError.message
      : "Agente Local não respondeu em 127.0.0.1:9100. Abra o Bastion POS Agent neste computador.",
  );
}

/** Lê o endereço do motor fiscal salvo NESTE PC. Nunca lança. */
export async function getAgentFiscalServer(): Promise<AgentFiscalServer> {
  try {
    const res = await agentFetch("/fiscal/server", {}, 8000);
    if (res.status === 404) {
      return {
        agentOnline: true,
        url: null,
        tokenSet: false,
        updatedAt: null,
        error: "Agente antigo: atualize para a versão 1.9.0 ou superior para usar o motor fiscal na rede.",
      };
    }
    const json = (await res.json().catch(() => ({}))) as {
      url?: string | null;
      token_set?: boolean;
      updated_at?: string | null;
      version?: string;
    };
    return {
      agentOnline: true,
      url: json.url ?? null,
      tokenSet: !!json.token_set,
      updatedAt: json.updated_at ?? null,
      agentVersion: json.version,
    };
  } catch (e) {
    return {
      agentOnline: false,
      url: null,
      tokenSet: false,
      updatedAt: null,
      error: e instanceof Error ? e.message : "Agente Local indisponível.",
    };
  }
}

/**
 * Salva endereço e token do motor fiscal no PC do caixa.
 * `token: undefined` mantém o token atual; `""` apaga.
 */
export async function saveAgentFiscalServer(url: string | null, token?: string): Promise<AgentFiscalServer> {
  const res = await agentFetch("/fiscal/server", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, ...(token === undefined ? {} : { token }) }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    url?: string | null;
    token_set?: boolean;
    updated_at?: string | null;
    error?: string;
  };
  if (!res.ok || json.ok === false) throw new Error(json.error || "Não foi possível salvar no Agente Local.");
  return {
    agentOnline: true,
    url: json.url ?? null,
    tokenSet: !!json.token_set,
    updatedAt: json.updated_at ?? null,
  };
}

// ── chamadas ao motor fiscal ─────────────────────────────────────────────────

export type FiscalTransport = "direct" | "agent";

export interface FiscalCallResult<T = unknown> {
  ok: boolean;
  /** Como a chamada chegou ao motor. */
  transport: FiscalTransport | null;
  status: number;
  elapsedMs: number;
  data: T | null;
  error?: string;
}

export interface FiscalCallOptions {
  /** Endereço a usar; quando omitido, usa o salvo no agente. */
  url?: string | null;
  /** Token; quando omitido, o agente usa o que está salvo no PC. */
  token?: string;
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
}

async function callDirect<T>(
  base: string,
  path: string,
  options: FiscalCallOptions,
): Promise<FiscalCallResult<T>> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timeout = options.timeoutMs ?? 20000;
  const timer = window.setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return {
      ok: res.ok,
      transport: "direct",
      status: res.status,
      elapsedMs: Date.now() - started,
      data,
      error: res.ok ? undefined : describeHttp(res.status),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      transport: "direct",
      status: 0,
      elapsedMs: Date.now() - started,
      data: null,
      error: /abort/i.test(msg)
        ? `O servidor em ${base} não respondeu em ${Math.round(timeout / 1000)}s.`
        : `O navegador não conseguiu falar com ${base} (bloqueio de conteúdo misto ou servidor parado).`,
    };
  } finally {
    window.clearTimeout(timer);
  }
}

async function callViaAgent<T>(path: string, options: FiscalCallOptions): Promise<FiscalCallResult<T>> {
  const started = Date.now();
  try {
    const res = await agentFetch(
      "/fiscal/proxy",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          method: options.method ?? "GET",
          body: options.body,
          url: options.url ?? undefined,
          token: options.token,
          timeoutMs: options.timeoutMs ?? 20000,
        }),
      },
      (options.timeoutMs ?? 20000) + 5000,
    );
    if (res.status === 404) {
      return {
        ok: false,
        transport: "agent",
        status: 404,
        elapsedMs: Date.now() - started,
        data: null,
        error: "Agente sem a ponte fiscal. Atualize o Bastion POS Agent para a versão 1.9.0 ou superior.",
      };
    }
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      status?: number;
      data?: T | null;
      error?: string;
      elapsed_ms?: number;
    };
    return {
      ok: !!json.ok,
      transport: "agent",
      status: json.status ?? 0,
      elapsedMs: json.elapsed_ms ?? Date.now() - started,
      data: json.data ?? null,
      error: json.ok ? undefined : (json.error ?? describeHttp(json.status ?? 0)),
    };
  } catch (e) {
    return {
      ok: false,
      transport: "agent",
      status: 0,
      elapsedMs: Date.now() - started,
      data: null,
      error: e instanceof Error ? e.message : "Agente Local indisponível.",
    };
  }
}

function describeHttp(status: number): string {
  if (status === 401) return "Token recusado pelo servidor fiscal. Confira o token nas duas pontas.";
  if (status === 404) return "Rota não encontrada — o endereço aponta para outro serviço, não para o motor fiscal.";
  if (status === 501) return "O servidor respondeu, mas o motor de emissão não está instalado (falta node-dfe).";
  if (status >= 500) return "O servidor fiscal respondeu com erro interno. Veja o console dele.";
  if (status === 0) return "Sem resposta do servidor fiscal.";
  return `O servidor respondeu HTTP ${status}.`;
}

/**
 * Chama o motor fiscal escolhendo sozinho o melhor caminho.
 *
 * Ordem: direto quando o endereço é alcançável pelo navegador (loopback ou
 * HTTPS público); caso contrário Agente Local. Se o preferido falhar, tenta o
 * outro antes de desistir — servidor no caixa costuma ter as duas rotas.
 */
export async function callFiscalServer<T = unknown>(
  path: string,
  options: FiscalCallOptions = {},
): Promise<FiscalCallResult<T>> {
  const raw = options.url ?? (await getAgentFiscalServer()).url;
  const info = raw ? classifyAddress(raw) : null;

  if (!info?.url) {
    // Sem endereço local: só o agente pode saber (ele guarda a configuração).
    return callViaAgent<T>(path, options);
  }

  const pageSecure = typeof window !== "undefined" && window.location.protocol === "https:";
  const directViable = info.kind === "loopback" || (info.kind === "public" && (info.secure || !pageSecure));

  const first = directViable
    ? await callDirect<T>(info.url, path, options)
    : await callViaAgent<T>(path, { ...options, url: info.url });
  if (first.ok) return first;

  const second = directViable
    ? await callViaAgent<T>(path, { ...options, url: info.url })
    : await callDirect<T>(info.url, path, options);
  if (second.ok) return second;

  // Devolve a falha mais informativa: quem chegou a receber HTTP do servidor.
  return second.status > 0 ? second : first;
}

// ── diagnóstico apresentável ─────────────────────────────────────────────────

export interface FiscalHealth {
  ok: boolean;
  version?: string;
  engine_ready?: boolean;
  environment?: string;
  node?: string;
  uptime_s?: number;
}

export type DiagStatus = "ok" | "aviso" | "falha";

export interface DiagCheck {
  key: string;
  label: string;
  status: DiagStatus;
  detail: string;
  fix?: string;
}

export interface FiscalDiagnosis {
  ok: boolean;
  transport: FiscalTransport | null;
  summary: string;
  checks: DiagCheck[];
  health: FiscalHealth | null;
  ranAt: string;
}

/**
 * Roda o diagnóstico ponta a ponta de um endereço.
 *
 * Sequência proposital: endereço → agente (quando necessário) → `/health`
 * (público, distingue "não achei" de "token errado") → `/nfce/validate`
 * (autenticado, mostra certificado, CSC e SEFAZ).
 */
export async function diagnoseFiscalServer(
  input: string,
  token?: string,
): Promise<FiscalDiagnosis> {
  const checks: DiagCheck[] = [];
  const info = classifyAddress(input);

  checks.push({
    key: "address",
    label: "Endereço informado",
    status: info.kind === "invalid" ? "falha" : "ok",
    detail: info.url ? `${info.url} · ${info.note}` : "Não foi possível interpretar o endereço.",
    fix: info.kind === "invalid" ? "Use o formato 192.168.0.50:3737 ou https://fiscal.minhaloja.com." : undefined,
  });

  if (!info.url) {
    return {
      ok: false,
      transport: null,
      summary: "Endereço inválido — corrija antes de testar.",
      checks,
      health: null,
      ranAt: new Date().toLocaleString("pt-BR"),
    };
  }

  const needsAgent =
    info.kind === "private" ||
    (info.kind === "public" && !info.secure && typeof window !== "undefined" && window.location.protocol === "https:");

  if (needsAgent) {
    const agent = await getAgentFiscalServer();
    checks.push({
      key: "agent",
      label: "Ponte pelo Agente Local",
      status: agent.agentOnline ? "ok" : "falha",
      detail: agent.agentOnline
        ? `Agente respondeu${agent.agentVersion ? ` (v${agent.agentVersion})` : ""} e fará a ponte até o motor fiscal.`
        : (agent.error ?? "Agente não respondeu."),
      fix: agent.agentOnline
        ? undefined
        : "Abra o Bastion POS Agent neste computador — ele é quem alcança endereços da rede interna.",
    });
  }

  const health = await callFiscalServer<FiscalHealth>("/health", { url: info.url, token, timeoutMs: 12000 });
  checks.push({
    key: "health",
    label: "Servidor fiscal respondendo",
    status: health.ok ? "ok" : "falha",
    detail: health.ok
      ? `v${health.data?.version ?? "?"} em ${health.elapsedMs}ms via ${health.transport === "agent" ? "Agente Local" : "navegador"}.`
      : (health.error ?? "Sem resposta."),
    fix: health.ok
      ? undefined
      : "Na pasta vps-fiscal rode `npm install` e `node server.js`, e libere a porta 3737 no Firewall do Windows.",
  });

  if (!health.ok) {
    return {
      ok: false,
      transport: health.transport,
      summary: "O motor fiscal não respondeu neste endereço.",
      checks,
      health: null,
      ranAt: new Date().toLocaleString("pt-BR"),
    };
  }

  const engineReady = health.data?.engine_ready === true;
  checks.push({
    key: "engine",
    label: "Motor de emissão (node-dfe)",
    status: engineReady ? "ok" : "falha",
    detail: engineReady ? "Biblioteca carregada — pronto para transmitir." : "Servidor de pé, mas sem a biblioteca de emissão.",
    fix: engineReady ? undefined : "Rode `npm install` na pasta do servidor fiscal e reinicie o processo.",
  });

  const env = health.data?.environment;
  if (env) {
    checks.push({
      key: "environment",
      label: "Ambiente fiscal",
      status: env === "producao" ? "ok" : "aviso",
      detail: env === "producao" ? "Produção — notas com valor fiscal." : "Homologação — notas sem valor fiscal.",
      fix: env === "producao" ? undefined : "Defina FISCAL_ENVIRONMENT=producao no servidor quando for emitir de verdade.",
    });
  }

  // Rota autenticada: confirma o token e traz certificado/CSC/SEFAZ.
  const validate = await callFiscalServer<{
    ok?: boolean;
    summary?: string;
    checks?: Array<{ key: string; label: string; status: string; detail?: string; fix?: string | null }>;
  }>("/nfce/validate", { url: info.url, token, timeoutMs: 30000 });

  if (validate.status === 401) {
    checks.push({
      key: "token",
      label: "Token de acesso",
      status: "falha",
      detail: "O servidor recusou o token.",
      fix: "Copie o token que o servidor imprime no console ao iniciar e cole aqui.",
    });
  } else if (!validate.ok && validate.status === 0) {
    checks.push({
      key: "token",
      label: "Validação completa",
      status: "aviso",
      detail: validate.error ?? "Não foi possível rodar a validação autenticada.",
      fix: "Tente novamente; o servidor pode estar ocupado consultando a SEFAZ.",
    });
  } else {
    checks.push({
      key: "token",
      label: "Token de acesso",
      status: "ok",
      detail: "Aceito pelo servidor fiscal.",
    });
    for (const c of validate.data?.checks ?? []) {
      checks.push({
        key: `remote_${c.key}`,
        label: c.label,
        status: c.status === "ok" ? "ok" : c.status === "warn" ? "aviso" : "falha",
        detail: c.detail ?? "",
        fix: c.fix ?? undefined,
      });
    }
  }

  const failures = checks.filter((c) => c.status === "falha").length;
  const warnings = checks.filter((c) => c.status === "aviso").length;

  return {
    ok: failures === 0,
    transport: health.transport,
    summary:
      failures === 0
        ? warnings > 0
          ? `Servidor pronto, com ${warnings} ponto(s) de atenção.`
          : "Servidor fiscal pronto para emitir."
        : `${failures} problema(s) impedindo a emissão.`,
    checks,
    health: health.data,
    ranAt: new Date().toLocaleString("pt-BR"),
  };
}
