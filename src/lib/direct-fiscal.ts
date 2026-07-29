/**
 * Cliente para emissão direta SEFAZ via Agente Local ou VPS.
 *
 * Fluxo:
 *  1) Reserva número atômico no banco (RPC `reserve_nfce_number`).
 *  2) Monta DTO da venda (item, pagamento, emitente, destinatário).
 *  3) Envia ao motor escolhido:
 *     - agent_local:  POST http://127.0.0.1:9100/nfce/emit  (do navegador)
 *     - vps:          server fn `emitViaVps` (do backend)
 *  4) Grava resultado (chave/protocolo/xml/qr) via server fn `recordDirectEmissionResult`.
 *  5) Fallback: se agent_local falhar por offline, tenta VPS se configurada.
 */

import { supabase } from "@/integrations/supabase/client";
import { emitInvoice, emitViaVps } from "@/lib/fiscal.functions";
import { getTerminalId, getTerminalName } from "@/lib/terminal";
import {
  invalidateAgentUrlCache,
  resolveAgentBaseUrl,
  singleFlight,
  withSefazSlot,
} from "@/lib/sefaz-connection";
import { classifyFiscalError } from "@/lib/fiscal-retry-policy";


export interface DirectEmitInput {
  storeId: string;
  saleId: string;
  environment?: "homologacao" | "producao";
}

export interface DirectEmitResult {
  ok: boolean;
  chave?: string;
  protocolo?: string;
  qr_url?: string | null;
  qr_png?: string | null;
  xml?: string | null;
  ambiente?: string;
  consulta_url?: string | null;
  channel: "agent_local" | "vps";
  elapsed_ms?: number;
  error?: string;
  /** Numeração efetivamente reservada e transmitida — base da auditoria. */
  series?: number;
  number?: number;
}

/**
 * Descoberta do agente com cache: uma sonda por minuto em vez de três
 * requisições por nota (ver `sefaz-connection`).
 */
async function findAgentUrl(): Promise<string | null> {
  return resolveAgentBaseUrl(2500);
}


