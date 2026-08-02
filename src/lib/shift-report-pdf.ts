/**
 * Geração do PDF do relatório por turno (fechamento de caixa).
 *
 * Por que um PDF em vez de `window.print()`: o Ctrl+P imprime a tela inteira do
 * sistema — menu lateral, cabeçalho, cores de tema escuro e tabelas com scroll
 * cortado. O resultado é ilegível e gasta tinta. Aqui desenhamos um documento
 * A4 próprio, no mesmo padrão visual do relatório de vendas (faixa de
 * identificação, KPIs, tabelas zebradas e rodapé paginado).
 *
 * O retorno é um Blob: quem chama decide se exibe num `<iframe>` dentro do
 * sistema ou baixa. Nunca disparamos impressão daqui.
 */

import { jsPDF } from "jspdf";
import type { PdfStoreInfo } from "./sales-report-pdf";

/** Paleta alinhada ao relatório de vendas (RGB 0–255). */
const COLOR = {
  ink: [15, 23, 42] as const,
  accent: [37, 99, 235] as const,
  soft: [241, 245, 249] as const,
  line: [203, 213, 225] as const,
  muted: [100, 116, 139] as const,
  white: [255, 255, 255] as const,
  danger: [153, 27, 27] as const,
};

const MARGIN = 36;

export interface ShiftPdfRegister {
  terminal: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingAmount: number;
  closingAmount: number | null;
  expectedAmount: number | null;
  difference: number | null;
}

export interface ShiftPdfDetail {
  salesCount: number;
  salesTotal: number;
  methods: { method: string; count: number; amount: number }[];
  sangrias: number;
  suprimentos: number;
  expectedCash: number;
  drawer: {
    created_at: string;
    reason: string;
    automatic: boolean;
    channel: string | null;
    success: boolean;
  }[];
  drawerByReason: [string, number][];
  drawerFailures: number;
}

export interface ShiftPdfInput {
  register: ShiftPdfRegister;
  detail: ShiftPdfDetail;
  /** Rótulos legíveis dos motivos de abertura de gaveta. */
  reasonLabel?: Record<string, string>;
  store?: PdfStoreInfo;
  /** Quem gerou o documento — útil na trilha de conferência do caixa. */
  operator?: string | null;
}

interface Column {
  header: string;
  width: number;
  align?: "left" | "right";
}

