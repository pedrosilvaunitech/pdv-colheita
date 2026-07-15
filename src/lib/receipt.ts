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
const num = (v: number, d = 2) => v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

// Chave de acesso NFC-e = 44 dígitos. Enquanto a emissão real não retornar,
// geramos um placeholder determinístico a partir do sale_id para manter o layout.
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

export function buildReceiptHTML(r: ReceiptData): string {
  const widthMm = r.paper_width;
  const isFiscal = r.document_type === "fiscal";
  const chave = isFiscal ? fakeChave(r.sale_id) : "";

  // Formata linha de item no padrão DANFE NFC-e (ITEM CÓDIGO DESCRIÇÃO QTD VLR UN VLR TOTAL)
  const rows = r.items.map((it, idx) => {
    const code = (it.barcode ?? "").padStart(0, "0").slice(-8) || String(idx + 1).padStart(8, "0");
    return `
      <tr class="item">
        <td class="c-item">${String(idx + 1).padStart(3, "0")}</td>
        <td class="c-code">${escape(code)}</td>
        <td class="c-desc">${escape(it.name)}</td>
        <td class="c-qty">${num(it.quantity, it.quantity % 1 === 0 ? 0 : 3)} UN</td>
        <td class="c-unit">UN x ${num(it.unit_price)}</td>
        <td class="c-total">${num(it.total)}</td>
      </tr>`;
  }).join("");

  const itemsCount = r.items.reduce((s, it) => s + it.quantity, 0);
  const paidTotal = r.received ?? r.total;

  const badgeTitle = isFiscal ? "NFC-e" : "RECIBO";
  const docTitle = isFiscal
    ? "DANFE NFC-e — Documento Auxiliar da Nota Fiscal Eletrônica para Consumidor Final"
    : "RECIBO DE VENDA — DOCUMENTO NÃO FISCAL";
  const docSubtitle = isFiscal
    ? "Não permite aproveitamento de crédito de ICMS"
    : "Não é documento fiscal · não substitui nota fiscal";

  return `<!doctype html><html><head><meta charset="utf-8"><title>${badgeTitle} ${r.sale_id.slice(0, 8)}</title>
    <style>
      @page { size: ${widthMm}mm auto; margin: 0; }
      html, body { margin: 0; padding: 0; }
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; color: #000 !important; }
      body { font-family: 'Arial', 'Helvetica', sans-serif; font-size: ${widthMm === 58 ? 10 : 11}px; line-height: 1.28; width: ${widthMm}mm; font-weight: 500; }
      .r { width: ${widthMm}mm; padding: 3mm 2.5mm; }
      .sep { border-top: 1px dashed #000; margin: 3px 0; }
      .center { text-align: center; }
      .bold { font-weight: 800; }
      .small { font-size: ${widthMm === 58 ? 8 : 9}px; }
      .head { display: flex; gap: 6px; align-items: flex-start; }
      .badge {
        border: 2px solid #000; padding: 3px 6px; font-weight: 900;
        font-size: ${widthMm === 58 ? 14 : 16}px; letter-spacing: 0.5px;
        flex: 0 0 auto; font-style: italic;
      }
      .store { flex: 1; font-size: ${widthMm === 58 ? 9 : 10}px; line-height: 1.25; }
      .store .name { font-weight: 800; text-transform: uppercase; }
      .doc-title { font-weight: 800; text-align: center; margin: 4px 0 2px; line-height: 1.2; }
      .doc-sub { font-size: ${widthMm === 58 ? 8 : 9}px; text-align: center; }
      table { width: 100%; border-collapse: collapse; font-size: inherit; }
      thead th {
        text-align: left; font-weight: 800; padding: 2px 2px;
        border-bottom: 1px dashed #000; font-size: ${widthMm === 58 ? 8 : 9}px;
      }
      thead th.num { text-align: right; }
      tr.item td { padding: 2px 2px; vertical-align: top; font-size: ${widthMm === 58 ? 8 : 9}px; border-bottom: 1px dashed #000; }
      td.c-item { width: 8%; font-weight: 800; }
      td.c-code { width: 18%; font-family: 'Courier New', monospace; }
      td.c-desc { width: 34%; }
      td.c-qty { width: 12%; text-align: right; }
      td.c-unit { width: 14%; text-align: right; }
      td.c-total { width: 14%; text-align: right; font-weight: 800; }
      .totals { margin-top: 2px; }
      .totals tr td { padding: 2px 0; }
      .totals .lbl { text-align: right; padding-right: 6px; font-weight: 700; }
      .totals .val { text-align: right; font-weight: 800; }
      .totals .grand td { font-size: ${widthMm === 58 ? 12 : 14}px; font-weight: 900; padding: 3px 0; }
      .chave { font-family: 'Courier New', monospace; text-align: center; font-size: ${widthMm === 58 ? 9 : 10}px; letter-spacing: 0.5px; word-break: break-all; }
      .qr {
        width: ${widthMm === 58 ? 32 : 40}mm; height: ${widthMm === 58 ? 32 : 40}mm;
        margin: 4px auto; border: 1px solid #000;
        background:
          repeating-linear-gradient(45deg, #000 0 2px, #fff 2px 4px),
          #fff;
        display: flex; align-items: center; justify-content: center;
      }
      .qr .placeholder { background: #fff; padding: 2px 4px; font-size: 7px; font-weight: 700; text-align: center; }
      @media screen { body { background: #eee; padding: 20px; width: auto; } .r { background: #fff; margin: 0 auto; box-shadow: 0 2px 8px rgba(0,0,0,.15);} }
    </style></head><body><div class="r">

    <div class="head">
      <div class="badge">${badgeTitle}</div>
      <div class="store">
        <div class="name">${escape(r.store.name)}</div>
        ${r.store.cnpj ? `<div>CNPJ: ${escape(r.store.cnpj)}</div>` : ""}
        ${r.store.address ? `<div>${escape(r.store.address)}</div>` : ""}
        ${r.store.phone ? `<div>${escape(r.store.phone)}</div>` : ""}
      </div>
    </div>
    ${r.header ? `<div class="center small" style="margin-top:3px">${escape(r.header)}</div>` : ""}
    <div class="sep"></div>

    <div class="doc-title">${docTitle}</div>
    <div class="doc-sub">${docSubtitle}</div>
    <div class="sep"></div>

    <table>
      <thead>
        <tr>
          <th>ITEM</th><th>CÓDIGO</th><th>DESCRIÇÃO</th>
          <th class="num">Qtde.</th><th class="num">Valor Unit.</th><th class="num">Valor Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="totals">
      <tr><td class="lbl">QTDE. TOTAL DE ITENS:</td><td class="val">${num(itemsCount, itemsCount % 1 === 0 ? 0 : 3)}</td></tr>
      ${r.discount > 0 ? `<tr><td class="lbl">DESCONTO:</td><td class="val">- ${num(r.discount)}</td></tr>` : ""}
      <tr class="grand"><td class="lbl">VALOR TOTAL R$:</td><td class="val">${num(r.total)}</td></tr>
      <tr class="grand"><td class="lbl">FORMA PAGAMENTO:</td><td class="val">${num(paidTotal)}</td></tr>
      ${(r.payments ?? []).map((p) => `<tr><td class="lbl small">${escape(p.label)}</td><td class="val small">${num(p.amount)}</td></tr>${p.installments && p.installments > 1 ? `<tr><td colspan="2" style="text-align:right" class="small">${p.installments}x de ${num(p.amount / p.installments)}</td></tr>` : ""}`).join("")}
      ${r.change && r.change > 0 ? `<tr><td class="lbl">TROCO:</td><td class="val">${num(r.change)}</td></tr>` : ""}
    </table>
    <div class="sep"></div>

    ${isFiscal ? `
      <div class="small center">Tributos Totais Incidentes (Lei Federal 12.741/2012): <b>R$ 0,00</b></div>
      <div class="sep"></div>
      <div class="center small"><b>NFC-e</b> nº ${escape(r.sale_id.slice(0, 9).toUpperCase())} · Série 001 · Emissão ${r.issued_at.toLocaleDateString("pt-BR")}</div>
      <div class="center small">Via Consumidor</div>
      <div class="center small">Consulta pela Chave de Acesso em www.nfce.sefaz.uf.gov.br</div>
      <div class="sep"></div>
      <div class="center small">Consulta via Leitor de QR Code</div>
      <div class="qr"><div class="placeholder">QR gerado<br/>após<br/>autorização<br/>SEFAZ</div></div>
      <div class="sep"></div>
      <div class="chave">${chaveGrouped(chave)}</div>
      <div class="center small" style="margin-top:4px">Este documento é uma representação simplificada da NFC-e.</div>
      <div class="center small" style="color:#000;font-weight:800;margin-top:2px">⚠ Aguardando autorização SEFAZ · reemitir em Fiscal</div>
    ` : `
      <div class="center small">Venda: <b>${r.sale_id.slice(0, 8).toUpperCase()}</b> · ${r.issued_at.toLocaleString("pt-BR")}</div>
      ${r.operator ? `<div class="center small">Operador: ${escape(r.operator)}</div>` : ""}
      ${r.customer?.name || r.customer?.doc ? `<div class="center small">Cliente: ${escape(r.customer?.name ?? "")}${r.customer?.doc ? ` · ${escape(r.customer.doc)}` : ""}</div>` : ""}
      <div class="sep"></div>
      <div class="center">${escape(r.footer || "Obrigado pela preferência!")}</div>
    `}
    <div class="center small" style="margin-top:4px">Bastion POS</div>
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
