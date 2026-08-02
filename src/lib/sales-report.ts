/**
 * Relatório de vendas — consulta e agregações.
 *
 * Por que uma camada separada da tela: o mesmo conjunto agregado alimenta três
 * consumidores (tabelas na tela, PDF e Excel). Se cada um recalculasse por
 * conta própria, o PDF poderia divergir da planilha — inaceitável num relatório
 * que o contador confere. Aqui os números são calculados UMA vez e distribuídos.
 *
 * Decisões relevantes:
 *  - a data considerada é `finalized_at` (quando o dinheiro entrou) com fallback
 *    para `created_at`, porque venda aberta e finalizada em dias diferentes deve
 *    contar no dia do fechamento;
 *  - só entram vendas com status `finalizada` — canceladas não são faturamento;
 *  - "caixa" é um conceito composto: o terminal registrado no fechamento
 *    (`cash_registers.terminal`) ou, quando não houver, o `terminal_key` gravado
 *    na venda. Sem nenhum dos dois, cai em "Não identificado" em vez de sumir.
 */

import { supabase } from "@/integrations/supabase/client";

export type Granularity = "day" | "week" | "month" | "quarter" | "year";

export const GRANULARITY_LABEL: Record<Granularity, string> = {
  day: "Por dia",
  week: "Por semana",
  month: "Por mês",
  quarter: "Por trimestre",
  year: "Por ano",
};

const PAYMENT_LABEL: Record<string, string> = {
  dinheiro: "Dinheiro",
  pix: "Pix",
  debito: "Cartão de débito",
  credito: "Cartão de crédito",
  voucher: "Voucher",
  outro: "Outro",
};

export function paymentLabel(method: string): string {
  return PAYMENT_LABEL[method] ?? method;
}

// ── linhas cruas do banco ────────────────────────────────────────────────────

interface SaleRow {
  id: string;
  total: number;
  subtotal: number;
  discount: number;
  created_at: string;
  finalized_at: string | null;
  operator_id: string;
  cash_register_id: string | null;
  terminal_key: string | null;
  document_type: string;
  fiscal_status: string;
}

interface PaymentRow {
  sale_id: string;
  method: string;
  amount: number;
}

interface ItemRow {
  sale_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  total: number;
}

// ── agregados ────────────────────────────────────────────────────────────────

export interface PeriodBucket {
  key: string;
  /** Rótulo curto: "05/08" para dia, "Ago/2026" para mês. */
  label: string;
  /** Rótulo completo usado no PDF/Excel: "05/08/2026 (quarta-feira)". */
  detail: string;
  start: Date;
  sales: number;
  items: number;
  gross: number;
  discount: number;
  total: number;
  avgTicket: number;
}

export interface RegisterBucket {
  key: string;
  /** Nome do caixa/terminal. */
  name: string;
  /** Operadores que usaram esse caixa no período. */
  operators: string[];
  sessions: number;
  sales: number;
  items: number;
  discount: number;
  total: number;
  avgTicket: number;
  /** Participação no faturamento do período (0–1). */
  share: number;
  firstSaleAt: Date | null;
  lastSaleAt: Date | null;
}

export interface PaymentBucket {
  method: string;
  label: string;
  count: number;
  total: number;
  share: number;
}

export interface ProductBucket {
  productId: string;
  name: string;
  quantity: number;
  total: number;
  share: number;
}

export interface OperatorBucket {
  operatorId: string;
  name: string;
  sales: number;
  total: number;
  avgTicket: number;
  share: number;
}

export interface SalesReportTotals {
  sales: number;
  items: number;
  gross: number;
  discount: number;
  total: number;
  avgTicket: number;
  avgItemsPerSale: number;
  /** Melhor dia do período (sempre por dia, independente da granularidade). */
  bestDay: { label: string; total: number } | null;
  fiscalIssued: number;
  fiscalPending: number;
}

export interface SalesReport {
  granularity: Granularity;
  from: Date;
  to: Date;
  totals: SalesReportTotals;
  periods: PeriodBucket[];
  registers: RegisterBucket[];
  payments: PaymentBucket[];
  products: ProductBucket[];
  operators: OperatorBucket[];
  /** Cruzamento caixa × período — base do "PROCV" na planilha. */
  matrix: { register: string; byPeriod: Record<string, number>; total: number }[];
  generatedAt: Date;
}

export interface SalesReportQuery {
  storeId: string;
  /** Início do dia, hora local. */
  from: Date;
  /** Fim do dia, hora local. */
  to: Date;
  granularity: Granularity;
  /** Filtra um caixa específico (`RegisterBucket.key`); vazio = todos. */
  registerKey?: string | null;
}

// ── utilidades de data (tudo em horário local, como o lojista enxerga) ───────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const MONTHS = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

