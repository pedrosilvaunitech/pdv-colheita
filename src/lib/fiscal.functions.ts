import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Emissão real de NFC-e/NF-e + teste de conexão com o provedor.
 *
 * Provedores suportados e nome do segredo esperado:
 *   focus_nfe    -> FISCAL_FOCUS_NFE_TOKEN
 *   plugnotas    -> FISCAL_PLUGNOTAS_API_KEY
 *   nfe_io       -> FISCAL_NFE_IO_API_KEY
 *   webmania     -> FISCAL_WEBMANIA_API_KEY
 *   tecnospeed   -> FISCAL_TECNOSPEED_API_KEY
 *   direto_sefaz -> não suportado no runtime edge
 */

type Provider =
  | "focus_nfe"
  | "plugnotas"
  | "nfe_io"
  | "webmania"
  | "tecnospeed"
  | "direto_sefaz"
  | "none";

const SECRET_NAME: Record<Provider, string | null> = {
  focus_nfe: "FISCAL_FOCUS_NFE_TOKEN",
  plugnotas: "FISCAL_PLUGNOTAS_API_KEY",
  nfe_io: "FISCAL_NFE_IO_API_KEY",
  webmania: "FISCAL_WEBMANIA_API_KEY",
  tecnospeed: "FISCAL_TECNOSPEED_API_KEY",
  direto_sefaz: null,
  none: null,
};

const PROVIDER_LABEL: Record<Provider, string> = {
  focus_nfe: "Focus NFe",
  plugnotas: "PlugNotas",
  nfe_io: "NFe.io",
  webmania: "WebmaniaBR",
  tecnospeed: "TecnoSpeed",
  direto_sefaz: "Direto SEFAZ",
  none: "Nenhum",
};

// URLs de "health check" — endpoints públicos/autenticados leves para
// validar que a chave está correta.
function healthUrl(provider: Provider, env: "homologacao" | "producao", override?: string | null): string {
  if (override && override.trim()) return override.replace(/\/+$/, "");
  switch (provider) {
    case "focus_nfe":
      return env === "producao"
        ? "https://api.focusnfe.com.br/v2/empresas"
        : "https://homologacao.focusnfe.com.br/v2/empresas";
    case "plugnotas":
      return "https://api.plugnotas.com.br/empresa";
    case "nfe_io":
      return "https://api.nfe.io/v1/companies";
    case "webmania":
      return "https://webmaniabr.com/api/1/nfe/config/";
    case "tecnospeed":
      return "https://api.tecnospeed.com.br/plugnotas/empresa";
    default:
      return "";
  }
}

function authHeaders(provider: Provider, token: string): HeadersInit {
  switch (provider) {
    case "focus_nfe":
      // Basic auth: token como usuário, sem senha.
      return { Authorization: `Basic ${btoa(`${token}:`)}` };
    case "plugnotas":
    case "tecnospeed":
      return { "x-api-key": token };
    case "nfe_io":
      return { Authorization: token };
    case "webmania": {
      // Formato: consumer_key:consumer_secret:access_token:access_token_secret
      const parts = token.split(":");
      if (parts.length !== 4) return { "X-Consumer-Key": token };
      const [ck, cs, at, ats] = parts;
      return {
        "X-Consumer-Key": ck,
        "X-Consumer-Secret": cs,
        "X-Access-Token": at,
        "X-Access-Token-Secret": ats,
      };
    }
    default:
      return {};
  }
}

function friendlyStatus(status: number, provider: Provider): string {
  if (status === 401 || status === 403) {
    return `Credencial rejeitada pelo ${PROVIDER_LABEL[provider]} (HTTP ${status}). Verifique se o token cadastrado está correto e ativo.`;
  }
  if (status === 404) {
    return `Endpoint não encontrado no ${PROVIDER_LABEL[provider]} (HTTP 404). Confirme a URL da API em Configurações → Fiscal.`;
  }
  if (status === 429) {
    return `${PROVIDER_LABEL[provider]} recusou por excesso de requisições (HTTP 429). Aguarde alguns segundos e tente de novo.`;
  }
  if (status >= 500) {
    return `${PROVIDER_LABEL[provider]} está fora do ar (HTTP ${status}). Tente novamente em alguns minutos.`;
  }
  return `Resposta inesperada do ${PROVIDER_LABEL[provider]} (HTTP ${status}).`;
}

// ─────────────────────────────────────────────────────────────
// Teste de conexão com o provedor fiscal
// ─────────────────────────────────────────────────────────────

