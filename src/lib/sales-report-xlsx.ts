/**
 * Exportação XLSX do relatório de vendas.
 *
 * O que faz a planilha ser "bonita" e útil, e não um CSV disfarçado:
 *  - abas separadas (Resumo, período, caixa, pagamentos, produtos, base);
 *  - cabeçalhos coloridos, painel congelado, autofiltro e zebra;
 *  - números com formato de moeda/percentual do Brasil — o contador consegue
 *    somar sem reformatar nada;
 *  - **fórmulas de verdade**, não valores calculados no navegador: totais em
 *    SUBTOTAL/SUM e uma área de consulta com PROCV (VLOOKUP) para o lojista
 *    digitar o nome do caixa e ver os números na hora.
 *
 * Sobre PROCV: escrevemos a fórmula em inglês (`VLOOKUP`) porque é o que o
 * formato do arquivo armazena; o Excel em português exibe automaticamente como
 * `PROCV`. Escrever "PROCV" no XML geraria #NOME?.
 */

import ExcelJS from "exceljs";
import { GRANULARITY_LABEL, dateBR, dateTimeBR, type SalesReport } from "./sales-report";

const THEME = {
  ink: "FF0F172A",
  accent: "FF2563EB",
  zebra: "FFF1F5F9",
  border: "FFCBD5E1",
  muted: "FF64748B",
  totalFill: "FFE2E8F0",
} as const;

const FONT = "Arial";
const MONEY = 'R$ #,##0.00;[Red]-R$ #,##0.00;"-"';
const PERCENT = "0.0%";
const NUMBER = "#,##0.###";

export interface SalesXlsxStore {
  name?: string | null;
  fantasyName?: string | null;
  cnpj?: string | null;
}

/** Impede que texto do banco seja interpretado como fórmula pelo Excel. */
function safeText(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

interface ColumnSpec {
  header: string;
  key: string;
  width: number;
  format?: string;
}

/** Cria a faixa de título padrão no topo de uma aba. */
function titleBand(
  sheet: ExcelJS.Worksheet,
  title: string,
  subtitle: string,
  columnCount: number,
): void {
  sheet.mergeCells(1, 1, 1, columnCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { name: FONT, size: 14, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.ink } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, columnCount);
  const subCell = sheet.getCell(2, 1);
  subCell.value = subtitle;
  subCell.font = { name: FONT, size: 9, color: { argb: THEME.muted } };
  subCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  sheet.getRow(2).height = 18;
}

/**
 * Escreve cabeçalho + linhas de uma tabela e devolve as posições, para quem
 * chama montar fórmulas (SUBTOTAL, PROCV) apontando para o intervalo certo.
 */
function writeTable(
  sheet: ExcelJS.Worksheet,
  headerRow: number,
  columns: ColumnSpec[],
  rows: (string | number | null)[][],
): { firstDataRow: number; lastDataRow: number } {
  const header = sheet.getRow(headerRow);
  columns.forEach((col, i) => {
    const cell = header.getCell(i + 1);
    cell.value = col.header;
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.accent } };
    cell.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "right", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: THEME.border } },
      bottom: { style: "thin", color: { argb: THEME.border } },
      left: { style: "thin", color: { argb: THEME.border } },
      right: { style: "thin", color: { argb: THEME.border } },
    };
    sheet.getColumn(i + 1).width = col.width;
  });
  header.height = 24;

  const firstDataRow = headerRow + 1;
  rows.forEach((values, rowIndex) => {
    const row = sheet.getRow(firstDataRow + rowIndex);
    columns.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      const raw = values[i];
      cell.value = typeof raw === "string" ? safeText(raw) : (raw ?? 0);
      cell.font = { name: FONT, size: 10 };
      if (col.format) cell.numFmt = col.format;
      cell.alignment = { horizontal: i === 0 ? "left" : "right" };
      if (rowIndex % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.zebra } };
      }
      cell.border = {
        bottom: { style: "hair", color: { argb: THEME.border } },
      };
    });
  });

  const lastDataRow = firstDataRow + Math.max(rows.length, 1) - 1;
  sheet.views = [{ state: "frozen", ySplit: headerRow }];
  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: lastDataRow, column: columns.length },
  };
  return { firstDataRow, lastDataRow };
}