export function buildShiftReportPdf(input: ShiftPdfInput): Blob {
  const { register, detail } = input;
  const reasonLabel = input.reasonLabel ?? {};
  const store = input.store ?? {};

  const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - MARGIN * 2;

  const storeName = store.fantasyName || store.name || "Minha loja";
  const isOpen = !register.closedAt;
  const generatedAt = new Date();

  let y = 0;

  function drawHeader(): void {
    doc.setFillColor(...COLOR.ink);
    doc.rect(0, 0, pageWidth, 78, "F");

    doc.setTextColor(...COLOR.white);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text("Relatório por turno", MARGIN, 32);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const subtitle = [storeName, store.cnpj ? `CNPJ ${store.cnpj}` : null]
      .filter(Boolean)
      .join("  ·  ");
    doc.text(subtitle, MARGIN, 48);
    doc.text(
      `${register.terminal}  ·  ${dt(register.openedAt)} até ${register.closedAt ? dt(register.closedAt) : "agora (turno aberto)"}`,
      MARGIN,
      63,
    );

    const stamp = `Gerado em ${dt(generatedAt.toISOString())}`;
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
    doc.text(
      [storeName, input.operator ? `Conferido por ${input.operator}` : null, "Relatório gerado pelo PDV"]
        .filter(Boolean)
        .join(" · "),
      MARGIN,
      pageHeight - 26,
    );
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

  function sectionTitle(text: string, hint?: string): void {
    ensure(40);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.ink);
    doc.text(text, MARGIN, y);
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

  function kpiGrid(cards: { label: string; value: string; hint?: string; alert?: boolean }[]): void {
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
        doc.setDrawColor(...(card.alert ? COLOR.danger : COLOR.line));
        doc.setLineWidth(card.alert ? 1 : 0.5);
        doc.roundedRect(x, y, cardWidth, cardHeight, 4, 4, "FD");

        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(...COLOR.muted);
        doc.text(card.label.toUpperCase(), x + 8, y + 15);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.setTextColor(...(card.alert ? COLOR.danger : COLOR.ink));
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

  function table(columns: Column[], rows: string[][], totalRow?: string[], emptyText?: string): void {
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

    const drawRow = (cells: string[], index: number) => {
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
        const text = fit(doc, cells[i] ?? "", w - 10);
        const tx = col.align === "right" ? x + w - 5 - doc.getTextWidth(text) : x + 5;
        doc.text(text, tx, y + 12);
        x += w;
      });
      y += rowHeight;
    };

    drawHeadRow();

    if (rows.length === 0) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8.5);
      doc.setTextColor(...COLOR.muted);
      doc.text(emptyText ?? "Sem registros neste turno.", MARGIN + 5, y + 12);
      y += rowHeight;
      doc.setTextColor(...COLOR.ink);
    } else {
      rows.forEach(drawRow);
    }

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

  /** Bloco de conferência assinado à mão — o caixa fecha no papel. */
  function signatureBlock(): void {
    ensure(96);
    const counted = register.closingAmount;
    const boxHeight = 86;
    doc.setDrawColor(...COLOR.line);
    doc.setLineWidth(0.5);
    doc.roundedRect(MARGIN, y, contentWidth, boxHeight, 4, 4, "S");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.ink);
    doc.text("Conferência do caixa", MARGIN + 10, y + 18);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.muted);
    doc.text(
      counted == null
        ? "Dinheiro contado: __________________________     Diferença: __________________________"
        : `Dinheiro contado: ${brl(counted)}     Diferença apurada: ${brl(register.difference ?? 0)}`,
      MARGIN + 10,
      y + 36,
    );

    const half = contentWidth / 2 - 20;
    doc.setDrawColor(...COLOR.ink);
    doc.line(MARGIN + 10, y + 64, MARGIN + 10 + half, y + 64);
    doc.line(MARGIN + contentWidth / 2 + 10, y + 64, MARGIN + contentWidth / 2 + 10 + half, y + 64);
    doc.setFontSize(7.5);
    doc.setTextColor(...COLOR.muted);
    doc.text("Operador do caixa", MARGIN + 10, y + 76);
    doc.text("Responsável / gerente", MARGIN + contentWidth / 2 + 10, y + 76);

    y += boxHeight + 16;
    doc.setTextColor(...COLOR.ink);
  }

  // ── conteúdo ──────────────────────────────────────────────────────────────

  drawHeader();

  const methodsTotal = detail.methods.reduce((s, m) => s + m.amount, 0);
  const diff = Number(register.difference ?? 0);

  kpiGrid([
    { label: "Vendas do turno", value: brl(detail.salesTotal), hint: `${detail.salesCount} venda(s)` },
    { label: "Abertura", value: brl(register.openingAmount), hint: dt(register.openedAt) },
    {
      label: "Dinheiro esperado",
      value: brl(detail.expectedCash),
      hint: `sangria ${brl(detail.sangrias)} · suprimento ${brl(detail.suprimentos)}`,
    },
    {
      label: isOpen ? "Turno em andamento" : "Diferença no fechamento",
      value: isOpen ? "—" : brl(diff),
      hint: isOpen
        ? "caixa aberto"
        : `fechado ${dt(register.closedAt!)} · contado ${brl(register.closingAmount ?? 0)}`,
      alert: !isOpen && diff !== 0,
    },
    { label: "Ticket médio", value: brl(detail.salesCount ? detail.salesTotal / detail.salesCount : 0) },
    { label: "Recebimentos", value: brl(methodsTotal), hint: `${detail.methods.length} forma(s)` },
    { label: "Aberturas de gaveta", value: String(detail.drawer.length) },
    {
      label: "Falhas de gaveta",
      value: String(detail.drawerFailures),
      hint: detail.drawerFailures > 0 ? "verificar hardware" : "sem falhas",
      alert: detail.drawerFailures > 0,
    },
  ]);

  sectionTitle("Formas de pagamento", "recebimentos consolidados do turno");
  table(
    [
      { header: "Forma", width: 3 },
      { header: "Recebimentos", width: 1.4, align: "right" },
      { header: "Participação", width: 1.4, align: "right" },
      { header: "Total", width: 1.8, align: "right" },
    ],
    detail.methods.map((m) => [
      capitalize(m.method),
      String(m.count),
      methodsTotal ? pct(m.amount / methodsTotal) : "—",
      brl(m.amount),
    ]),
    [
      "TOTAL",
      String(detail.methods.reduce((s, m) => s + m.count, 0)),
      detail.methods.length ? "100,0%" : "—",
      brl(methodsTotal),
    ],
    "Sem recebimentos neste turno.",
  );

  sectionTitle("Movimentações de caixa", "sangrias e suprimentos que afetam o dinheiro esperado");
  table(
    [
      { header: "Movimentação", width: 3 },
      { header: "Valor", width: 1.8, align: "right" },
    ],
    [
      ["Abertura (fundo de troco)", brl(register.openingAmount)],
      ["Vendas em dinheiro", brl(detail.methods.find((m) => m.method === "dinheiro")?.amount ?? 0)],
      ["Suprimentos", brl(detail.suprimentos)],
      ["Sangrias", `- ${brl(detail.sangrias)}`],
    ],
    ["DINHEIRO ESPERADO EM GAVETA", brl(detail.expectedCash)],
  );

  sectionTitle("Aberturas de gaveta", "auditoria de acesso ao dinheiro durante o turno");
  if (detail.drawerByReason.length) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.muted);
    const resume = detail.drawerByReason
      .map(([reason, count]) => `${reasonLabel[reason] ?? reason}: ${count}`)
      .join("   ·   ");
    doc.text(fit(doc, resume, contentWidth), MARGIN, y);
    y += 14;
    doc.setTextColor(...COLOR.ink);
  }
  table(
    [
      { header: "Hora", width: 1.1 },
      { header: "Motivo", width: 3 },
      { header: "Origem", width: 1.2 },
      { header: "Canal", width: 1.2 },
      { header: "Resultado", width: 1.2, align: "right" },
    ],
    detail.drawer.map((ev) => [
      dt(ev.created_at),
      reasonLabel[ev.reason] ?? ev.reason,
      ev.automatic ? "automática" : "manual",
      (ev.channel ?? "—").toUpperCase(),
      ev.success ? "ok" : "FALHA",
    ]),
    undefined,
    "Nenhuma abertura registrada no período do turno.",
  );

  signatureBlock();

  drawFooter(doc.getNumberOfPages());
  return doc.output("blob");
}

/** Nome de arquivo previsível para download e arquivamento. */
export function shiftReportFileName(register: ShiftPdfRegister): string {
  const stamp = new Date(register.openedAt)
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, "");
  const terminal = register.terminal.replace(/[^\w-]+/g, "-").toLowerCase();
  return `turno-${terminal || "caixa"}-${stamp}.pdf`;
}

function fit(doc: jsPDF, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && doc.getTextWidth(`${out}…`) > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

function brl(v: number): string {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function pct(v: number): string {
  return `${(Number(v || 0) * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}
function dt(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}
function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