const testSchema = z.object({ storeId: z.string().uuid() });

export const testFiscalConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => testSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: managerRole } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", context.userId)
      .eq("store_id", data.storeId)
      .in("role", ["admin_dev", "admin", "gerente"])
      .maybeSingle();
    if (!managerRole) {
      return {
        ok: false,
        message: "Você precisa ser admin ou gerente da loja para testar a conexão fiscal.",
      };
    }

    const { data: config, error: cfgErr } = await supabase
      .from("fiscal_configs")
      .select("provider, environment, defer_credentials, provider_api_url, certificate_uploaded")
      .eq("store_id", data.storeId)
      .maybeSingle();
    if (cfgErr) return { ok: false, message: cfgErr.message };
    if (!config) {
      return { ok: false, message: "Salve a configuração fiscal antes de testar a conexão." };
    }

    const provider = (config.provider ?? "none") as Provider;
    if (provider === "none") {
      return { ok: false, message: "Escolha um provedor de emissão antes de testar." };
    }
    if (provider === "direto_sefaz") {
      // O teste real roda no Agente Local (GET /nfce/status). A nuvem só confirma a config.
      return {
        ok: true,
        message:
          "Motor 'Direto SEFAZ' configurado. O teste de comunicação com a SEFAZ é feito pelo Agente Local do caixa.",
      };
    }

    const secretName = SECRET_NAME[provider]!;
    const token = process.env[secretName];
    if (!token) {
      return {
        ok: false,
        message: `Credencial ${secretName} não configurada. Em Configurações → Fiscal, clique em "Salvar credencial" e cole a chave do ${PROVIDER_LABEL[provider]}.`,
      };
    }
    if (config.defer_credentials) {
      return {
        ok: false,
        message:
          'A opção "Configurar credencial depois" ainda está ligada. Desmarque para habilitar o uso da credencial salva.',
      };
    }

    const url = healthUrl(provider, config.environment as "homologacao" | "producao", config.provider_api_url);
    if (!url) {
      return { ok: false, message: `Sem URL de health check para ${PROVIDER_LABEL[provider]}.` };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...authHeaders(provider, token) },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok || res.status === 200 || res.status === 204) {
        return {
          ok: true,
          message: `Conexão OK com ${PROVIDER_LABEL[provider]} (${config.environment}). Certificado ${config.certificate_uploaded ? "enviado" : "AINDA PENDENTE"}.`,
        };
      }
      return { ok: false, message: friendlyStatus(res.status, provider) };
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        return { ok: false, message: `${PROVIDER_LABEL[provider]} não respondeu em 10s. Verifique sua conexão.` };
      }
      return { ok: false, message: `Falha de rede ao contatar ${PROVIDER_LABEL[provider]}: ${err.message}` };
    }
  });

// ─────────────────────────────────────────────────────────────
// Emissão de nota
// ─────────────────────────────────────────────────────────────

const emitSchema = z.object({
  storeId: z.string().uuid(),
  saleId: z.string().uuid().nullable().optional(),
  type: z.enum(["nfce", "nfe"]).default("nfce"),
});

