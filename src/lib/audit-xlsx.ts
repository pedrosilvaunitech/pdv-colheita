/**
 * Exportação XLSX da auditoria de RPC e dos bloqueios de rate limit.
 *
 * Por que ExcelJS e não uma geração manual de CSV renomeado:
 *  - precisamos embutir a **logo da loja** (configurada em Configurações →
 *    Cupom) na planilha, o que só é possível num XLSX real;
 *  - estilos (cabeçalho colorido, zebra, bordas, autofiltro, painel
 *    congelado) tornam o arquivo apresentável para auditoria externa.
 *
 * Observações de robustez:
 *  - a logo é opcional: se o download falhar (URL assinada expirada, CORS,
 *    offline) a planilha é gerada sem imagem em vez de quebrar o export;
 *  - todo texto vindo do banco é neutralizado contra fórmulas maliciosas
 *    (CSV/Excel injection) antes de virar célula.
 */

import ExcelJS from "exceljs";
import type { AuditCsvRow, RateLimitCsvRow } from "./audit-csv";

/** Identidade visual aplicada à planilha (alinhada ao tema do PDV). */
const THEME = {
  primary: "FF0F172A",   // slate-900 — faixa do título
  accent: "FF2563EB",    // blue-600  — cabeçalho da tabela
  zebra: "FFF1F5F9",     // slate-100 — linhas alternadas
  denied: "FFFEE2E2",    // red-100   — destaque de tentativa negada
  deniedText: "FF991B1B",
  allowedText: "FF166534",
  border: "FFCBD5E1",
  muted: "FF64748B",
} as const;

const FONT = "Arial";

export interface XlsxStoreInfo {
  /** Nome fantasia/razão exibido no topo da planilha. */
  name?: string | null;
  cnpj?: string | null;
  /** URL (assinada ou pública) da logo salva em `receipt_settings.logo_url`. */
  logoUrl?: string | null;
}

export interface AuditXlsxOptions {
  store?: XlsxStoreInfo;
  /** Rótulo humano do filtro ativo, ex.: "Somente negadas". */
  filterLabel?: string;
  /** Traduz o nome técnico da função para o rótulo da tela. */
  labelFor?: (fn: string) => string;
  now?: Date;
}

type LogoImage = { buffer: ArrayBuffer; extension: "png" | "jpeg" | "gif" };

/** Baixa a logo e detecta o formato aceito pelo ExcelJS. Nunca lança. */
async function fetchLogo(url: string | null | undefined): Promise<LogoImage | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return null;
    const blob = await res.blob();
    // Limite defensivo: uma logo de cupom não passa de ~2 MB.
    if (blob.size === 0 || blob.size > 2_000_000) return null;
    const type = blob.type.toLowerCase();
    const extension: LogoImage["extension"] =
      type.includes("jpe") || type.includes("jpg") ? "jpeg" : type.includes("gif") ? "gif" : "png";
    return { buffer: await blob.arrayBuffer(), extension };
  } catch {
    return null;
  }
}

/** Impede que um valor vindo do banco seja interpretado como fórmula. */
function safeText(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Nome de arquivo estável e ordenável: `auditoria-rpc-negadas-2026-07-27-1432.xlsx`. */
export function xlsxFilename(prefix: string, suffix?: string, now: Date = new Date()): string {
  return [prefix, suffix, stamp(now)].filter(Boolean).join("-") + ".xlsx";
}

interface HeaderOptions {
  title: string;
  subtitle: string;
  columns: number;
  store?: XlsxStoreInfo;
  logo: LogoImage | null;
  workbook: ExcelJS.Workbook;
  sheet: ExcelJS.Worksheet;
}

/**
 * Desenha a faixa de identificação (linhas 1–4): logo à esquerda,
 * título/loja ao centro e a data de geração. Retorna a primeira linha livre.
 */
function drawHeader({ title, subtitle, columns, store, logo, workbook, sheet }: HeaderOptions): number {
  const last = sheet.getColumn(columns).letter;

  sheet.mergeCells(`A1:${last}1`);
  sheet.mergeCells(`A2:${last}2`);
  sheet.mergeCells(`A3:${last}3`);

  const titleCell = sheet.getCell("A1");
  titleCell.value = title;
  titleCell.font = { name: FONT, size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.alignment = { vertical: "middle", horizontal: logo ? "right" : "center" };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.primary } };
  sheet.getRow(1).height = 34;

  const storeCell = sheet.getCell("A2");
  const storeLine = [store?.name, store?.cnpj ? `CNPJ ${store.cnpj}` : null].filter(Boolean).join(" · ");
  storeCell.value = storeLine || "Bastion PDV";
  storeCell.font = { name: FONT, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  storeCell.alignment = { vertical: "middle", horizontal: logo ? "right" : "center" };
  storeCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.primary } };
  sheet.getRow(2).height = 18;

  const metaCell = sheet.getCell("A3");
  metaCell.value = subtitle;
  metaCell.font = { name: FONT, size: 9, italic: true, color: { argb: "FFE2E8F0" } };
  metaCell.alignment = { vertical: "middle", horizontal: logo ? "right" : "center" };
  metaCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.primary } };
  sheet.getRow(3).height = 16;

  if (logo) {
    const imageId = workbook.addImage({ buffer: logo.buffer as never, extension: logo.extension });
    // Ancoragem por pixel dentro da faixa escura, sem deslocar colunas.
    sheet.addImage(imageId, {
      tl: { col: 0.15, row: 0.15 },
      ext: { width: 132, height: 54 },
      editAs: "oneCell",
    });
  }

  sheet.getRow(4).height = 6;
  return 5;
}

