/**
 * PDF do pedido de compra por fornecedor.
 *
 * Gerado a partir das sugestões da tela de Reposição: o comprador escolhe o
 * fornecedor (ou todos) e recebe um documento pronto para enviar por
 * WhatsApp/e-mail, com itens, quantidades, custo estimado e as condições de
 * pagamento cadastradas.
 *
 * Desenhamos as tabelas à mão com o `jspdf` já presente no projeto — mesma
 * abordagem do relatório de vendas — para manter cabeçalho repetido, zebra e
 * rodapé paginado sem dependências extras. Retornamos um Blob: quem chama
 * decide entre visualizar num iframe ou baixar.
 */

import { jsPDF } from "jspdf";

const COLOR = {
  ink: [15, 23, 42] as const,
  accent: [37, 99, 235] as const,
  soft: [241, 245, 249] as const,
  line: [203, 213, 225] as const,
  muted: [100, 116, 139] as const,
  white: [255, 255, 255] as const,
};

const MARGIN = 36;

export interface PurchaseOrderStore {
  name?: string | null;
  fantasyName?: string | null;
  cnpj?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
}

export interface PurchaseOrderItem {
  name: string;
  barcode?: string | null;
  supplierSku?: string | null;
  unit: string;
  quantity: number;
  unitCost: number;
  currentStock?: number | null;
  coverageDays?: number | null;
}

export interface PurchaseOrderSupplier {
  id: string;
  name: string;
  cnpj?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  paymentSummary?: string | null;
  pixKey?: string | null;
  leadTimeDays?: number | null;
}

export interface PurchaseOrderBlock {
  supplier: PurchaseOrderSupplier;
  items: PurchaseOrderItem[];
}

const brl = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 });

const num = (n: number, digits = 0) =>
  n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const dateTimeBR = (d: Date) =>
  d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

/** Total estimado de um bloco de pedido. */
export function blockTotal(block: PurchaseOrderBlock): number {
  return block.items.reduce((acc, it) => acc + it.quantity * it.unitCost, 0);
}

