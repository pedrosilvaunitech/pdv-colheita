// Recibo não-fiscal — geração de HTML térmico e impressão silenciosa via iframe.
// O caminho preferido é ESC/POS direto (ver escpos.ts). Este HTML é o
// fallback quando não há Agente/WebUSB/Serial autorizado.

export interface ReceiptItem {
  name: string;
  quantity: number;
  unit_price: number;
  total: number;
  barcode?: string | null;
}

export interface ReceiptPayment {
  label: string;
  amount: number;
  method?: string;
  installments?: number;
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
  payment_method: string;
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
    <tr><td colspan="3" style="padding-top:4px">${escape(it.name)}${it.barcode ? ` <span>· ${it.barcode}</span>` : ""}</td></tr>
    <tr>
      <td>${it.quantity.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} x ${brl(it.unit_price)}</td>
      <td></td>
      <td style="text-align:right">${brl(it.total)}</td>
    </tr>
  `).join("");

  // Fallback HTML: negrito total + contraste máximo + @page exatamente do
  // tamanho do papel (58/80 mm) para o driver não esticar para A4.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Recibo ${r.sale_id.slice(0, 8)}</title>
    <style>
      @page { size: ${widthMm}mm auto; margin: 0; }
      html, body { margin: 0; padding: 0; }
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; color: #000 !important; }
      body { font-family: 'Courier New', 'Consolas', monospace; font-size: ${widthMm === 58 ? 11 : 12}px; font-weight: 700; line-height: 1.25; width: ${widthMm}mm; }
      .r { width: ${widthMm}mm; padding: 2mm; }
      h1 { font-size: 14px; text-align: center; margin: 2px 0; font-weight: 900; }
      .center { text-align: center; }
      .sep { border-top: 1px dashed #000; margin: 4px 0; }
      table { width: 100%; border-collapse: collapse; font-size: inherit; }
      td { vertical-align: top; padding: 0; font-weight: 700; }
      .totals td { padding: 2px 0; }
      .totals .lbl { text-align: right; padding-right: 8px; }
      .badge { display: inline-block; padding: 2px 6px; border: 2px solid #000; font-weight: 900; }
      .big { font-size: ${widthMm === 58 ? 14 : 16}px; font-weight: 900; }
      @media screen { body { background: #eee; padding: 20px; width: auto; } .r { background: #fff; margin: 0 auto; box-shadow: 0 2px 8px rgba(0,0,0,.15);} }
    </style></head><body><div class="r">
    <h1>${escape(r.store.name)}</h1>
    ${r.store.cnpj ? `<div class="center">CNPJ ${escape(r.store.cnpj)}</div>` : ""}
    ${r.store.address ? `<div class="center">${escape(r.store.address)}</div>` : ""}
    ${r.store.phone ? `<div class="center">${escape(r.store.phone)}</div>` : ""}
    ${r.header ? `<div class="center" style="margin-top:4px">${escape(r.header)}</div>` : ""}
    <div class="center" style="margin-top:6px"><span class="badge">${isFiscal ? "CUPOM FISCAL (NFC-e)" : "DOCUMENTO NÃO FISCAL"}</span></div>
    ${!isFiscal ? `<div class="center" style="font-size:9px">Não é documento fiscal · não substitui nota fiscal</div>` : ""}
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
      <tr><td class="lbl big">TOTAL</td><td class="big" style="text-align:right">${brl(r.total)}</td></tr>
      ${(r.payments && r.payments.length > 0
        ? `<tr><td colspan="2" class="lbl" style="text-align:left;padding-top:4px"><b>PAGAMENTOS</b></td></tr>` +
          r.payments.map((p) => `<tr><td class="lbl">${escape(p.label.toUpperCase())}</td><td style="text-align:right">${brl(p.amount)}</td></tr>${p.installments && p.installments > 1 ? `<tr><td colspan="2" style="text-align:right;font-size:9px">${p.installments}x de ${brl(p.amount / p.installments)}</td></tr>` : ""}`).join("") +
          `<tr><td class="lbl">RECEBIDO</td><td style="text-align:right">${brl(r.received ?? r.total)}</td></tr>`
        : `<tr><td class="lbl">${escape(r.payment_method.toUpperCase())}</td><td style="text-align:right">${brl(r.received ?? r.total)}</td></tr>`)}
      ${r.change && r.change > 0 ? `<tr><td class="lbl">TROCO</td><td style="text-align:right">${brl(r.change)}</td></tr>` : ""}
    </table>
    <div class="sep"></div>
    <div class="center">${escape(r.footer || "Obrigado pela preferência!")}</div>
    <div class="center" style="font-size:9px;margin-top:4px">Bastion POS</div>
    </div></body></html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Imprime o HTML térmico em um iframe oculto — evita popup blocker e faz o
 * navegador respeitar o @page (mm). O diálogo de impressão do navegador
 * AINDA aparece — para eliminá-lo é necessário o canal ESC/POS direto
 * (Agente Local ou WebUSB), que substitui o driver.
 */
export function printReceipt(html: string) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow?.document;
  if (!doc) { iframe.remove(); return; }
  doc.open(); doc.write(html); doc.close();
  const cleanup = () => setTimeout(() => iframe.remove(), 1000);
  iframe.contentWindow?.addEventListener("afterprint", cleanup, { once: true });
  const trigger = () => {
    try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); }
    catch (e) { console.warn("print failed", e); }
  };
  // Espera fontes/layout carregarem antes de disparar o print.
  setTimeout(trigger, 250);
  setTimeout(cleanup, 30000);
}