/** Linha de totais com fórmulas SUBTOTAL (respeita o autofiltro). */
function totalsRow(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  columns: ColumnSpec[],
  range: { firstDataRow: number; lastDataRow: number },
  sumColumns: number[],
  label = "TOTAL",
): void {
  const row = sheet.getRow(rowNumber);
  columns.forEach((col, i) => {
    const cell = row.getCell(i + 1);
    const columnLetter = sheet.getColumn(i + 1).letter;
    if (i === 0) {
      cell.value = label;
    } else if (sumColumns.includes(i + 1)) {
      cell.value = {
        formula: `SUBTOTAL(109,${columnLetter}${range.firstDataRow}:${columnLetter}${range.lastDataRow})`,
      };
      if (col.format) cell.numFmt = col.format;
    }
    cell.font = { name: FONT, size: 10, bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.totalFill } };
    cell.alignment = { horizontal: i === 0 ? "left" : "right" };
    cell.border = { top: { style: "thin", color: { argb: THEME.ink } } };
  });
}

export async function buildSalesReportXlsx(
  report: SalesReport,
  store: SalesXlsxStore = {},
): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  wb.creator = store.fantasyName || store.name || "Bastion PDV";
  wb.created = report.generatedAt;

  const storeName = store.fantasyName || store.name || "Minha loja";
  const subtitle = [
    storeName,
    store.cnpj ? `CNPJ ${store.cnpj}` : null,
    `${GRANULARITY_LABEL[report.granularity]} · ${dateBR(report.from)} a ${dateBR(report.to)}`,
    `Gerado em ${dateTimeBR(report.generatedAt)}`,
  ]
    .filter(Boolean)
    .join("  ·  ");

  // ── Aba 1: período (dia/semana/mês/…) ────────────────────────────────────
  const periodSheet = wb.addWorksheet(GRANULARITY_LABEL[report.granularity], {
    properties: { tabColor: { argb: THEME.accent } },
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });
  const periodColumns: ColumnSpec[] = [
    { header: "Período", key: "period", width: 34 },
    { header: "Vendas", key: "sales", width: 12, format: "#,##0" },
    { header: "Itens", key: "items", width: 12, format: NUMBER },
    { header: "Bruto", key: "gross", width: 16, format: MONEY },
    { header: "Descontos", key: "discount", width: 16, format: MONEY },
    { header: "Ticket médio", key: "avg", width: 16, format: MONEY },
    { header: "Total", key: "total", width: 18, format: MONEY },
  ];
  titleBand(periodSheet, `Vendas ${GRANULARITY_LABEL[report.granularity].toLowerCase()}`, subtitle, periodColumns.length);
  const periodRange = writeTable(
    periodSheet,
    4,
    periodColumns,
    report.periods.map((p) => [p.detail, p.sales, p.items, p.gross, p.discount, p.avgTicket, p.total]),
  );
  totalsRow(periodSheet, periodRange.lastDataRow + 1, periodColumns, periodRange, [2, 3, 4, 5, 7]);
  // Ticket médio total é razão, não soma: sobrescrevemos com a fórmula correta.
  const ticketCell = periodSheet.getCell(periodRange.lastDataRow + 1, 6);
  ticketCell.value = {
    formula: `IFERROR(G${periodRange.lastDataRow + 1}/B${periodRange.lastDataRow + 1},0)`,
  };
  ticketCell.numFmt = MONEY;

  // ── Aba 2: por caixa ─────────────────────────────────────────────────────
  const registerSheet = wb.addWorksheet("Por caixa", {
    properties: { tabColor: { argb: THEME.ink } },
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });
  const registerColumns: ColumnSpec[] = [
    { header: "Caixa", key: "name", width: 24 },
    { header: "Vendas", key: "sales", width: 12, format: "#,##0" },
    { header: "Itens", key: "items", width: 12, format: NUMBER },
    { header: "Descontos", key: "discount", width: 15, format: MONEY },
    { header: "Ticket médio", key: "avg", width: 15, format: MONEY },
    { header: "Total", key: "total", width: 18, format: MONEY },
    { header: "Participação", key: "share", width: 14, format: PERCENT },
    { header: "Sessões de caixa", key: "sessions", width: 16, format: "#,##0" },
    { header: "Operador(es)", key: "operators", width: 36 },
  ];
  titleBand(registerSheet, "Vendas por caixa", subtitle, registerColumns.length);
  const registerRange = writeTable(
    registerSheet,
    4,
    registerColumns,
    report.registers.map((r) => [
      r.name,
      r.sales,
      r.items,
      r.discount,
      r.avgTicket,
      r.total,
      r.share,
      r.sessions,
      r.operators.join(", ") || "—",
    ]),
  );
  totalsRow(registerSheet, registerRange.lastDataRow + 1, registerColumns, registerRange, [2, 3, 4, 6, 7, 8]);

  // ── Aba 3: pagamentos ────────────────────────────────────────────────────
  const paymentSheet = wb.addWorksheet("Pagamentos");
  const paymentColumns: ColumnSpec[] = [
    { header: "Forma de pagamento", key: "label", width: 28 },
    { header: "Lançamentos", key: "count", width: 15, format: "#,##0" },
    { header: "Total", key: "total", width: 18, format: MONEY },
    { header: "Participação", key: "share", width: 14, format: PERCENT },
  ];
  titleBand(paymentSheet, "Recebimentos por forma de pagamento", subtitle, paymentColumns.length);
  const paymentRange = writeTable(
    paymentSheet,
    4,
    paymentColumns,
    report.payments.map((p) => [p.label, p.count, p.total, p.share]),
  );
  totalsRow(paymentSheet, paymentRange.lastDataRow + 1, paymentColumns, paymentRange, [2, 3, 4]);

  // ── Aba 4: produtos ──────────────────────────────────────────────────────
  const productSheet = wb.addWorksheet("Produtos");
  const productColumns: ColumnSpec[] = [
    { header: "Produto", key: "name", width: 44 },
    { header: "Quantidade", key: "qty", width: 14, format: NUMBER },
    { header: "Total", key: "total", width: 18, format: MONEY },
    { header: "Participação", key: "share", width: 14, format: PERCENT },
  ];
  titleBand(productSheet, "Produtos vendidos no período", subtitle, productColumns.length);
  const productRange = writeTable(
    productSheet,
    4,
    productColumns,
    report.products.map((p) => [p.name, p.quantity, p.total, p.share]),
  );
  totalsRow(productSheet, productRange.lastDataRow + 1, productColumns, productRange, [2, 3, 4]);

  // ── Aba 5: matriz caixa × período ────────────────────────────────────────
  const matrixSheet = wb.addWorksheet("Caixa x período", {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });
  const matrixColumns: ColumnSpec[] = [
    { header: "Caixa", key: "register", width: 24 },
    ...report.periods.map((p) => ({ header: p.label, key: p.key, width: 15, format: MONEY })),
    { header: "Total", key: "total", width: 18, format: MONEY },
  ];
  titleBand(matrixSheet, "Faturamento por caixa e período", subtitle, matrixColumns.length);
  const matrixRange = writeTable(
    matrixSheet,
    4,
    matrixColumns,
    report.matrix.map((m) => [
      m.register,
      ...report.periods.map((p) => m.byPeriod[p.key] ?? 0),
      m.total,
    ]),
  );
  totalsRow(
    matrixSheet,
    matrixRange.lastDataRow + 1,
    matrixColumns,
    matrixRange,
    matrixColumns.map((_, i) => i + 1).filter((i) => i > 1),
  );

  // ── Aba 6: Resumo com consulta PROCV ─────────────────────────────────────
  const summary = wb.addWorksheet("Resumo", { properties: { tabColor: { argb: THEME.accent } } });
  titleBand(summary, "Resumo do período", subtitle, 4);
  summary.getColumn(1).width = 34;
  summary.getColumn(2).width = 22;
  summary.getColumn(3).width = 24;
  summary.getColumn(4).width = 22;

  const t = report.totals;
  const indicators: [string, number | string, string | undefined][] = [
    ["Faturamento total", t.total, MONEY],
    ["Faturamento bruto", t.gross, MONEY],
    ["Descontos concedidos", t.discount, MONEY],
    ["Vendas finalizadas", t.sales, "#,##0"],
    ["Itens vendidos", t.items, NUMBER],
    ["Ticket médio", t.avgTicket, MONEY],
    ["Itens por venda", t.avgItemsPerSale, NUMBER],
    ["Melhor dia", t.bestDay ? t.bestDay.label : "—", undefined],
    ["Faturamento do melhor dia", t.bestDay ? t.bestDay.total : 0, MONEY],
    ["Caixas com venda", report.registers.length, "#,##0"],
    ["Notas emitidas", t.fiscalIssued, "#,##0"],
    ["Notas pendentes", t.fiscalPending, "#,##0"],
  ];

  let row = 4;
  for (const [label, value, format] of indicators) {
    const labelCell = summary.getCell(row, 1);
    labelCell.value = label;
    labelCell.font = { name: FONT, size: 10, bold: true };
    labelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.zebra } };
    labelCell.border = { bottom: { style: "hair", color: { argb: THEME.border } } };

    const valueCell = summary.getCell(row, 2);
    valueCell.value = typeof value === "string" ? safeText(value) : value;
    valueCell.font = { name: FONT, size: 10 };
    if (format) valueCell.numFmt = format;
    valueCell.alignment = { horizontal: "right" };
    valueCell.border = { bottom: { style: "hair", color: { argb: THEME.border } } };
    row += 1;
  }

  // Bloco de consulta: o lojista escolhe o caixa e as fórmulas fazem o resto.
  row += 2;
  const lookupTitle = summary.getCell(row, 1);
  lookupTitle.value = "Consulta rápida por caixa (PROCV)";
  lookupTitle.font = { name: FONT, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  lookupTitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.accent } };
  summary.mergeCells(row, 1, row, 4);
  summary.getCell(row, 1).alignment = { indent: 1, vertical: "middle" };
  summary.getRow(row).height = 22;
  row += 1;

  const hint = summary.getCell(row, 1);
  hint.value = "Escolha um caixa na célula ao lado — os valores abaixo se atualizam sozinhos.";
  hint.font = { name: FONT, size: 9, italic: true, color: { argb: THEME.muted } };
  summary.mergeCells(row, 1, row, 4);
  row += 1;

  const lookupInputRow = row;
  const inputLabel = summary.getCell(lookupInputRow, 1);
  inputLabel.value = "Caixa selecionado";
  inputLabel.font = { name: FONT, size: 10, bold: true };
  const inputCell = summary.getCell(lookupInputRow, 2);
  inputCell.value = safeText(report.registers[0]?.name ?? "");
  inputCell.font = { name: FONT, size: 10, bold: true, color: { argb: "FF1D4ED8" } };
  inputCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3C4" } };
  inputCell.border = {
    top: { style: "thin", color: { argb: THEME.accent } },
    bottom: { style: "thin", color: { argb: THEME.accent } },
    left: { style: "thin", color: { argb: THEME.accent } },
    right: { style: "thin", color: { argb: THEME.accent } },
  };
  // Lista suspensa com os caixas existentes: evita erro de digitação no PROCV.
  if (report.registers.length) {
    inputCell.dataValidation = {
      type: "list",
      allowBlank: false,
      formulae: [`'Por caixa'!$A$${registerRange.firstDataRow}:$A$${registerRange.lastDataRow}`],
      showErrorMessage: true,
      errorTitle: "Caixa inválido",
      error: "Escolha um dos caixas listados na aba 'Por caixa'.",
    };
  }
  row += 1;

  const lookupRange = `'Por caixa'!$A$${registerRange.firstDataRow}:$I$${registerRange.lastDataRow}`;
  const lookups: [string, number, string | undefined][] = [
    ["Vendas do caixa", 2, "#,##0"],
    ["Itens do caixa", 3, NUMBER],
    ["Descontos do caixa", 4, MONEY],
    ["Ticket médio do caixa", 5, MONEY],
    ["Faturamento do caixa", 6, MONEY],
    ["Participação no período", 7, PERCENT],
    ["Operador(es)", 9, undefined],
  ];
  for (const [label, columnIndex, format] of lookups) {
    const labelCell = summary.getCell(row, 1);
    labelCell.value = label;
    labelCell.font = { name: FONT, size: 10 };
    labelCell.border = { bottom: { style: "hair", color: { argb: THEME.border } } };

    const formulaCell = summary.getCell(row, 2);
    formulaCell.value = {
      formula: `IFERROR(VLOOKUP($B$${lookupInputRow},${lookupRange},${columnIndex},FALSE),"-")`,
    };
    if (format) formulaCell.numFmt = format;
    formulaCell.font = { name: FONT, size: 10, bold: true };
    formulaCell.alignment = { horizontal: "right" };
    formulaCell.border = { bottom: { style: "hair", color: { argb: THEME.border } } };
    row += 1;
  }

  // O arquivo abre já no Resumo (não reordenamos as abas: as fórmulas do Resumo
  // dependem das outras, e mexer na ordem interna do ExcelJS é frágil).
  const summaryIndex = wb.worksheets.findIndex((s) => s.name === "Resumo");
  if (summaryIndex >= 0) {
    wb.views = [
      { activeTab: summaryIndex, firstSheet: 0, visibility: "visible", x: 0, y: 0, width: 20000, height: 12000 },
    ];

  }


  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