export function buildPurchaseOrderPdf(
  blocks: PurchaseOrderBlock[],
  store: PurchaseOrderStore = {},
  options: { notes?: string } = {},
): Blob {
  const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - MARGIN * 2;
  const storeName = store.fantasyName || store.name || "Minha loja";
  const generatedAt = new Date();
  const orderCode = `PC-${generatedAt.toISOString().slice(0, 10).replace(/-/g, "")}`;

  let y = 0;

  function drawHeader(): void {
    doc.setFillColor(...COLOR.ink);
    doc.rect(0, 0, pageWidth, 78, "F");
    doc.setTextColor(...COLOR.white);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text("Pedido de compra", MARGIN, 32);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const line1 = [storeName, store.cnpj ? `CNPJ ${store.cnpj}` : null, store.phone]
      .filter(Boolean)
      .join("  ·  ");
    doc.text(line1, MARGIN, 48);
    doc.text(`Nº ${orderCode}  ·  Emitido em ${dateTimeBR(generatedAt)}`, MARGIN, 63);
    doc.setTextColor(...COLOR.ink);
    y = 100;
  }

  function drawFooter(pageNumber: number): void {
    doc.setDrawColor(...COLOR.line);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, pageHeight - 40, pageWidth - MARGIN, pageHeight - 40);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.muted);
    doc.text(`${storeName} · Pedido gerado pelo PDV`, MARGIN, pageHeight - 26);
    const label = `Página ${pageNumber}`;
    doc.text(label, pageWidth - MARGIN - doc.getTextWidth(label), pageHeight - 26);
    doc.setTextColor(...COLOR.ink);
  }

  function newPage(): void {
    drawFooter(doc.getNumberOfPages());
    doc.addPage();
    drawHeader();
  }

  function ensure(space: number): void {
    if (y + space > pageHeight - 60) newPage();
  }

  /** Cartão com dados do fornecedor e condições comerciais. */
  function drawSupplierCard(supplier: PurchaseOrderSupplier): void {
    const rows = [
      supplier.cnpj ? `CNPJ: ${supplier.cnpj}` : null,
      supplier.contactName ? `Contato: ${supplier.contactName}` : null,
      [supplier.phone, supplier.email].filter(Boolean).join("  ·  ") || null,
      supplier.paymentSummary ? `Pagamento: ${supplier.paymentSummary}` : null,
      supplier.pixKey ? `Pix: ${supplier.pixKey}` : null,
      supplier.leadTimeDays && supplier.leadTimeDays > 0
        ? `Prazo de entrega informado: ${supplier.leadTimeDays} dia(s)`
        : null,
    ].filter((v): v is string => Boolean(v));

    const height = 34 + rows.length * 13;
    ensure(height + 20);

    doc.setFillColor(...COLOR.soft);
    doc.setDrawColor(...COLOR.line);
    doc.rect(MARGIN, y, contentWidth, height, "FD");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...COLOR.ink);
    doc.text(supplier.name, MARGIN + 12, y + 20);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.muted);
    rows.forEach((row, i) => {
      doc.text(row, MARGIN + 12, y + 36 + i * 13);
    });
    doc.setTextColor(...COLOR.ink);
    y += height + 14;
  }

  function drawItems(items: PurchaseOrderItem[]): number {
    const weights = [0.34, 0.14, 0.12, 0.1, 0.13, 0.17];
    const widths = weights.map((w) => contentWidth * w);
    const headers = ["Produto", "Código", "Estoque", "Qtd.", "Custo un.", "Total"];
    const aligns: Array<"left" | "right"> = ["left", "left", "right", "right", "right", "right"];

    const drawHeadRow = () => {
      ensure(26);
      doc.setFillColor(...COLOR.ink);
      doc.rect(MARGIN, y, contentWidth, 20, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(...COLOR.white);
      let x = MARGIN;
      headers.forEach((h, i) => {
        const w = widths[i];
        const tx = aligns[i] === "right" ? x + w - 6 - doc.getTextWidth(h) : x + 6;
        doc.text(h, tx, y + 13.5);
        x += w;
      });
      doc.setTextColor(...COLOR.ink);
      y += 20;
    };

    drawHeadRow();

    let total = 0;
    items.forEach((item, index) => {
      if (y + 20 > pageHeight - 60) {
        newPage();
        drawHeadRow();
      }
      const lineTotal = item.quantity * item.unitCost;
      total += lineTotal;

      if (index % 2 === 1) {
        doc.setFillColor(...COLOR.soft);
        doc.rect(MARGIN, y, contentWidth, 18, "F");
      }

      const cells = [
        item.name,
        item.supplierSku || item.barcode || "—",
        item.currentStock == null ? "—" : num(item.currentStock, 0),
        `${num(item.quantity, 0)} ${item.unit}`,
        brl(item.unitCost),
        brl(lineTotal),
      ];

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      let x = MARGIN;
      cells.forEach((cell, i) => {
        const w = widths[i];
        let text = cell;
        while (doc.getTextWidth(text) > w - 12 && text.length > 4) {
          text = `${text.slice(0, -2)}…`;
        }
        const tx = aligns[i] === "right" ? x + w - 6 - doc.getTextWidth(text) : x + 6;
        doc.text(text, tx, y + 12.5);
        x += w;
      });
      y += 18;
    });

    ensure(28);
    doc.setDrawColor(...COLOR.line);
    doc.line(MARGIN, y, pageWidth - MARGIN, y);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    const totalLabel = `Total estimado: ${brl(total)}`;
    doc.setTextColor(...COLOR.accent);
    doc.text(totalLabel, pageWidth - MARGIN - doc.getTextWidth(totalLabel), y + 16);
    doc.setTextColor(...COLOR.ink);
    y += 30;

    return total;
  }

  drawHeader();

  if (blocks.length === 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text("Nenhum item sugerido para reposição no filtro atual.", MARGIN, y);
  }

  let grandTotal = 0;
  blocks.forEach((block, index) => {
    if (index > 0) newPage();
    drawSupplierCard(block.supplier);
    grandTotal += drawItems(block.items);
  });

  if (blocks.length > 1) {
    ensure(40);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    const label = `Total geral do pedido: ${brl(grandTotal)}`;
    doc.text(label, pageWidth - MARGIN - doc.getTextWidth(label), y + 14);
    y += 34;
  }

  if (options.notes?.trim()) {
    ensure(50);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text("Observações", MARGIN, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...COLOR.muted);
    const lines = doc.splitTextToSize(options.notes.trim(), contentWidth);
    doc.text(lines, MARGIN, y + 14);
    doc.setTextColor(...COLOR.ink);
    y += 14 + lines.length * 12;
  }

  drawFooter(doc.getNumberOfPages());
  return doc.output("blob");
}

/** Nome de arquivo estável para download. */
export function purchaseOrderFileName(blocks: PurchaseOrderBlock[]): string {
  const day = new Date().toISOString().slice(0, 10);
  if (blocks.length === 1) {
    const slug = blocks[0].supplier.name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .toLowerCase()
      .slice(0, 40);
    return `pedido-compra-${slug}-${day}.pdf`;
  }
  return `pedido-compra-${day}.pdf`;
}
