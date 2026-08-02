/**
 * Geração do PDF do relatório de vendas.
 *
 * Por que desenhar as tabelas à mão em vez de usar um plugin: o `jspdf` já está
 * no projeto e um plugin extra (autotable) traria peso e um layout genérico. Um
 * renderizador próprio de ~100 linhas nos dá cabeçalho repetido a cada página,
 * zebra, colunas numéricas alinhadas à direita e rodapé paginado — que é
 * exatamente o que faz um relatório parecer profissional.
 *
 * O resultado é um Blob. Quem chama decide se abre num visualizador dentro do
 * sistema (iframe) ou baixa — nunca imprimimos direto daqui.
 */

import { jsPDF } from "jspdf";
import {
  GRANULARITY_LABEL,
  brl,
  dateBR,
  dateTimeBR,
  pct,
  qty,
  type SalesReport,
} from "./sales-report";

/** Paleta alinhada ao tema escuro/corporativo do PDV (RGB 0–255). */
const COLOR = {
  ink: [15, 23, 42] as const,
  accent: [37, 99, 235] as const,
  soft: [241, 245, 249] as const,
  line: [203, 213, 225] as const,
  muted: [100, 116, 139] as const,
  white: [255, 255, 255] as const,
  positive: [22, 101, 52] as const,
};

export interface PdfStoreInfo {
  name?: string | null;
  fantasyName?: string | null;
  cnpj?: string | null;
  city?: string | null;
  state?: string | null;
}

interface Column {
  header: string;
  /** Largura relativa (peso). */
  width: number;
  align?: "left" | "right";
}

const MARGIN = 36;