export const emitInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => emitSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: managerRole, error: roleErr } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", context.userId)
      .eq("store_id", data.storeId)
      .in("role", ["admin_dev", "admin", "gerente"])
      .maybeSingle();
    if (roleErr) throw new Error(roleErr.message);
    if (!managerRole) throw new Error("Sem permissão para emitir nota nesta loja.");

    const { data: config, error: cfgErr } = await supabase
      .from("fiscal_configs")
      .select("provider, environment, certificate_uploaded, defer_credentials, nfce_series, nfce_next_number, nfe_series, nfe_next_number, provider_api_url, cnae, crt, csc_id, csc_token, direct_engine, vps_url, vps_auth_secret_name")
      .eq("store_id", data.storeId)
      .maybeSingle();
    if (cfgErr) throw new Error(cfgErr.message);
    if (!config) throw new Error("Configuração fiscal ausente. Preencha em Configurações → Fiscal.");

    const provider = (config.provider ?? "none") as Provider;
    if (provider === "none") {
      throw new Error("Escolha um provedor fiscal em Configurações → Fiscal antes de emitir.");
    }

    // ─── DIRETO SEFAZ ────────────────────────────────────────────
    // agent_local → cliente chama o agente. Retornamos "delegate" com dados úteis.
    // vps          → chamamos a VPS aqui mesmo (server-side).
    if (provider === "direto_sefaz") {
      if (!config.cnae || !config.crt) throw new Error("Preencha CNAE e CRT antes de emitir.");
      if (!config.csc_id || !config.csc_token) throw new Error("CSC ID e CSC Token são obrigatórios.");

      const engine = (config as { direct_engine?: string }).direct_engine ?? "agent_local";
      if (engine === "vps") {
        const vpsUrl = (config as { vps_url?: string }).vps_url;
        const tokenName = (config as { vps_auth_secret_name?: string }).vps_auth_secret_name ?? "FISCAL_VPS_TOKEN";
        if (!vpsUrl) throw new Error("URL da VPS não configurada.");
        const token = process.env[tokenName];
        if (!token) throw new Error(`Secret ${tokenName} ausente. Cadastre em Segredos.`);
        // O cliente ainda precisa montar o DTO e chamar recordDirectEmissionResult,
        // mas devolvemos o endpoint pronto para a mutation client-side.
        return {
          delegate: "vps" as const,
          vps_url: vpsUrl,
          secret_name: tokenName,
          environment: config.environment,
        };
      }
      return {
        delegate: "agent_local" as const,
        environment: config.environment,
      };
    }

    if (!config.certificate_uploaded) {
      throw new Error("Envie o certificado A1 (.pfx) antes de emitir. Consulte docs/fiscal-setup.md.");
    }
    if (!config.cnae || !config.crt) {
      throw new Error("Preencha CNAE e CRT em Configurações → Fiscal antes de emitir.");
    }
    if (!config.csc_id || !config.csc_token) {
      throw new Error("CSC ID e CSC Token são obrigatórios para NFC-e. Solicite-os no portal da SEFAZ do seu estado.");
    }

    const secretName = SECRET_NAME[provider]!;
    const token = process.env[secretName];
    if (!token || config.defer_credentials) {
      throw new Error(
        `Credencial do ${PROVIDER_LABEL[provider]} ainda não configurada. Em Configurações → Fiscal, desmarque "Configurar credencial depois" e cadastre a chave ${secretName}. Guia: docs/fiscal-setup.md.`
      );
    }

    const isNfce = data.type === "nfce";
    const series = isNfce ? config.nfce_series : config.nfe_series;
    const number = isNfce ? config.nfce_next_number : config.nfe_next_number;

    const { data: invoice, error: invErr } = await supabase
      .from("invoices")
      .insert({
        store_id: data.storeId,
        sale_id: data.saleId ?? null,
        type: data.type,
        status: "processando",
        environment: config.environment,
        series,
        number,
        total: 0,
      })
      .select("id")
      .single();
    if (invErr) throw new Error(invErr.message);

    return { invoiceId: invoice.id, status: "processando" as const };
  });

// ─────────────────────────────────────────────────────────────
// Emissão via VPS externa (chamada do backend)
// ─────────────────────────────────────────────────────────────
const emitVpsSchema = z.object({
  storeId: z.string().uuid(),
  dto: z.record(z.string(), z.unknown()),
  /**
   * `primary` usa `fiscal_configs.vps_url`; `fallback` usa
   * `fiscal_configs.vps_fallback_url` (servidor fiscal reserva).
   */
  target: z.enum(["primary", "fallback"]).optional().default("primary"),
});

