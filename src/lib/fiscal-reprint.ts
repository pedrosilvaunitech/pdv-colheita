/**
 * Reimpressão de cupom fiscal autorizado (com QR Code real da SEFAZ).
 *
 * Diferente do recibo impresso no fechamento da venda — que sai provisório,
 * sem chave nem QR válidos — aqui remontamos o `ReceiptData` a partir do
 * banco e anexamos os dados de autorização gravados em `invoices`
 * (chave, protocolo, URL do QR e o PNG devolvido pelo agente/VPS).
 */

import { supabase } from "@/integrations/supabase/client";
import { tryPrintEscPos } from "@/lib/escpos";
import { buildReceiptHTML, printReceipt, type ReceiptData, type ReceiptPayment } from "@/lib/receipt";

const METHOD_LABEL: Record<string, string> = {
  dinheiro: "Dinheiro",
  pix: "PIX",
  debito: "Débito",
  credito: "Crédito",
  vale: "Vale",
};

export interface AuthorizedReceipt {
  data: ReceiptData;
  invoiceId: string;
  authorized: boolean;
}

/**
 * Monta o cupom de uma venda já autorizada. Lança se a venda não existir.
 * Quando não há invoice autorizada, `authorized=false` e o cupom sai sem QR.
 */
export async function buildAuthorizedReceipt(saleId: string): Promise<AuthorizedReceipt> {
  const [saleRes, itemsRes, paymentsRes, invoiceRes] = await Promise.all([
    supabase.from("sales").select("*, stores(*)").eq("id", saleId).single(),
    supabase.from("sale_items").select("*, products(name, barcode)").eq("sale_id", saleId),
    supabase.from("sale_payments").select("*").eq("sale_id", saleId),
    supabase
      .from("invoices")
      .select("id, access_key, protocol, danfe_url, provider_response, environment, series, number, issued_at, status")
      .eq("sale_id", saleId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (saleRes.error) throw new Error(`Venda não encontrada: ${saleRes.error.message}`);
  if (itemsRes.error) throw itemsRes.error;
  if (paymentsRes.error) throw paymentsRes.error;

  const sale = saleRes.data as Record<string, unknown> & { stores?: Record<string, unknown> | null };
  const store = (sale.stores ?? {}) as Record<string, unknown>;
  const invoice = invoiceRes.data ?? null;

  // O agente/VPS devolve `qr_png` dentro de provider_response; nem todo
  // provedor preenche, por isso o acesso é defensivo.
  const providerResponse = (invoice?.provider_response ?? null) as Record<string, unknown> | null;
  const qrPng = typeof providerResponse?.qr_png === "string" ? providerResponse.qr_png : null;
  const qrUrl =
    (typeof providerResponse?.qr_url === "string" ? providerResponse.qr_url : null) ??
    (invoice?.danfe_url ?? null);

  const payments: ReceiptPayment[] = (paymentsRes.data ?? []).map((p) => {
    const inst = Number(p.installments ?? 1);
    const base = METHOD_LABEL[String(p.method)] ?? String(p.method);
    return {
      label: inst > 1 ? `${base} ${inst}x` : base,
      amount: Number(p.amount ?? 0),
      method: String(p.method),
      installments: inst > 1 ? inst : undefined,
    };
  });

  const authorized = invoice?.status === "autorizada" && !!invoice?.access_key;

  const data: ReceiptData = {
    store: {
      name: String(store.name ?? "Loja"),
      cnpj: (store.cnpj as string) ?? null,
      address: (store.address_line as string) ?? null,
      phone: (store.phone as string) ?? null,
    },
    paper_width: 80,
    items: (itemsRes.data ?? []).map((it) => {
      const prod = (it.products ?? {}) as { name?: string; barcode?: string | null };
      return {
        name: prod.name ?? "Item",
        quantity: Number(it.quantity ?? 0),
        unit_price: Number(it.unit_price ?? 0),
        total: Number(it.total ?? 0),
        barcode: prod.barcode ?? null,
      };
    }),
    subtotal: Number(sale.subtotal ?? sale.total ?? 0),
    discount: Number(sale.discount ?? 0),
    total: Number(sale.total ?? 0),
    payment_method: payments.map((p) => p.label).join(" + ") || "—",
    payments,
    sale_id: saleId,
    document_type: "fiscal",
    issued_at: sale.finalized_at ? new Date(String(sale.finalized_at)) : new Date(),
    customer: { name: (sale.customer_name as string) ?? null, doc: (sale.customer_doc as string) ?? null },
    fiscal: invoice
      ? {
          chave: invoice.access_key,
          protocolo: invoice.protocol,
          qr_url: qrUrl,
          qr_png: qrPng,
          ambiente: invoice.environment,
          series: invoice.series,
          number: invoice.number,
          issued_at: invoice.issued_at,
        }
      : null,
  };

  return { data, invoiceId: invoice?.id ?? "", authorized };
}

/**
 * Reimprime o cupom fiscal autorizado. Tenta ESC/POS (agente/WebUSB) e,
 * se nenhum canal responder, cai para a impressão HTML do navegador —
 * assim o operador nunca fica sem a via do consumidor.
 */
export async function reprintAuthorizedReceipt(saleId: string): Promise<{ ok: boolean; authorized: boolean; error?: string }> {
  try {
    const { data, authorized } = await buildAuthorizedReceipt(saleId);
    const printed = await tryPrintEscPos(data, false);
    if (!printed) printReceipt(buildReceiptHTML(data));
    return { ok: true, authorized };
  } catch (e) {
    return { ok: false, authorized: false, error: e instanceof Error ? e.message : String(e) };
  }
}
