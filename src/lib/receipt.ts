// Recibo não-fiscal — geração de HTML térmico e impressão via window.print()
// Impressão direta ESC/POS via Web USB / Web Serial será plugada na Fase 4.

export interface ReceiptItem {
  name: string;
  quantity: number;
  unit_price: number;
  total: number;
  barcode?: string | null;
}

export interface ReceiptPayment {
  label: string;         // "Dinheiro", "PIX", "Crédito 3x de R$ 100,00"
  amount: number;        // valor pago nessa forma (já descontado troco, se aplicável)
  method?: string;       // dinheiro | pix | debito | credito
  installments?: number; // parcelas (crédito)
}

export interface ReceiptData {
  store: { name: string; cnpj?: string | null; address?: string | null; phone?: string | null };
  header?: string | null;
  footer?: string | null;
  paper_width: 58 | 80;
  items: ReceiptItem[];
  subtotal: number;
  discount: number;
  total: number;
  /** Compat: rótulo curto agregado (ex.: "PIX + Crédito 3x"). Preferir `payments`. */
  payment_method: string;
  /** Lista detalhada de pagamentos parciais — usada para imprimir cada linha. */
  payments?: ReceiptPayment[];
  received?: number;
  change?: number;
  operator?: string;
  sale_id: string;
  document_type: "fiscal" | "nao_fiscal";
  issued_at: Date;
  customer?: { name?: string | null; doc?: string | null };
}

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function buildReceiptHTML(r: ReceiptData): string {
  const widthMm = r.paper_width;
  const isFiscal = r.document_type === "fiscal";
  const rows = r.items.map((it) => `
    <tr><td colspan="3" style="padding-top:4px">${escape(it.name)}${it.barcode ? ` <span style="opacity:.6">· ${it.barcode}</span>` : ""}</td></tr>
    <tr>
      <td>${it.quantity.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} x ${brl(it.unit_price)}</td>
      <td></td>
      <td style="text-align:right">${brl(it.total)}</td>
    </tr>
  `).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Recibo ${r.sale_id.slice(0, 8)}</title>
    <style>
      @page { size: ${widthMm}mm auto; margin: 2mm; }
      * { box-sizing: border-box; }
      body { font-family: 'Courier New', monospace; font-size: ${widthMm === 58 ? 10 : 11}px; margin: 0; color: #000; }
      .r { width: ${widthMm - 4}mm; }
      h1 { font-size: 13px; text-align: center; margin: 2px 0; }
      .muted { opacity: .7; }
      .center { text-align: center; }
      .sep { border-top: 1px dashed #000; margin: 4px 0; }
      table { width: 100%; border-collapse: collapse; font-size: inherit; }
      td { vertical-align: top; padding: 0; }
      .totals td { padding: 2px 0; }
      .totals .lbl { text-align: right; padding-right: 8px; }
      .badge { display: inline-block; padding: 2px 6px; border: 1px solid #000; font-weight: bold; }
      @media screen { body { background: #eee; padding: 20px; } .r { background: #fff; padding: 10px; margin: 0 auto; box-shadow: 0 2px 8px rgba(0,0,0,.15);} }
    </style></head><body><div class="r">
    <h1>${escape(r.store.name)}</h1>
    ${r.store.cnpj ? `<div class="center muted">CNPJ ${escape(r.store.cnpj)}</div>` : ""}
    ${r.store.address ? `<div class="center muted">${escape(r.store.address)}</div>` : ""}
    ${r.store.phone ? `<div class="center muted">${escape(r.store.phone)}</div>` : ""}
    ${r.header ? `<div class="center" style="margin-top:4px">${escape(r.header)}</div>` : ""}
    <div class="center" style="margin-top:6px"><span class="badge">${isFiscal ? "CUPOM FISCAL (NFC-e)" : "DOCUMENTO NÃO FISCAL"}</span></div>
    ${!isFiscal ? `<div class="center muted" style="font-size:9px">Não é documento fiscal · não substitui nota fiscal</div>` : ""}
    <div class="sep"></div>
    <div>Venda: <b>${r.sale_id.slice(0, 8).toUpperCase()}</b></div>
    <div>Data: ${r.issued_at.toLocaleString("pt-BR")}</div>
    ${r.operator ? `<div>Operador: ${escape(r.operator)}</div>` : ""}
    ${r.customer?.name ? `<div>Cliente: ${escape(r.customer.name)}${r.customer.doc ? ` · ${escape(r.customer.doc)}` : ""}</div>` : ""}
    <div class="sep"></div>
    <table>${rows}</table>
    <div class="sep"></div>
    <table class="totals">
      <tr><td class="lbl">SUBTOTAL</td><td style="text-align:right">${brl(r.subtotal)}</td></tr>
      ${r.discount > 0 ? `<tr><td class="lbl">DESCONTO</td><td style="text-align:right">-${brl(r.discount)}</td></tr>` : ""}
      <tr><td class="lbl"><b>TOTAL</b></td><td style="text-align:right"><b>${brl(r.total)}</b></td></tr>
      ${(r.payments && r.payments.length > 0
        ? `<tr><td colspan="2" class="lbl" style="text-align:left;padding-top:4px"><b>PAGAMENTOS</b></td></tr>` +
          r.payments.map((p) => `<tr><td class="lbl">${escape(p.label.toUpperCase())}</td><td style="text-align:right">${brl(p.amount)}</td></tr>${p.installments && p.installments > 1 ? `<tr><td colspan="2" style="text-align:right;font-size:9px;opacity:.7">${p.installments}x de ${brl(p.amount / p.installments)}</td></tr>` : ""}`).join("") +
          `<tr><td class="lbl">RECEBIDO</td><td style="text-align:right">${brl(r.received ?? r.total)}</td></tr>`
        : `<tr><td class="lbl">${escape(r.payment_method.toUpperCase())}</td><td style="text-align:right">${brl(r.received ?? r.total)}</td></tr>`)}
      ${r.change && r.change > 0 ? `<tr><td class="lbl">TROCO</td><td style="text-align:right">${brl(r.change)}</td></tr>` : ""}
    </table>
    <div class="sep"></div>
    <div class="center">${escape(r.footer || "Obrigado pela preferência!")}</div>
    <div class="center muted" style="font-size:9px;margin-top:4px">Bastion POS</div>
    </div><script>window.onload=function(){setTimeout(function(){window.print();},150);};</script></body></html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function printReceipt(html: string) {
  const w = window.open("", "_blank", "width=380,height=640");
  if (!w) {
    // Popup blocked: fallback to same-tab print
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