export const emitViaVps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => emitVpsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: cfg, error: cfgErr } = await supabase
      .from("fiscal_configs")
      .select("vps_url, vps_fallback_url, vps_auth_secret_name, environment")
      .eq("store_id", data.storeId)
      .maybeSingle();
    if (cfgErr) throw new Error(cfgErr.message);
    const baseUrl = data.target === "fallback" ? cfg?.vps_fallback_url : cfg?.vps_url;
    if (!baseUrl) {
      throw new Error(
        data.target === "fallback"
          ? "Servidor fiscal reserva não configurado."
          : "URL do servidor fiscal não configurada.",
      );
    }
    const tokenName = cfg?.vps_auth_secret_name ?? "FISCAL_VPS_TOKEN";
    const token = process.env[tokenName];
    if (!token) throw new Error(`Secret ${tokenName} ausente.`);

    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/nfce/emit`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data.dto),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      return { ...body, elapsed_ms: Date.now() - started, channel: "vps" as const };
    } catch (e) {
      const err = e as Error;
      return { ok: false, error: err.message, elapsed_ms: Date.now() - started, channel: "vps" as const };
    }
  });

// ─────────────────────────────────────────────────────────────
// Servidor fiscal central (Node NFC-e compartilhado entre caixas)
// ─────────────────────────────────────────────────────────────
const pingSchema = z.object({ storeId: z.string().uuid() });

/**
 * Health check do servidor fiscal central. Todos os caixas emitem por ele,
 * então a checagem é feita no backend (o token Bearer nunca vai ao navegador).
 */
export const pingFiscalServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => pingSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: cfg, error } = await supabase
      .from("fiscal_configs")
      .select("vps_url, vps_auth_secret_name")
      .eq("store_id", data.storeId)
      .maybeSingle();
    if (error) return { ok: false, message: error.message };
    if (!cfg?.vps_url) {
      return { ok: false, message: "URL do servidor fiscal central não configurada." };
    }
    const tokenName = cfg.vps_auth_secret_name ?? "FISCAL_VPS_TOKEN";
    const token = process.env[tokenName];
    if (!token) {
      return { ok: false, message: `Segredo ${tokenName} ausente. Cadastre-o antes de emitir.` };
    }
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`${cfg.vps_url.replace(/\/+$/, "")}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const body = (await res.json().catch(() => ({}))) as {
        engine_ready?: boolean;
        version?: string;
        node?: string;
      };
      if (!res.ok) {
        return { ok: false, message: `Servidor fiscal respondeu HTTP ${res.status}.`, elapsed_ms: Date.now() - started };
      }
      if (!body.engine_ready) {
        return {
          ok: false,
          message: "Servidor fiscal online, mas o motor NFC-e (node-dfe) não carregou. Rode `npm install` no servidor.",
          elapsed_ms: Date.now() - started,
        };
      }
      return {
        ok: true,
        message: `Servidor fiscal central online (v${body.version ?? "?"} · Node ${body.node ?? "?"}).`,
        elapsed_ms: Date.now() - started,
      };
    } catch (e) {
      const err = e as Error;
      return {
        ok: false,
        message:
          err.name === "AbortError"
            ? "Servidor fiscal central não respondeu em 10s."
            : `Falha ao contatar o servidor fiscal central: ${err.message}`,
        elapsed_ms: Date.now() - started,
      };
    }
  });

// ─────────────────────────────────────────────────────────────
// Rotina de validação do servidor fiscal central (VPS)
// ─────────────────────────────────────────────────────────────

export interface FiscalServerCheck {
  key: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix: string | null;
}

/**
 * Valida ponta a ponta o servidor fiscal central antes de liberar a emissão:
 * configuração no banco, segredo cadastrado, URL/HTTPS, /health, motor node-dfe
 * e a rotina remota /nfce/validate (certificado, env, conexão SEFAZ).
 * Roda no backend — o token Bearer nunca vai ao navegador. Nunca lança.
 */
