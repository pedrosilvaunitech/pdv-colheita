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
import { pingPrintAgent } from "@/lib/print-agent";
import { emitInvoice, emitViaVps } from "@/lib/fiscal.functions";


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
}

const AGENT_BASE_URLS = ["http://127.0.0.1:9100", "http://localhost:9100"];

async function findAgentUrl(): Promise<string | null> {
  const ping = await pingPrintAgent(3000).catch(() => null);
  if (!ping?.online) return null;
  // pingPrintAgent tenta os dois hosts internamente; usamos o primeiro que responde no fetch.
  for (const base of AGENT_BASE_URLS) {
    try {
      const r = await fetch(`${base}/status`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return base;
    } catch { /* tenta próximo */ }
  }
  return null;
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
  const res = await fetch(`${agentUrl}/nfce/emit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dto),
  });

  const elapsed_ms = Date.now() - started;
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return { ...body, channel: "agent_local", elapsed_ms };
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
 * Emissão VPS server-side. Reserva número + monta DTO no navegador
 * (usa RLS do usuário logado) e transmite pelo backend com Bearer.
 */
export async function emitViaVpsFlow(input: DirectEmitInput): Promise<DirectEmitResult> {
  const reserved = await reserveNumber(input.storeId);
  const environment = input.environment ?? (reserved.environment as "homologacao" | "producao");
  const dto = await buildSaleDto(input.saleId, input.storeId, environment, reserved.series, reserved.number);
  const started = Date.now();
  const r = await emitViaVps({ data: { storeId: input.storeId, dto } });
  return { ...(r as Record<string, unknown>), channel: "vps", elapsed_ms: (r as { elapsed_ms?: number }).elapsed_ms ?? Date.now() - started } as DirectEmitResult;
}

/**
 * Fluxo completo pós-venda: consulta emitInvoice (autorização + delegate),
 * despacha para agente local ou VPS, grava invoice + atualiza sales.fiscal_status.
 * Retorna resultado unificado. Não lança — grava "falha" e devolve error.
 */
export async function emitDirectFiscal(params: {
  storeId: string;
  saleId: string;
}): Promise<DirectEmitResult & { invoiceId?: string }> {
  const { storeId, saleId } = params;
  let result: DirectEmitResult;
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

    if (dispatch.delegate === "agent_local") {
      result = await emitViaAgent({ storeId, saleId, environment: dispatch.environment as "homologacao" | "producao" });
    } else {
      result = await emitViaVpsFlow({ storeId, saleId, environment: dispatch.environment as "homologacao" | "producao" });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from("sales").update({ fiscal_status: "falha" }).eq("id", saleId).then(
      () => undefined,
      () => undefined,
    );
    return { ok: false, channel: "agent_local", error: msg };
  }

  if (!result.ok) {
    await supabase.from("sales").update({ fiscal_status: "falha" }).eq("id", saleId);
    return result;
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
        series: cfg?.nfce_series ?? 1,
        number: cfg?.nfce_next_number ?? 1,
        total: Number(sale?.total ?? 0),
        access_key: result.chave ?? null,
        protocol: result.protocolo ?? null,
        danfe_url: result.qr_url ?? null,
        provider_response: result as unknown as Record<string, unknown>,
        issued_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    await supabase.from("sales").update({ fiscal_status: "emitida" }).eq("id", saleId);
    return { ...result, invoiceId: inv?.id };
  } catch (e) {
    console.warn("[direct-fiscal] emissão OK mas falhou ao gravar invoice:", e);
    await supabase.from("sales").update({ fiscal_status: "emitida" }).eq("id", saleId);
    return result;
  }
}