interface TableColumn {
  header: string;
  width: number;
  align?: "left" | "center" | "right";
}

/** Escreve o cabeçalho da tabela e devolve a linha inicial dos dados. */
function drawTableHeader(sheet: ExcelJS.Worksheet, startRow: number, columns: readonly TableColumn[]): number {
  const row = sheet.getRow(startRow);
  columns.forEach((col, i) => {
    const cell = row.getCell(i + 1);
    cell.value = col.header;
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: THEME.accent } };
    cell.alignment = { vertical: "middle", horizontal: col.align ?? "left", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: THEME.accent } },
      bottom: { style: "thin", color: { argb: THEME.accent } },
      left: { style: "thin", color: { argb: THEME.accent } },
      right: { style: "thin", color: { argb: THEME.accent } },
    };
    sheet.getColumn(i + 1).width = col.width;
  });
  row.height = 24;
  return startRow + 1;
}

function styleBody(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  columnCount: number,
  opts: { zebra: boolean; highlight?: boolean },
) {
  const row = sheet.getRow(rowNumber);
  row.height = 17;
  for (let c = 1; c <= columnCount; c++) {
    const cell = row.getCell(c);
    cell.font = { name: FONT, size: 10 };
    cell.alignment = { vertical: "middle", wrapText: false, ...cell.alignment };
    cell.border = {
      top: { style: "hair", color: { argb: THEME.border } },
      bottom: { style: "hair", color: { argb: THEME.border } },
      left: { style: "hair", color: { argb: THEME.border } },
      right: { style: "hair", color: { argb: THEME.border } },
    };
    const fill = opts.highlight ? THEME.denied : opts.zebra ? THEME.zebra : null;
    if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  }
}

/** Bloco de resumo (KPIs) usado nas duas abas. */
function drawSummary(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  items: readonly { label: string; value: string | number }[],
): number {
  let r = startRow;
  for (const item of items) {
    const row = sheet.getRow(r);
    const labelCell = row.getCell(1);
    labelCell.value = item.label;
    labelCell.font = { name: FONT, size: 10, bold: true, color: { argb: THEME.muted } };
    const valueCell = row.getCell(2);
    valueCell.value = item.value;
    valueCell.font = { name: FONT, size: 11, bold: true };
    valueCell.alignment = { horizontal: "left" };
    row.height = 16;
    r++;
  }
  sheet.getRow(r).height = 6;
  return r + 1;
}

const AUDIT_COLUMNS: readonly TableColumn[] = [
  { header: "Data/hora", width: 20 },
  { header: "Função", width: 30 },
  { header: "Função (técnica)", width: 28 },
  { header: "Resultado", width: 13, align: "center" },
  { header: "Usuário", width: 38 },
  { header: "Loja", width: 38 },
  { header: "Detalhe", width: 52 },
];