export const validateFiscalServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => pingSchema.parse(d))
  .handler(async ({ data, context }) => {
    const checks: FiscalServerCheck[] = [];
    const push = (
      key: string,
      label: string,
      status: FiscalServerCheck["status"],
      detail: string,
      fix: string | null = null,
    ) => checks.push({ key, label, status, detail, fix });

    const finish = () => {
      const failed = checks.filter((c) => c.status === "fail");
      return {
        ok: failed.length === 0,
        summary: failed.length
          ? `${failed.length} problema(s) bloqueando a emissão pelo servidor central.`
          : "Servidor fiscal central validado e pronto para emitir.",
        checks,
      };
    };

    const { supabase } = context;
    const { data: cfg, error } = await supabase
      .from("fiscal_configs")
      .select("vps_url, vps_auth_secret_name, direct_engine, environment, certificate_uploaded")
      .eq("store_id", data.storeId)
      .maybeSingle();

    if (error) {
      push("config", "Configuração fiscal", "fail", error.message, "Revise as configurações fiscais da loja.");
      return finish();
    }

    push(
      "engine_choice",
      "Motor de emissão",
      cfg?.direct_engine === "vps" ? "ok" : "warn",
      cfg?.direct_engine === "vps" ? "Servidor fiscal central" : `Configurado como "${cfg?.direct_engine ?? "agent_local"}"`,
      cfg?.direct_engine === "vps" ? null : "Selecione o Servidor Fiscal Central acima e salve para usar múltiplos caixas.",
    );

    const url = cfg?.vps_url?.trim();
    if (!url) {
      push("url", "URL do servidor", "fail", "Não configurada.", "Informe a URL do servidor fiscal central e salve.");
      return finish();
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      push("url", "URL do servidor", "fail", `"${url}" não é uma URL válida.`, "Use o formato https://fiscal.suaempresa.com.br");
      return finish();
    }
    const isLocal = /^(localhost|127\.|192\.168\.|10\.)/.test(parsed.hostname);
    push(
      "url",
      "URL do servidor",
      parsed.protocol === "https:" || isLocal ? "ok" : "warn",
      `${parsed.origin}${parsed.protocol === "https:" ? "" : " (sem HTTPS)"}`,
      parsed.protocol === "https:" || isLocal ? null : "Use HTTPS: o tráfego inclui dados fiscais da loja.",
    );

    const tokenName = cfg?.vps_auth_secret_name ?? "FISCAL_VPS_TOKEN";
    const token = process.env[tokenName];
    if (!token) {
      push("secret", "Token de autenticação", "fail", `Segredo ${tokenName} ausente.`, `Cadastre o segredo ${tokenName} no backend.`);
      return finish();
    }
    push("secret", "Token de autenticação", "ok", `${tokenName} cadastrado (${token.length} caracteres).`);

    const base = url.replace(/\/+$/, "");
    const call = async (path: string, timeoutMs = 15_000) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { status: res.status, ok: res.ok, body };
      } finally {
        clearTimeout(timer);
      }
    };

    // 1) Disponibilidade + latência
    const t0 = Date.now();
    try {
      const health = await call("/health", 10_000);
      const elapsed = Date.now() - t0;
      if (!health.ok) {
        push("health", "Disponibilidade", "fail", `HTTP ${health.status} em /health.`, "Confirme se o container está no ar e a porta exposta.");
        return finish();
      }
      push(
        "health",
        "Disponibilidade",
        elapsed > 3000 ? "warn" : "ok",
        `Online em ${elapsed}ms · v${String(health.body.version ?? "?")} · Node ${String(health.body.node ?? "?")}`,
        elapsed > 3000 ? "Latência alta pode atrasar o fechamento das vendas no caixa." : null,
      );
      push(
        "engine",
        "Motor node-dfe",
        health.body.engine_ready ? "ok" : "fail",
        health.body.engine_ready ? "carregado" : "não carregado no servidor",
        health.body.engine_ready ? null : "Rode `npm install` no servidor fiscal e reinicie o serviço.",
      );
    } catch (e) {
      const err = e as Error;
      push(
        "health",
        "Disponibilidade",
        "fail",
        err.name === "AbortError" ? "Sem resposta em 10s." : err.message,
        "Verifique DNS, firewall e se o serviço está rodando.",
      );
      return finish();
    }

    // 2) Rotina remota de validação (certificado, env, SEFAZ)
    try {
      const remote = await call("/nfce/validate", 25_000);
      if (remote.status === 401) {
        push("auth", "Autenticação", "fail", "Servidor recusou o token (401).", `O valor de ${tokenName} deve ser igual ao FISCAL_VPS_TOKEN do servidor.`);
        return finish();
      }
      push("auth", "Autenticação", "ok", "Token aceito pelo servidor.");
      if (remote.status === 404) {
        push(
          "remote",
          "Rotina remota",
          "warn",
          "Servidor sem /nfce/validate (versão antiga).",
          "Atualize o servidor fiscal para a versão 1.1.0 para checagens completas.",
        );
        return finish();
      }
      const remoteChecks = Array.isArray(remote.body.checks) ? (remote.body.checks as FiscalServerCheck[]) : [];
      for (const c of remoteChecks) checks.push({ ...c, key: `remote_${c.key}` });
      if (!remoteChecks.length) {
        push("remote", "Rotina remota", "warn", "Servidor não devolveu checagens.", "Verifique os logs do servidor fiscal.");
      }
    } catch (e) {
      const err = e as Error;
      push(
        "remote",
        "Rotina remota",
        "fail",
        err.name === "AbortError" ? "Validação remota expirou em 25s." : err.message,
        "A consulta à SEFAZ pode estar travando: cheque a saída HTTPS do servidor.",
      );
    }

    // 3) Ambiente
    push(
      "environment",
      "Ambiente fiscal",
      cfg?.environment === "producao" ? "ok" : "warn",
      cfg?.environment === "producao" ? "Produção" : "Homologação",
      cfg?.environment === "producao" ? null : "Em homologação as notas não têm valor fiscal.",
    );

    return finish();
  });
