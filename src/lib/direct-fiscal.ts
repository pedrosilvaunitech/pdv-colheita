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

async function fetchAgentUrl(): Promise<string | null> {
  try { return await getAgentBaseUrl(); }
  catch { return null; }
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

  const store = storeRes.data;
  const cfg = cfgRes.data;
  const items = itemsRes.data ?? [];
  const payments = paymentsRes.data ?? [];

  return {
    series,
    number,
    environment,
    dataEmissao: new Date().toISOString(),
    emitente: {
      cnpj: store.cnpj ?? cfg.cnpj ?? "",
      ie: store.ie ?? "",
      razaoSocial: store.name ?? "",
      nomeFantasia: store.fantasy_name ?? "",
      crt: Number(cfg.crt ?? 1),
      endereco: {
        logradouro: store.address_line ?? "",
        numero: store.address_number ?? "S/N",
        bairro: store.district ?? "",
        cidade: store.city ?? "",
        uf: store.state ?? "MG",
        cep: (store.zip ?? "").replace(/\D/g, ""),
        cMun: store.ibge_code ?? "",
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
  const agentUrl = await fetchAgentUrl();
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