/** Gera o workbook da trilha de auditoria já pronto para download. */
export async function buildAuditWorkbook(
  rows: readonly AuditCsvRow[],
  options: AuditXlsxOptions = {},
): Promise<ExcelJS.Workbook> {
  const { store, filterLabel = "Todas", labelFor = (fn: string) => fn, now = new Date() } = options;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = store?.name || "Bastion PDV";
  workbook.created = now;

  const sheet = workbook.addWorksheet("Auditoria RPC", {
    views: [{ state: "frozen", ySplit: 0 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const logo = await fetchLogo(store?.logoUrl);

  let cursor = drawHeader({
    title: "Auditoria de chamadas sensíveis (RPC)",
    subtitle: `Gerado em ${now.toLocaleString("pt-BR")} · Filtro: ${filterLabel} · ${rows.length} registro(s)`,
    columns: AUDIT_COLUMNS.length,
    store,
    logo,
    workbook,
    sheet,
  });

  const denied = rows.filter((r) => !r.allowed);
  const uniqueUsers = new Set(rows.map((r) => r.user_id ?? "—")).size;
  const period = rows.length
    ? `${new Date(rows[rows.length - 1].created_at).toLocaleString("pt-BR")} → ${new Date(rows[0].created_at).toLocaleString("pt-BR")}`
    : "—";

  cursor = drawSummary(sheet, cursor, [
    { label: "Total de registros", value: rows.length },
    { label: "Tentativas negadas", value: denied.length },
    { label: "Tentativas permitidas", value: rows.length - denied.length },
    { label: "Usuários distintos", value: uniqueUsers },
    { label: "Período coberto", value: period },
  ]);

  const headerRow = cursor;
  cursor = drawTableHeader(sheet, headerRow, AUDIT_COLUMNS);

  rows.forEach((r, index) => {
    const row = sheet.getRow(cursor);
    const when = toDate(r.created_at);
    row.getCell(1).value = when ?? safeText(r.created_at);
    row.getCell(1).numFmt = "dd/mm/yyyy hh:mm:ss";
    row.getCell(2).value = safeText(labelFor(r.function_name));
    row.getCell(3).value = safeText(r.function_name);
    const result = row.getCell(4);
    result.value = r.allowed ? "PERMITIDA" : "NEGADA";
    result.alignment = { horizontal: "center", vertical: "middle" };
    result.font = {
      name: FONT,
      size: 10,
      bold: true,
      color: { argb: r.allowed ? THEME.allowedText : THEME.deniedText },
    };
    row.getCell(5).value = safeText(r.user_id ?? "—");
    row.getCell(6).value = safeText(r.store_id ?? "—");
    row.getCell(7).value = safeText(r.detail ?? "");
    styleBody(sheet, cursor, AUDIT_COLUMNS.length, { zebra: index % 2 === 1, highlight: !r.allowed });
    cursor++;
  });

  if (rows.length > 0) {
    sheet.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: cursor - 1, column: AUDIT_COLUMNS.length },
    };
    // Congela tudo acima da primeira linha de dados para rolagem confortável.
    sheet.views = [{ state: "frozen", ySplit: headerRow }];
  }

  return workbook;
}

const BLOCK_COLUMNS: readonly TableColumn[] = [
  { header: "Função", width: 32 },
  { header: "Função (técnica)", width: 28 },
  { header: "Usuário", width: 38 },
  { header: "Tentativas", width: 13, align: "center" },
  { header: "Bloqueado até", width: 22 },
  { header: "Situação", width: 16, align: "center" },
];

/** Gera o workbook dos bloqueios de rate limit ativos. */
export async function buildRateLimitWorkbook(
  rows: readonly RateLimitCsvRow[],
  options: AuditXlsxOptions = {},
): Promise<ExcelJS.Workbook> {
  const { store, labelFor = (fn: string) => fn, now = new Date() } = options;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = store?.name || "Bastion PDV";
  workbook.created = now;

  const sheet = workbook.addWorksheet("Bloqueios", {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const logo = await fetchLogo(store?.logoUrl);

  let cursor = drawHeader({
    title: "Bloqueios por excesso de tentativas",
    subtitle: `Gerado em ${now.toLocaleString("pt-BR")} · ${rows.length} bloqueio(s) ativo(s)`,
    columns: BLOCK_COLUMNS.length,
    store,
    logo,
    workbook,
    sheet,
  });

  const totalAttempts = rows.reduce((acc, r) => acc + (r.attempts ?? 0), 0);
  cursor = drawSummary(sheet, cursor, [
    { label: "Bloqueios ativos", value: rows.length },
    { label: "Tentativas somadas", value: totalAttempts },
    { label: "Usuários distintos", value: new Set(rows.map((r) => r.user_id)).size },
  ]);

  const headerRow = cursor;
  cursor = drawTableHeader(sheet, headerRow, BLOCK_COLUMNS);

  rows.forEach((r, index) => {
    const row = sheet.getRow(cursor);
    row.getCell(1).value = safeText(labelFor(r.function_name));
    row.getCell(2).value = safeText(r.function_name);
    row.getCell(3).value = safeText(r.user_id);
    const attempts = row.getCell(4);
    attempts.value = r.attempts;
    attempts.alignment = { horizontal: "center", vertical: "middle" };
    const until = toDate(r.blocked_until);
    row.getCell(5).value = until ?? "—";
    if (until) row.getCell(5).numFmt = "dd/mm/yyyy hh:mm:ss";
    const active = Boolean(until && until.getTime() > now.getTime());
    const status = row.getCell(6);
    status.value = active ? "BLOQUEADO" : "LIBERADO";
    status.alignment = { horizontal: "center", vertical: "middle" };
    status.font = { name: FONT, size: 10, bold: true, color: { argb: active ? THEME.deniedText : THEME.allowedText } };
    styleBody(sheet, cursor, BLOCK_COLUMNS.length, { zebra: index % 2 === 1, highlight: active });
    cursor++;
  });

  if (rows.length > 0) {
    sheet.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: cursor - 1, column: BLOCK_COLUMNS.length },
    };
    sheet.views = [{ state: "frozen", ySplit: headerRow }];
  }

  return workbook;
}

/** Serializa e dispara o download no browser. */
export async function downloadWorkbook(filename: string, workbook: ExcelJS.Workbook): Promise<void> {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