async function reserveNumber(storeId: string) {
  const { data, error } = await supabase.rpc("reserve_nfce_number", { _store_id: storeId });
  if (error) throw new Error(`Falha ao reservar número: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Configuração fiscal ausente para esta loja.");
  return row as { series: number; number: number; environment: string };
}

async function buildSaleDto(saleId: string, storeId: string, environment: string, series: number, number: number) {
  const [saleRes, itemsRes, paymentsRes, storeRes, cfgRes] = await Promise.all([
    supabase.from("sales").select("*").eq("id", saleId).single(),
    supabase.from("sale_items").select("*, products(*)").eq("sale_id", saleId),
    supabase.from("sale_payments").select("*").eq("sale_id", saleId),
    supabase.from("stores").select("*").eq("id", storeId).single(),
    supabase.from("fiscal_configs").select("*").eq("store_id", storeId).single(),
  ]);
  if (saleRes.error) throw saleRes.error;
  if (itemsRes.error) throw itemsRes.error;
  if (paymentsRes.error) throw paymentsRes.error;
  if (storeRes.error) throw storeRes.error;
  if (cfgRes.error) throw cfgRes.error;

  const store = storeRes.data as Record<string, unknown>;
  const cfg = cfgRes.data as Record<string, unknown>;
  const items = itemsRes.data ?? [];
  const payments = paymentsRes.data ?? [];

  return {
    series,
    number,
    environment,
    // Identificação do caixa emissor — o servidor fiscal central recebe notas
    // de vários PDVs e registra a origem de cada uma.
    terminal: { id: getTerminalId(), name: getTerminalName() },
    dataEmissao: new Date().toISOString(),
    emitente: {
      cnpj: String(store.cnpj ?? cfg.cnpj ?? ""),
      ie: String(store.ie ?? ""),
      razaoSocial: String(store.name ?? ""),
      nomeFantasia: String(store.fantasy_name ?? ""),
      crt: Number(cfg.crt ?? 1),
      endereco: {
        logradouro: String(store.address_line ?? ""),
        numero: String((store.address_number as string) ?? "S/N"),
        bairro: String((store.district as string) ?? ""),
        cidade: String(store.city ?? ""),
        uf: String(store.state ?? "MG"),
        cep: String(store.zip ?? "").replace(/\D/g, ""),
        cMun: String((store.ibge_code as string) ?? ""),
      },
    },
    itens: items.map((it: Record<string, unknown>) => {
      const prod = (it.products ?? {}) as Record<string, unknown>;
      return {
        codigo: (prod.sku as string) ?? (prod.id as string) ?? String(it.id),
        descricao: (prod.name as string) ?? "Item",
        ncm: (prod.ncm as string) ?? "00000000",
        cfop: (prod.cfop as string) ?? "5102",
        unidade: (prod.unit as string) ?? "UN",
        quantidade: Number(it.quantity),
        valorUnitario: Number(it.unit_price),
        valorTotal: Number(it.total_price),
        icms: { cst: (prod.icms_cst as string) ?? "00", origem: "0", aliquota: Number(prod.icms_rate ?? 0) },
      };
    }),
    pagamentos: payments.map((p: Record<string, unknown>) => ({
      tipo: mapPaymentType(p.method as string),
      valor: Number(p.amount),
    })),
    destinatario: null, // TODO: puxar do customer se venda vinculada
  };
}

function mapPaymentType(method: string): string {
  // Códigos SEFAZ pra tPag
  switch (method) {
    case "dinheiro": return "01";
    case "credito": return "03";
    case "debito": return "04";
    case "pix": return "17";
    case "vale": return "05";
    default: return "99";
  }
}

/**
 * Emissão via agente local (chamada do navegador do caixa).
 */
export async function emitViaAgent(input: DirectEmitInput): Promise<DirectEmitResult> {
  const agentUrl = await findAgentUrl();
  if (!agentUrl) {
    return { ok: false, channel: "agent_local", error: "Agente local offline." };
  }

  const reserved = await reserveNumber(input.storeId);
  const environment = input.environment ?? (reserved.environment as "homologacao" | "producao");
  const dto = await buildSaleDto(input.saleId, input.storeId, environment, reserved.series, reserved.number);

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${agentUrl}/nfce/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dto),
    });
  } catch (e) {
    // Rede caiu no meio: a URL cacheada pode ter ficado obsoleta.
    invalidateAgentUrlCache();
    return {
      ok: false,
      channel: "agent_local",
      error: e instanceof Error ? e.message : String(e),
      series: reserved.series,
      number: reserved.number,
    };
  }

  const elapsed_ms = Date.now() - started;
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return {
    ...body,
    channel: "agent_local",
    elapsed_ms,
    series: reserved.series,
    number: reserved.number,
  };
}


/**
 * Testa emissão em homologação — força ambiente=homologacao e grava histórico.
 */
export async function testHomologacaoViaAgent(input: DirectEmitInput): Promise<DirectEmitResult> {
  const result = await emitViaAgent({ ...input, environment: "homologacao" });
  const entry = {
    at: new Date().toISOString(),
    ok: result.ok,
    chave: result.chave ?? null,
    protocolo: result.protocolo ?? null,
    channel: result.channel,
    elapsed_ms: result.elapsed_ms ?? null,
    error: result.error ?? null,
  };
  try {
    await supabase.rpc("record_homologacao_test", { _store_id: input.storeId, _result: entry });
  } catch (e) {
    console.warn("[direct-fiscal] falha ao gravar histórico:", e);
  }
  return result;
}

/**
 * Emissão via servidor fiscal (VPS). Reserva número + monta DTO no navegador
 * (usa RLS do usuário logado) e transmite pelo backend com Bearer.
 *
 * `target` escolhe entre o servidor principal (`vps_url`) e o reserva
 * (`vps_fallback_url`), configurados em `fiscal_configs`.
 */
export async function emitViaVpsFlow(
  input: DirectEmitInput & { target?: "primary" | "fallback" },
): Promise<DirectEmitResult> {
  const reserved = await reserveNumber(input.storeId);
  const environment = input.environment ?? (reserved.environment as "homologacao" | "producao");
  const dto = await buildSaleDto(input.saleId, input.storeId, environment, reserved.series, reserved.number);
  const started = Date.now();
  const r = await emitViaVps({
    data: { storeId: input.storeId, dto, target: input.target ?? "primary" },
  });
  return {
    ...(r as Record<string, unknown>),
    channel: "vps",
    elapsed_ms: (r as { elapsed_ms?: number }).elapsed_ms ?? Date.now() - started,
    series: reserved.series,
    number: reserved.number,
  } as DirectEmitResult;
}

// ─────────────────────────────────────────────────────────────
// Fallback encadeado entre motores de emissão
// ─────────────────────────────────────────────────────────────

/** Motores possíveis, em ordem de preferência configurável por loja. */
export type FiscalEngine = "agent_local" | "vps" | "vps_fallback";

export const ENGINE_LABEL: Record<FiscalEngine, string> = {
  agent_local: "Agente local do caixa",
  vps: "Servidor fiscal central",
  vps_fallback: "Servidor fiscal reserva",
};

interface FallbackConfig {
  enabled: boolean;
  order: FiscalEngine[];
  hasVps: boolean;
  hasFallbackVps: boolean;
}

async function loadFallbackConfig(storeId: string): Promise<FallbackConfig> {
  const { data } = await supabase
    .from("fiscal_configs")
    .select("fallback_enabled, fallback_order, vps_url, vps_fallback_url")
    .eq("store_id", storeId)
    .maybeSingle();

  const rawOrder = (data?.fallback_order ?? ["agent_local", "vps"]) as string[];
  const order = rawOrder.filter((e): e is FiscalEngine =>
    e === "agent_local" || e === "vps" || e === "vps_fallback",
  );

  return {
    enabled: data?.fallback_enabled ?? true,
    order: order.length > 0 ? order : ["agent_local", "vps"],
    hasVps: Boolean(data?.vps_url),
    hasFallbackVps: Boolean(data?.vps_fallback_url),
  };
}

/**
 * Monta a cadeia de tentativas: o motor escolhido pelo despacho vem primeiro,
 * seguido dos demais na ordem configurada — apenas os que estão realmente
 * configurados (VPS sem URL não entra na fila de tentativas).
 */
function buildEngineChain(preferred: FiscalEngine, cfg: FallbackConfig): FiscalEngine[] {
  const available = (engine: FiscalEngine) =>
    engine === "agent_local" || (engine === "vps" ? cfg.hasVps : cfg.hasFallbackVps);

  const chain: FiscalEngine[] = available(preferred) ? [preferred] : [];
  if (!cfg.enabled) return chain.length > 0 ? chain : [preferred];

  for (const engine of cfg.order) {
    if (!chain.includes(engine) && available(engine)) chain.push(engine);
  }
  return chain.length > 0 ? chain : [preferred];
}

async function runEngine(
  engine: FiscalEngine,
  storeId: string,
  saleId: string,
  environment: "homologacao" | "producao",
): Promise<DirectEmitResult> {
  const guard = (e: unknown): DirectEmitResult => ({
    ok: false,
    channel: engine === "agent_local" ? "agent_local" : "vps",
    error: e instanceof Error ? e.message : String(e),
  });

  if (engine === "agent_local") {
    return emitViaAgent({ storeId, saleId, environment }).catch(guard);
  }
  return emitViaVpsFlow({
    storeId,
    saleId,
    environment,
    target: engine === "vps" ? "primary" : "fallback",
  }).catch(guard);
}

/** Erros do agente que justificam tentar a VPS automaticamente. */
function isRecoverableAgentError(error?: string): boolean {
  if (!error) return true;
  return /offline|failed to fetch|load failed|ECONNREFUSED|timeout|abort|não carregado|nao carregado|501|não instalado|nao instalado|indispon[ií]vel|502|503|504|network/i.test(
    error,
  );
}

/**
 * Fluxo completo pós-venda: consulta emitInvoice (autorização + delegate),
 * percorre a cadeia de motores (agente local → servidor central → reserva),
 * grava invoice + atualiza sales.fiscal_status.
 *
 * Só cai para o próximo motor em falhas de DISPONIBILIDADE. Rejeição de
 * conteúdo (XML/CSC/certificado) falharia igual em qualquer motor e por isso
 * interrompe a cadeia imediatamente.
 *
 * Retorna resultado unificado. Não lança — grava "falha" e devolve error.
 */
async function emitDirectFiscalInner(params: {
  storeId: string;
  saleId: string;
  /** false desliga o fallback (usado em testes de homologação). */
  allowVpsFallback?: boolean;
}): Promise<DirectEmitResult & { invoiceId?: string; fellBackToVps?: boolean; engine?: FiscalEngine; attempts?: { engine: FiscalEngine; error?: string }[] }> {
  const { storeId, saleId, allowVpsFallback = true } = params;
  let result: DirectEmitResult;
  let usedEngine: FiscalEngine = "agent_local";
  let fellBackToVps = false;
  const attempts: { engine: FiscalEngine; error?: string }[] = [];

  try {
    const dispatch = (await emitInvoice({ data: { storeId, saleId, type: "nfce" } })) as
      | { delegate: "agent_local"; environment: string }
      | { delegate: "vps"; environment: string; vps_url: string; secret_name: string }
      | { invoiceId: string; status: string };

    if (!("delegate" in dispatch)) {
      // Provedor terceirizado (Focus/PlugNotas). Já criou invoice=processando.
      await supabase.from("sales").update({ fiscal_status: "emitida" }).eq("id", saleId);
      return { ok: true, channel: "vps", invoiceId: dispatch.invoiceId };
    }

    const environment = dispatch.environment as "homologacao" | "producao";
    const cfg = await loadFallbackConfig(storeId);
    const chain = allowVpsFallback
      ? buildEngineChain(dispatch.delegate as FiscalEngine, cfg)
      : [dispatch.delegate as FiscalEngine];

    result = { ok: false, channel: "agent_local", error: "Nenhum motor fiscal configurado." };

    for (let i = 0; i < chain.length; i += 1) {
      const engine = chain[i];
      usedEngine = engine;
      result = await runEngine(engine, storeId, saleId, environment);
      attempts.push({ engine, error: result.ok ? undefined : result.error });
      if (result.ok) {
        fellBackToVps = i > 0;
        break;
      }
      // Rejeição de conteúdo: trocar de motor não resolve.
      if (!isRecoverableAgentError(result.error)) break;
    }

    if (!result.ok && attempts.length > 1) {
      result = {
        ...result,
        error: attempts
          .map((a) => `${ENGINE_LABEL[a.engine]}: ${a.error ?? "falha"}`)
          .join(" · "),
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from("sales").update({ fiscal_status: "falha" }).eq("id", saleId).then(
      () => undefined,
      () => undefined,
    );
    return { ok: false, channel: "agent_local", error: msg, attempts };
  }

  if (!result.ok) {
    await supabase.from("sales").update({ fiscal_status: "falha" }).eq("id", saleId);
    return { ...result, fellBackToVps, engine: usedEngine, attempts };
  }

  // Grava invoice autorizada + atualiza sale.
  try {
    const { data: sale } = await supabase.from("sales").select("total").eq("id", saleId).single();
    const { data: cfg } = await supabase
      .from("fiscal_configs")
      .select("nfce_series, nfce_next_number, environment")
      .eq("store_id", storeId)
      .single();
    const { data: inv } = await supabase
      .from("invoices")
      .insert({
        store_id: storeId,
        sale_id: saleId,
        type: "nfce",
        status: "autorizada",
        environment: (cfg?.environment ?? result.ambiente ?? "homologacao") as "homologacao" | "producao",
        // Numeração REALMENTE reservada e transmitida. Ler `nfce_next_number`
        // aqui geraria duplicidade quando outro caixa reservasse no intervalo.
        series: result.series ?? cfg?.nfce_series ?? 1,
        number: result.number ?? Math.max(1, (cfg?.nfce_next_number ?? 2) - 1),
        total: Number(sale?.total ?? 0),
        access_key: result.chave ?? null,
        protocol: result.protocolo ?? null,
        danfe_url: result.qr_url ?? null,
        provider_response: JSON.parse(JSON.stringify({ ...result, engine: usedEngine, attempts })),
        terminal_key: getTerminalId(),
        issued_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    await supabase.from("sales").update({ fiscal_status: "emitida" }).eq("id", saleId);
    return { ...result, invoiceId: inv?.id, fellBackToVps, engine: usedEngine, attempts };
  } catch (e) {
    console.warn("[direct-fiscal] emissão OK mas falhou ao gravar invoice:", e);
    await supabase.from("sales").update({ fiscal_status: "emitida" }).eq("id", saleId);
    return { ...result, fellBackToVps, engine: usedEngine, attempts };
  }
}

/**
 * Emissão pública: deduplicada por venda e limitada pelo semáforo de conexões.
 *
 * Dois efeitos práticos:
 *  - o botão "emitir" clicado duas vezes, a fila de background e o fluxo de
 *    finalização compartilham UMA transmissão por venda (nunca dois números);
 *  - no máximo `MAX_SEFAZ_CONNECTIONS` transmissões abertas por caixa, o que
 *    evita o cStat 656 (consumo indevido) em horários de pico.
 */
export function emitDirectFiscal(
  params: Parameters<typeof emitDirectFiscalInner>[0],
): ReturnType<typeof emitDirectFiscalInner> {
  return singleFlight(`emit:${params.saleId}`, () =>
    withSefazSlot(() => emitDirectFiscalInner(params)),
  );
}

/** Erro definitivo (rejeição de conteúdo) — a fila não deve reagendar. */
export function isPermanentFiscalError(error?: string): boolean {
  return Boolean(error) && classifyFiscalError(error) === "permanent";
}