const WEEKDAYS = [
  "domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado",
];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Segunda-feira da semana (padrão brasileiro de semana comercial). */
function startOfWeek(d: Date): Date {
  const base = startOfDay(d);
  const shift = (base.getDay() + 6) % 7;
  base.setDate(base.getDate() - shift);
  return base;
}

function isoWeek(d: Date): { week: number; year: number } {
  const target = startOfDay(d);
  const day = (target.getDay() + 6) % 7;
  target.setDate(target.getDate() - day + 3); // quinta da semana ISO
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDay + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { week, year: target.getFullYear() };
}

/** Chave, rótulo curto e rótulo detalhado do bucket a que a data pertence. */
function bucketOf(date: Date, granularity: Granularity): { key: string; label: string; detail: string; start: Date } {
  const y = date.getFullYear();
  switch (granularity) {
    case "day": {
      const start = startOfDay(date);
      return {
        key: `${y}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        label: `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`,
        detail: `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${y} · ${WEEKDAYS[start.getDay()]}`,
        start,
      };
    }
    case "week": {
      const start = startOfWeek(date);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      const { week, year } = isoWeek(date);
      return {
        key: `${year}-W${pad(week)}`,
        label: `Sem ${pad(week)}`,
        detail: `Semana ${pad(week)}/${year} · ${pad(start.getDate())}/${pad(start.getMonth() + 1)} a ${pad(end.getDate())}/${pad(end.getMonth() + 1)}`,
        start,
      };
    }
    case "month": {
      const start = new Date(y, date.getMonth(), 1);
      return {
        key: `${y}-${pad(date.getMonth() + 1)}`,
        label: `${MONTHS[date.getMonth()]}/${String(y).slice(2)}`,
        detail: `${MONTHS[date.getMonth()]} de ${y}`,
        start,
      };
    }
    case "quarter": {
      const q = Math.floor(date.getMonth() / 3);
      const start = new Date(y, q * 3, 1);
      return {
        key: `${y}-Q${q + 1}`,
        label: `${q + 1}º tri/${String(y).slice(2)}`,
        detail: `${q + 1}º trimestre de ${y} · ${MONTHS[q * 3]} a ${MONTHS[q * 3 + 2]}`,
        start,
      };
    }
    case "year":
    default:
      return { key: String(y), label: String(y), detail: `Ano de ${y}`, start: new Date(y, 0, 1) };
  }
}

function saleDate(sale: SaleRow): Date {
  return new Date(sale.finalized_at ?? sale.created_at);
}

// ── consulta ────────────────────────────────────────────────────────────────

/**
 * Busca e agrega tudo o que o relatório precisa.
 *
 * Faz consultas em duas ondas (vendas → itens/pagamentos por `in(saleIds)`)
 * porque PostgREST não devolve agregações; o volume de um período de caixa é
 * pequeno o suficiente para isso ser confortável. Períodos sem venda devolvem
 * um relatório vazio válido, e não um erro.
 */
export async function fetchSalesReport(query: SalesReportQuery): Promise<SalesReport> {
  const { storeId, granularity } = query;
  const from = startOfDay(query.from);
  const to = new Date(query.to.getFullYear(), query.to.getMonth(), query.to.getDate(), 23, 59, 59, 999);

  const salesRes = await supabase
    .from("sales")
    .select(
      "id,total,subtotal,discount,created_at,finalized_at,operator_id,cash_register_id,terminal_key,document_type,fiscal_status",
    )
    .eq("store_id", storeId)
    .eq("status", "finalizada")
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString())
    .order("created_at", { ascending: true });
  if (salesRes.error) throw salesRes.error;

  const allSales = (salesRes.data ?? []) as SaleRow[];

  // Nomes de caixa e operador: usados na classificação, então vêm antes do
  // filtro por caixa (o filtro é aplicado sobre a chave já resolvida).
  const registerIds = [...new Set(allSales.map((s) => s.cash_register_id).filter((v): v is string => !!v))];
  const operatorIds = [...new Set(allSales.map((s) => s.operator_id).filter(Boolean))];

  const [registersRes, profilesRes] = await Promise.all([
    registerIds.length
      ? supabase.from("cash_registers").select("id,terminal,opened_at").in("id", registerIds)
      : Promise.resolve({ data: [], error: null as null }),
    operatorIds.length
      ? supabase.from("profiles").select("id,full_name").in("id", operatorIds)
      : Promise.resolve({ data: [], error: null as null }),
  ]);
  if (registersRes.error) throw registersRes.error;
  if (profilesRes.error) throw profilesRes.error;

  const registerName = new Map<string, string>();
  for (const r of (registersRes.data ?? []) as { id: string; terminal: string }[]) {
    registerName.set(r.id, r.terminal || "Caixa");
  }
  const operatorName = new Map<string, string>();
  for (const p of (profilesRes.data ?? []) as { id: string; full_name: string | null }[]) {
    if (p.full_name) operatorName.set(p.id, p.full_name);
  }

  const keyOf = (sale: SaleRow): string => {
    const byRegister = sale.cash_register_id ? registerName.get(sale.cash_register_id) : null;
    return (byRegister || sale.terminal_key || "Não identificado").trim() || "Não identificado";
  };

  const sales = query.registerKey ? allSales.filter((s) => keyOf(s) === query.registerKey) : allSales;
  const saleIds = sales.map((s) => s.id);

  let payments: PaymentRow[] = [];
  let items: ItemRow[] = [];
  if (saleIds.length > 0) {
    // `in` com muitos ids estoura o tamanho da URL; fatiamos em blocos.
    const chunks: string[][] = [];
    for (let i = 0; i < saleIds.length; i += 200) chunks.push(saleIds.slice(i, i + 200));

    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const [p, it] = await Promise.all([
          supabase.from("sale_payments").select("sale_id,method,amount").eq("store_id", storeId).in("sale_id", chunk),
          supabase
            .from("sale_items")
            .select("sale_id,product_id,product_name,quantity,total")
            .eq("store_id", storeId)
            .in("sale_id", chunk),
        ]);
        if (p.error) throw p.error;
        if (it.error) throw it.error;
        return { payments: (p.data ?? []) as PaymentRow[], items: (it.data ?? []) as ItemRow[] };
      }),
    );
    payments = results.flatMap((r) => r.payments);
    items = results.flatMap((r) => r.items);
  }

  return aggregate({ sales, payments, items, granularity, from, to, keyOf, operatorName });
}

interface AggregateInput {
  sales: SaleRow[];
  payments: PaymentRow[];
  items: ItemRow[];
  granularity: Granularity;
  from: Date;
  to: Date;
  keyOf: (sale: SaleRow) => string;
  operatorName: Map<string, string>;
}

function aggregate(input: AggregateInput): SalesReport {
  const { sales, payments, items, granularity, from, to, keyOf, operatorName } = input;

  const itemsBySale = new Map<string, number>();
  for (const it of items) {
    itemsBySale.set(it.sale_id, (itemsBySale.get(it.sale_id) ?? 0) + Number(it.quantity || 0));
  }

  // Períodos
  const periodMap = new Map<string, PeriodBucket>();
  // Caixas
  const registerMap = new Map<string, RegisterBucket & { operatorSet: Set<string>; sessionSet: Set<string> }>();
  // Cruzamento caixa × período
  const matrixMap = new Map<string, Map<string, number>>();
  // Melhor dia
  const dayTotals = new Map<string, { label: string; total: number }>();
  // Operadores
  const operatorMap = new Map<string, OperatorBucket>();

  let fiscalIssued = 0;
  let fiscalPending = 0;

  for (const sale of sales) {
    const when = saleDate(sale);
    const total = Number(sale.total || 0);
    const discount = Number(sale.discount || 0);
    const gross = Number(sale.subtotal || 0) || total + discount;
    const qty = itemsBySale.get(sale.id) ?? 0;

    // período
    const b = bucketOf(when, granularity);
    const period = periodMap.get(b.key) ?? {
      key: b.key,
      label: b.label,
      detail: b.detail,
      start: b.start,
      sales: 0,
      items: 0,
      gross: 0,
      discount: 0,
      total: 0,
      avgTicket: 0,
    };
    period.sales += 1;
    period.items += qty;
    period.gross += gross;
    period.discount += discount;
    period.total += total;
    periodMap.set(b.key, period);

    // melhor dia (sempre diário)
    const dayBucket = bucketOf(when, "day");
    const day = dayTotals.get(dayBucket.key) ?? { label: dayBucket.detail, total: 0 };
    day.total += total;
    dayTotals.set(dayBucket.key, day);

    // caixa
    const rk = keyOf(sale);
    const reg =
      registerMap.get(rk) ??
      ({
        key: rk,
        name: rk,
        operators: [],
        sessions: 0,
        sales: 0,
        items: 0,
        discount: 0,
        total: 0,
        avgTicket: 0,
        share: 0,
        firstSaleAt: null,
        lastSaleAt: null,
        operatorSet: new Set<string>(),
        sessionSet: new Set<string>(),
      } as RegisterBucket & { operatorSet: Set<string>; sessionSet: Set<string> });
    reg.sales += 1;
    reg.items += qty;
    reg.discount += discount;
    reg.total += total;
    if (sale.cash_register_id) reg.sessionSet.add(sale.cash_register_id);
    reg.operatorSet.add(operatorName.get(sale.operator_id) ?? "Operador");
    if (!reg.firstSaleAt || when < reg.firstSaleAt) reg.firstSaleAt = when;
    if (!reg.lastSaleAt || when > reg.lastSaleAt) reg.lastSaleAt = when;
    registerMap.set(rk, reg);

    // matriz
    const row = matrixMap.get(rk) ?? new Map<string, number>();
    row.set(b.key, (row.get(b.key) ?? 0) + total);
    matrixMap.set(rk, row);

    // operador
    const opName = operatorName.get(sale.operator_id) ?? "Operador";
    const op =
      operatorMap.get(sale.operator_id) ??
      { operatorId: sale.operator_id, name: opName, sales: 0, total: 0, avgTicket: 0, share: 0 };
    op.sales += 1;
    op.total += total;
    operatorMap.set(sale.operator_id, op);

    if (sale.fiscal_status === "emitida" || sale.fiscal_status === "autorizada") fiscalIssued += 1;
    else if (sale.fiscal_status === "pendente") fiscalPending += 1;
  }

  const totalSum = sales.reduce((acc, s) => acc + Number(s.total || 0), 0);
  const grossSum = sales.reduce((acc, s) => acc + (Number(s.subtotal || 0) || Number(s.total || 0)), 0);
  const discountSum = sales.reduce((acc, s) => acc + Number(s.discount || 0), 0);
  const itemSum = [...itemsBySale.values()].reduce((a, b) => a + b, 0);

  const periods = [...periodMap.values()]
    .map((p) => ({ ...p, avgTicket: p.sales ? p.total / p.sales : 0 }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const registers = [...registerMap.values()]
    .map(({ operatorSet, sessionSet, ...r }) => ({
      ...r,
      operators: [...operatorSet].sort(),
      sessions: sessionSet.size,
      avgTicket: r.sales ? r.total / r.sales : 0,
      share: totalSum ? r.total / totalSum : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const paymentMap = new Map<string, PaymentBucket>();
  for (const p of payments) {
    const bucket =
      paymentMap.get(p.method) ??
      { method: p.method, label: paymentLabel(p.method), count: 0, total: 0, share: 0 };
    bucket.count += 1;
    bucket.total += Number(p.amount || 0);
    paymentMap.set(p.method, bucket);
  }
  const paymentSum = [...paymentMap.values()].reduce((a, b) => a + b.total, 0);
  const paymentsAgg = [...paymentMap.values()]
    .map((p) => ({ ...p, share: paymentSum ? p.total / paymentSum : 0 }))
    .sort((a, b) => b.total - a.total);

  const productMap = new Map<string, ProductBucket>();
  for (const it of items) {
    const bucket =
      productMap.get(it.product_id) ??
      { productId: it.product_id, name: it.product_name, quantity: 0, total: 0, share: 0 };
    bucket.quantity += Number(it.quantity || 0);
    bucket.total += Number(it.total || 0);
    productMap.set(it.product_id, bucket);
  }
  const productSum = [...productMap.values()].reduce((a, b) => a + b.total, 0);
  const products = [...productMap.values()]
    .map((p) => ({ ...p, share: productSum ? p.total / productSum : 0 }))
    .sort((a, b) => b.total - a.total);

  const operators = [...operatorMap.values()]
    .map((o) => ({ ...o, avgTicket: o.sales ? o.total / o.sales : 0, share: totalSum ? o.total / totalSum : 0 }))
    .sort((a, b) => b.total - a.total);

  const bestDay =
    [...dayTotals.values()].sort((a, b) => b.total - a.total)[0] ?? null;

  const matrix = registers.map((r) => {
    const row = matrixMap.get(r.key) ?? new Map<string, number>();
    const byPeriod: Record<string, number> = {};
    for (const p of periods) byPeriod[p.key] = row.get(p.key) ?? 0;
    return { register: r.name, byPeriod, total: r.total };
  });

  return {
    granularity,
    from,
    to,
    totals: {
      sales: sales.length,
      items: itemSum,
      gross: grossSum,
      discount: discountSum,
      total: totalSum,
      avgTicket: sales.length ? totalSum / sales.length : 0,
      avgItemsPerSale: sales.length ? itemSum / sales.length : 0,
      bestDay,
      fiscalIssued,
      fiscalPending,
    },
    periods,
    registers,
    payments: paymentsAgg,
    products,
    operators,
    matrix,
    generatedAt: new Date(),
  };
}

// ── formatação compartilhada (tela, PDF e Excel falam a mesma língua) ────────

export function brl(value: number): string {
  return (Number.isFinite(value) ? value : 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(1).replace(".", ",")}%`;
}

export function qty(value: number): string {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

export function dateBR(d: Date): string {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function dateTimeBR(d: Date): string {
  return `${dateBR(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Nome de arquivo previsível: relatorio-vendas-dia-2026-08-01_2026-08-31. */
export function reportFileName(report: SalesReport, ext: string): string {
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `relatorio-vendas-${report.granularity}-${iso(report.from)}_${iso(report.to)}.${ext}`;
}