export function buildSalesReportPdf(report: SalesReport, store: PdfStoreInfo = {}): Blob {
  const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - MARGIN * 2;

  const storeName = store.fantasyName || store.name || "Minha loja";
  const periodLabel = `${dateBR(report.from)} a ${dateBR(report.to)}`;

  let y = 0;

  /** Faixa de identificação no topo de cada página. */
  function drawHeader(): void {
    doc.setFillColor(...COLOR.ink);
    doc.rect(0, 0, pageWidth, 78, "F");

    doc.setTextColor(...COLOR.white);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text("Relatório de vendas", MARGIN, 32);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const subtitle = [storeName, store.cnpj ? `CNPJ ${store.cnpj}` : null]
      .filter(Boolean)
      .join("  ·  ");
    doc.text(subtitle, MARGIN, 48);
    doc.text(
      `${GRANULARITY_LABEL[report.granularity]}  ·  ${periodLabel}`,
      MARGIN,
      63,
    );

    const stamp = `Gerado em ${dateTimeBR(report.generatedAt)}`;
    doc.text(stamp, pageWidth - MARGIN - doc.getTextWidth(stamp), 63);

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
    doc.text(`${storeName} · Relatório gerado pelo PDV`, MARGIN, pageHeight - 26);
    const label = `Página ${pageNumber}`;
    doc.text(label, pageWidth - MARGIN - doc.getTextWidth(label), pageHeight - 26);
    doc.setTextColor(...COLOR.ink);
  }

  function newPage(): void {
    drawFooter(doc.getNumberOfPages());
    doc.addPage();
    drawHeader();
  }

  /** Garante espaço vertical; abre página nova quando não couber. */
  function ensure(space: number): void {
    if (y + space > pageHeight - 60) newPage();
  }

  function sectionTitle(text: string, hint?: string): void {
    ensure(40);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.ink);
    doc.text(text, MARGIN, y);
    // A largura precisa ser medida com a fonte do título ainda ativa; medir
    // depois de trocar para 8pt subestimava o espaço e sobrepunha os textos.
    const titleWidth = doc.getTextWidth(text);
    if (hint) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...COLOR.muted);
      doc.text(hint, MARGIN + titleWidth + 10, y);
    }

    y += 6;
    doc.setDrawColor(...COLOR.accent);
    doc.setLineWidth(1.2);
    doc.line(MARGIN, y, MARGIN + 46, y);
    y += 14;
    doc.setTextColor(...COLOR.ink);
  }

  /** Cartões de indicador em grade — a primeira coisa que o dono olha. */
  function kpiGrid(cards: { label: string; value: string; hint?: string }[]): void {
    const perRow = 4;
    const gap = 10;
    const cardWidth = (contentWidth - gap * (perRow - 1)) / perRow;
    const cardHeight = 52;

    for (let i = 0; i < cards.length; i += perRow) {
      ensure(cardHeight + 12);
      const row = cards.slice(i, i + perRow);
      row.forEach((card, idx) => {
        const x = MARGIN + idx * (cardWidth + gap);
        doc.setFillColor(...COLOR.soft);
        doc.setDrawColor(...COLOR.line);
        doc.setLineWidth(0.5);
        doc.roundedRect(x, y, cardWidth, cardHeight, 4, 4, "FD");

        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(...COLOR.muted);
        doc.text(card.label.toUpperCase(), x + 8, y + 15);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.setTextColor(...COLOR.ink);
        doc.text(fit(doc, card.value, cardWidth - 16), x + 8, y + 32);

        if (card.hint) {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7);
          doc.setTextColor(...COLOR.muted);
          doc.text(fit(doc, card.hint, cardWidth - 16), x + 8, y + 44);
        }
      });
      y += cardHeight + gap;
      doc.setTextColor(...COLOR.ink);
    }
    y += 4;
  }

  function table(columns: Column[], rows: string[][], totalRow?: string[]): void {
    const weight = columns.reduce((a, c) => a + c.width, 0);
    const widths = columns.map((c) => (c.width / weight) * contentWidth);
    const rowHeight = 17;

    const drawHeadRow = () => {
      ensure(rowHeight * 2);
      doc.setFillColor(...COLOR.accent);
      doc.rect(MARGIN, y, contentWidth, rowHeight, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(...COLOR.white);
      let x = MARGIN;
      columns.forEach((col, i) => {
        const w = widths[i]!;
        const text = fit(doc, col.header, w - 10);
        const tx = col.align === "right" ? x + w - 5 - doc.getTextWidth(text) : x + 5;
        doc.text(text, tx, y + 12);
        x += w;
      });
      y += rowHeight;
      doc.setTextColor(...COLOR.ink);
    };

    drawHeadRow();

    rows.forEach((row, index) => {
      if (y + rowHeight > pageHeight - 60) {
        newPage();
        drawHeadRow();
      }
      if (index % 2 === 1) {
        doc.setFillColor(...COLOR.soft);
        doc.rect(MARGIN, y, contentWidth, rowHeight, "F");
      }
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...COLOR.ink);
      let x = MARGIN;
      columns.forEach((col, i) => {
        const w = widths[i]!;
        const text = fit(doc, row[i] ?? "", w - 10);
        const tx = col.align === "right" ? x + w - 5 - doc.getTextWidth(text) : x + 5;
        doc.text(text, tx, y + 12);
        x += w;
      });
      y += rowHeight;
    });

    if (totalRow) {
      if (y + rowHeight > pageHeight - 60) {
        newPage();
        drawHeadRow();
      }
      doc.setFillColor(...COLOR.ink);
      doc.rect(MARGIN, y, contentWidth, rowHeight, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(...COLOR.white);
      let x = MARGIN;
      columns.forEach((col, i) => {
        const w = widths[i]!;
        const text = fit(doc, totalRow[i] ?? "", w - 10);
        const tx = col.align === "right" ? x + w - 5 - doc.getTextWidth(text) : x + 5;
        doc.text(text, tx, y + 12);
        x += w;
      });
      y += rowHeight;
      doc.setTextColor(...COLOR.ink);
    }

    doc.setDrawColor(...COLOR.line);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, y, MARGIN + contentWidth, y);
    y += 18;
  }

  // ── conteúdo ──────────────────────────────────────────────────────────────

  drawHeader();

  const t = report.totals;
  kpiGrid([
    { label: "Faturamento", value: brl(t.total), hint: `${t.sales} venda(s)` },
    { label: "Ticket médio", value: brl(t.avgTicket), hint: `${qty(t.avgItemsPerSale)} itens/venda` },
    { label: "Descontos", value: brl(t.discount), hint: t.gross ? `${pct(t.discount / t.gross)} do bruto` : "—" },
    { label: "Itens vendidos", value: qty(t.items) },
    {
      label: "Melhor dia",
      value: t.bestDay ? brl(t.bestDay.total) : "—",
      hint: t.bestDay?.label ?? "sem vendas no período",
    },
    { label: "Caixas ativos", value: String(report.registers.length) },
    { label: "Notas emitidas", value: String(t.fiscalIssued), hint: `${t.fiscalPending} pendente(s)` },
    { label: "Faturamento bruto", value: brl(t.gross) },
  ]);

  sectionTitle(GRANULARITY_LABEL[report.granularity], "faturamento consolidado por período");
  table(
    [
      { header: "Período", width: 3 },
      { header: "Vendas", width: 1, align: "right" },
      { header: "Itens", width: 1, align: "right" },
      { header: "Bruto", width: 1.6, align: "right" },
      { header: "Descontos", width: 1.6, align: "right" },
      { header: "Ticket médio", width: 1.6, align: "right" },
      { header: "Total", width: 1.8, align: "right" },
    ],
    report.periods.map((p) => [
      p.detail,
      String(p.sales),
      qty(p.items),
      brl(p.gross),
      brl(p.discount),
      brl(p.avgTicket),
      brl(p.total),
    ]),
    [
      "TOTAL",
      String(t.sales),
      qty(t.items),
      brl(t.gross),
      brl(t.discount),
      brl(t.avgTicket),
      brl(t.total),
    ],
  );

  sectionTitle("Por caixa", "quem faturou o quê no período");
  table(
    [
      { header: "Caixa", width: 2.4 },
      { header: "Operador(es)", width: 3 },
      { header: "Vendas", width: 1, align: "right" },
      { header: "Ticket médio", width: 1.5, align: "right" },
      { header: "Participação", width: 1.3, align: "right" },
      { header: "Total", width: 1.8, align: "right" },
    ],
    report.registers.map((r) => [
      r.name,
      r.operators.join(", ") || "—",
      String(r.sales),
      brl(r.avgTicket),
      pct(r.share),
      brl(r.total),
    ]),
    ["TOTAL", "", String(t.sales), brl(t.avgTicket), "100,0%", brl(t.total)],
  );

  if (report.payments.length) {
    sectionTitle("Formas de pagamento");
    table(
      [
        { header: "Forma", width: 3 },
        { header: "Lançamentos", width: 1.4, align: "right" },
        { header: "Participação", width: 1.4, align: "right" },
        { header: "Total", width: 1.8, align: "right" },
      ],
      report.payments.map((p) => [p.label, String(p.count), pct(p.share), brl(p.total)]),
    );
  }

  if (report.products.length) {
    sectionTitle("Produtos mais vendidos", "top 20 por faturamento");
    table(
      [
        { header: "Produto", width: 4 },
        { header: "Qtd.", width: 1.2, align: "right" },
        { header: "Participação", width: 1.4, align: "right" },
        { header: "Total", width: 1.8, align: "right" },
      ],
      report.products.slice(0, 20).map((p) => [p.name, qty(p.quantity), pct(p.share), brl(p.total)]),
    );
  }

  if (report.matrix.length > 1 && report.periods.length > 1) {
    // Com muitas colunas não cabe "R$ 1.234,56" em cada célula: omitimos o
    // símbolo (avisado no subtítulo) e usamos 7 períodos para manter legível.
    sectionTitle("Caixa × período", "cruzamento do faturamento — valores em R$");
    const periods = report.periods.slice(0, 7);
    const compact = (v: number) =>
      v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    table(
      [
        { header: "Caixa", width: 2.6 },
        ...periods.map((p) => ({ header: p.label, width: 1.3, align: "right" as const })),
        { header: "Total", width: 1.6, align: "right" as const },
      ],
      report.matrix.map((m) => [
        m.register,
        ...periods.map((p) => compact(m.byPeriod[p.key] ?? 0)),
        compact(m.total),
      ]),
    );
  }


  drawFooter(doc.getNumberOfPages());
  return doc.output("blob");
}

/** Trunca com reticências para nunca vazar da coluna. */
function fit(doc: jsPDF, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && doc.getTextWidth(`${out}…`) > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}
