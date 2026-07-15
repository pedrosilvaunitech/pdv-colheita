// Recibo — geração de HTML térmico configurável por blocos.
// O template (ver `receipt-template.ts`) define ordem, alinhamento, negrito,
// tamanho e textos livres de cada bloco. O mesmo template é consumido pelo
// gerador ESC/POS raw (`escpos.ts`) para que a impressão bata com a prévia.

import {
  defaultTemplate, loadTemplate,
  type ReceiptBlock, type ReceiptTemplate,
} from "./receipt-template";
import { getCurrentStoreIdSync } from "./current-store";

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

const num = (v: number, d = 2) => v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

function fakeChave(saleId: string): string {
  const hex = saleId.replace(/[^0-9a-f]/gi, "");
  let digits = "";
  for (const c of hex) digits += (parseInt(c, 16) % 10).toString();
  while (digits.length < 44) digits += "0";
  return digits.slice(0, 44);
}
function chaveGrouped(chave: string): string {
  return chave.match(/.{1,4}/g)?.join(" ") ?? chave;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Resolve template a usar: parâmetro > localStorage da loja atual > default.
function resolveTemplate(r: ReceiptData, tpl?: ReceiptTemplate): ReceiptTemplate {
  if (tpl) return tpl;
  try { return loadTemplate(getCurrentStoreIdSync(), r.document_type); }
  catch { return defaultTemplate(r.document_type); }
}

function sizeToPx(size: "sm" | "md" | "lg", widthMm: 58 | 80): number {
  const base = widthMm === 58 ? 10 : 11;
  return size === "sm" ? base - 2 : size === "lg" ? base + 3 : base;
}

// ─────────────────────────── render por bloco ───────────────────────────
function renderBlockHTML(b: ReceiptBlock, r: ReceiptData, widthMm: 58 | 80): string {
  if (!b.enabled) return "";
  const styleAttr = `text-align:${b.align};${b.bold ? "font-weight:800;" : ""}font-size:${sizeToPx(b.size, widthMm)}px;`;
  const wrap = (inner: string) => `<div class="blk" style="${styleAttr}">${inner}</div>`;
  const isFiscal = r.document_type === "fiscal";

  switch (b.kind) {
    case "separator":
      return `<div class="sep"></div>`;

    case "store_badge": {
      const label = isFiscal ? "NFC-e" : "RECIBO";
      return `<div class="blk" style="${styleAttr}"><span class="badge">${label}</span></div>`;
    }

    case "store_info": {
      const parts: string[] = [];
      parts.push(`<div style="font-weight:800;text-transform:uppercase">${escape(r.store.name)}</div>`);
      if (r.store.cnpj) parts.push(`<div>CNPJ: ${escape(r.store.cnpj)}</div>`);
      if (r.store.address) parts.push(`<div>${escape(r.store.address)}</div>`);
      if (r.store.phone) parts.push(`<div>${escape(r.store.phone)}</div>`);
      return wrap(parts.join(""));
    }

    case "header_msg": {
      const txt = b.text ?? r.header ?? "";
      if (!txt) return "";
      return wrap(escape(txt).replace(/\n/g, "<br/>"));
    }

    case "doc_title": {
      const t = isFiscal
        ? "DANFE NFC-e — Documento Auxiliar da Nota Fiscal Eletrônica para Consumidor Final"
        : "RECIBO DE VENDA — DOCUMENTO NÃO FISCAL";
      const sub = isFiscal
        ? "Não permite aproveitamento de crédito de ICMS"
        : "Não é documento fiscal · não substitui nota fiscal";
      return `<div class="blk" style="${styleAttr}"><div>${t}</div><div style="font-size:${sizeToPx("sm", widthMm)}px;font-weight:500">${sub}</div></div>`;
    }

    case "sale_meta": {
      const parts: string[] = [];
      parts.push(`Venda: <b>${r.sale_id.slice(0, 8).toUpperCase()}</b> · ${r.issued_at.toLocaleString("pt-BR")}`);
      if (r.operator) parts.push(`Operador: ${escape(r.operator)}`);
      return wrap(parts.join("<br/>"));
    }

    case "customer": {
      if (!r.customer?.name && !r.customer?.doc) return "";
      const t = `Cliente: ${escape(r.customer?.name ?? "")}${r.customer?.doc ? ` · ${escape(r.customer.doc)}` : ""}`;
      return wrap(t);
    }

    case "items": {
      const rows = r.items.map((it, idx) => {
        const code = (it.barcode ?? "").slice(-8) || String(idx + 1).padStart(8, "0");
        return `<tr class="item">
          <td class="c-item">${String(idx + 1).padStart(3, "0")}</td>
          <td class="c-code">${escape(code)}</td>
          <td class="c-desc">${escape(it.name)}</td>
          <td class="c-qty">${num(it.quantity, it.quantity % 1 === 0 ? 0 : 3)} UN</td>
          <td class="c-unit">UN x ${num(it.unit_price)}</td>
          <td class="c-total">${num(it.total)}</td>
        </tr>`;
      }).join("");
      return `<div class="blk" style="${styleAttr}"><table>
        <thead><tr>
          <th>ITEM</th><th>CÓDIGO</th><th>DESCRIÇÃO</th>
          <th class="num">Qtde.</th><th class="num">Valor Unit.</th><th class="num">Valor Total</th>
        </tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    }

    case "totals": {
      const itemsCount = r.items.reduce((s, it) => s + it.quantity, 0);
      const paidTotal = r.received ?? r.total;
      return `<div class="blk" style="${styleAttr}"><table class="totals">
        <tr><td class="lbl">QTDE. TOTAL DE ITENS:</td><td class="val">${num(itemsCount, itemsCount % 1 === 0 ? 0 : 3)}</td></tr>
        ${r.discount > 0 ? `<tr><td class="lbl">DESCONTO:</td><td class="val">- ${num(r.discount)}</td></tr>` : ""}
        <tr class="grand"><td class="lbl">VALOR TOTAL R$:</td><td class="val">${num(r.total)}</td></tr>
        <tr class="grand"><td class="lbl">FORMA PAGAMENTO:</td><td class="val">${num(paidTotal)}</td></tr>
      </table></div>`;
    }

    case "payments": {
      const rows = (r.payments ?? []).map((p) =>
        `<tr><td class="lbl">${escape(p.label)}</td><td class="val">${num(p.amount)}</td></tr>` +
        (p.installments && p.installments > 1
          ? `<tr><td colspan="2" style="text-align:right">${p.installments}x de ${num(p.amount / p.installments)}</td></tr>`
          : "")
      ).join("");
      const troco = r.change && r.change > 0
        ? `<tr><td class="lbl">TROCO:</td><td class="val">${num(r.change)}</td></tr>` : "";
      return `<div class="blk" style="${styleAttr}"><table class="totals">${rows}${troco}</table></div>`;
    }

    case "tributes":
      if (!isFiscal) return "";
      return wrap(`Tributos Totais Incidentes (Lei Federal 12.741/2012): <b>R$ 0,00</b>`);

    case "nfce_info":
      if (!isFiscal) return "";
      return wrap(`<b>NFC-e</b> nº ${escape(r.sale_id.slice(0, 9).toUpperCase())} · Série 001 · Emissão ${r.issued_at.toLocaleDateString("pt-BR")}`);

    case "consumer_via":
      if (!isFiscal) return "";
      return wrap("Via Consumidor");

    case "sefaz_link":
      if (!isFiscal) return "";
      return wrap("Consulta pela Chave de Acesso em www.nfce.sefaz.uf.gov.br");

    case "qr":
      if (!isFiscal) return "";
      return `<div class="blk" style="${styleAttr}"><div class="qr"><div class="placeholder">QR gerado<br/>após<br/>autorização<br/>SEFAZ</div></div></div>`;

    case "chave":
      if (!isFiscal) return "";
      return `<div class="blk" style="${styleAttr}"><div class="chave">${chaveGrouped(fakeChave(r.sale_id))}</div>${r.document_type === "fiscal" ? `<div style="font-size:${sizeToPx("sm", widthMm)}px;font-weight:800;margin-top:2px">⚠ Aguardando autorização SEFAZ · reemitir em Fiscal</div>` : ""}</div>`;

    case "footer_msg": {
      const txt = b.text ?? r.footer ?? "";
      if (!txt) return "";
      return wrap(escape(txt).replace(/\n/g, "<br/>"));
    }

    case "brand":
      return wrap("Bastion POS");

    case "custom_text":
      return wrap(escape(b.text ?? "").replace(/\n/g, "<br/>"));
  }
}

export function buildReceiptHTML(r: ReceiptData, tpl?: ReceiptTemplate): string {
  const widthMm = r.paper_width;
  const template = resolveTemplate(r, tpl);
  const body = template.blocks.map((b) => renderBlockHTML(b, r, widthMm)).join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Cupom ${r.sale_id.slice(0, 8)}</title>
    <style>
      @page { size: ${widthMm}mm auto; margin: 0; }
      html, body { margin: 0; padding: 0; }
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; color: #000 !important; }
      body { font-family: 'Arial', 'Helvetica', sans-serif; font-size: ${widthMm === 58 ? 10 : 11}px; line-height: 1.28; width: ${widthMm}mm; font-weight: 500; }
      .r { width: ${widthMm}mm; padding: 3mm 2.5mm; }
      .sep { border-top: 1px dashed #000; margin: 3px 0; }
      .blk { margin: 1px 0; }
      .badge { display:inline-block; border:2px solid #000; padding:3px 6px; font-weight:900; letter-spacing:0.5px; font-style:italic; }
      table { width: 100%; border-collapse: collapse; font-size: inherit; }
      thead th { text-align:left; font-weight:800; padding:2px; border-bottom:1px dashed #000; font-size:${widthMm === 58 ? 8 : 9}px; }
      thead th.num { text-align:right; }
      tr.item td { padding:2px; vertical-align:top; font-size:${widthMm === 58 ? 8 : 9}px; border-bottom:1px dashed #000; }
      td.c-item { width:8%; font-weight:800; }
      td.c-code { width:18%; font-family:'Courier New',monospace; }
      td.c-desc { width:34%; }
      td.c-qty  { width:12%; text-align:right; }
      td.c-unit { width:14%; text-align:right; }
      td.c-total{ width:14%; text-align:right; font-weight:800; }
      .totals tr td { padding:2px 0; }
      .totals .lbl { text-align:right; padding-right:6px; font-weight:700; }
      .totals .val { text-align:right; font-weight:800; }
      .totals .grand td { font-size:${widthMm === 58 ? 12 : 14}px; font-weight:900; padding:3px 0; }
      .chave { font-family:'Courier New',monospace; font-size:${widthMm === 58 ? 9 : 10}px; letter-spacing:0.5px; word-break:break-all; }
      .qr { width:${widthMm === 58 ? 32 : 40}mm; height:${widthMm === 58 ? 32 : 40}mm; margin:4px auto; border:1px solid #000;
            background: repeating-linear-gradient(45deg, #000 0 2px, #fff 2px 4px), #fff;
            display:flex; align-items:center; justify-content:center; }
      .qr .placeholder { background:#fff; padding:2px 4px; font-size:7px; font-weight:700; text-align:center; }
      @media screen { body { background:#eee; padding:20px; width:auto; } .r { background:#fff; margin:0 auto; box-shadow:0 2px 8px rgba(0,0,0,.15);} }
    </style></head><body><div class="r">${body}</div></body></html>`;
}

/**
 * Imprime o HTML térmico em um iframe oculto. O diálogo de impressão do
 * navegador ainda aparece — para eliminá-lo é necessário o canal ESC/POS
 * direto (Agente Local ou WebUSB), que substitui o driver.
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
  setTimeout(trigger, 250);
  setTimeout(cleanup, 30000);
}
