/**
 * Motor de previsão de reposição (determinístico).
 *
 * Toda a matemática de "quanto tempo o estoque dura" e "até quando preciso
 * pedir" vive aqui, separada da IA. A IA apenas interpreta e prioriza estes
 * números — nunca inventa quantidades. Assim o comprador continua tendo
 * números auditáveis mesmo sem conexão com a IA.
 *
 * IMPORTANTE: este módulo é somente leitura/cálculo. Não escreve no banco.
 */

/** Entrada mínima por produto, vinda da view `v_reorder` + histórico de vendas. */
export interface ForecastInput {
  productId: string;
  name: string;
  unit: string;
  /** Estoque atual (pode ser fracionado em itens pesáveis). */
  currentStock: number;
  /** Estoque mínimo configurado no cadastro do produto. */
  minStock: number;
  /** Vendas somadas nos últimos 30 dias. */
  sold30d: number;
  /** Vendas somadas nos últimos 7 dias (para detectar tendência). */
  sold7d: number;
  /** Prazo de entrega em dias (produto ou fornecedor preferencial). */
  leadTimeDays: number;
  /** Sugestão de compra já calculada pela view (fallback). */
  suggestedQty: number;
  /** Fornecedor preferencial, quando existe vínculo. */
  supplierName: string | null;
  /** Custo unitário do fornecedor preferencial. */
  unitCost: number;
}

export type UrgencyLevel = "vencido" | "urgente" | "atencao" | "programar" | "tranquilo";

export interface ForecastResult extends ForecastInput {
  /** Média diária dos últimos 30 dias. */
  avgDaily30: number;
  /** Média diária dos últimos 7 dias. */
  avgDaily7: number;
  /**
   * Média diária ponderada usada na projeção: dá mais peso à semana recente
   * (60/40), porque é ela que captura mudança de demanda.
   */
  avgDailyWeighted: number;
  /** Variação percentual entre a semana recente e o mês (positivo = subindo). */
  trendPercent: number;
  /** Dias até o estoque chegar a zero (null = sem venda registrada). */
  daysUntilStockout: number | null;
  /** Data prevista de ruptura. */
  stockoutDate: Date | null;
  /**
   * Dias restantes para emitir o pedido sem furar estoque:
   * `daysUntilStockout - leadTime`. Negativo = pedido já está atrasado.
   */
  daysToOrder: number | null;
  /** Data-limite para o pedido chegar antes da ruptura. */
  orderByDate: Date | null;
  /** Ponto de pedido = consumo durante o lead time + estoque de segurança. */
  reorderPoint: number;
  /** Quantidade recomendada para cobrir `coverageTargetDays` de venda. */
  recommendedQty: number;
  /** Valor estimado do pedido recomendado. */
  estimatedCost: number;
  urgency: UrgencyLevel;
}

export interface ForecastOptions {
  /** Dias de cobertura desejados após a reposição. */
  coverageTargetDays?: number;
  /** Percentual de estoque de segurança sobre o consumo do lead time. */
  safetyFactor?: number;
  /** Data-base do cálculo (injetável para testes). */
  now?: Date;
}

const DAY_MS = 86_400_000;

function safeNumber(value: number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * DAY_MS);
}

/** Classifica a urgência a partir da folga para emitir o pedido. */
function classify(daysToOrder: number | null, currentStock: number): UrgencyLevel {
  if (currentStock <= 0) return "vencido";
  if (daysToOrder == null) return "tranquilo";
  if (daysToOrder <= 0) return "vencido";
  if (daysToOrder <= 2) return "urgente";
  if (daysToOrder <= 7) return "atencao";
  if (daysToOrder <= 20) return "programar";
  return "tranquilo";
}

export const URGENCY_META: Record<UrgencyLevel, { label: string; className: string; weight: number }> = {
  vencido:   { label: "Pedido atrasado", className: "bg-destructive/15 text-destructive border-destructive/40", weight: 0 },
  urgente:   { label: "Pedir hoje",      className: "bg-destructive/10 text-destructive border-destructive/30", weight: 1 },
  atencao:   { label: "Pedir na semana", className: "bg-warning/15 text-warning border-warning/40",             weight: 2 },
  programar: { label: "Programar",       className: "bg-primary/10 text-primary border-primary/30",             weight: 3 },
  tranquilo: { label: "Sem risco",       className: "bg-muted text-muted-foreground border-border",             weight: 4 },
};

/** Calcula a projeção de um único item. */
export function forecastItem(input: ForecastInput, options: ForecastOptions = {}): ForecastResult {
  const coverageTargetDays = options.coverageTargetDays ?? 30;
  const safetyFactor = options.safetyFactor ?? 0.3;
  const now = options.now ?? new Date();

  const currentStock = safeNumber(input.currentStock);
  const sold30d = Math.max(0, safeNumber(input.sold30d));
  const sold7d = Math.max(0, safeNumber(input.sold7d));
  const leadTimeDays = Math.max(0, safeNumber(input.leadTimeDays));

  const avgDaily30 = sold30d / 30;
  const avgDaily7 = sold7d / 7;
  // Peso maior na semana recente: reage a promoção, sazonalidade e queda real.
  const avgDailyWeighted = avgDaily30 === 0 && avgDaily7 === 0
    ? 0
    : avgDaily7 * 0.6 + avgDaily30 * 0.4;

  const trendPercent = avgDaily30 > 0
    ? ((avgDaily7 - avgDaily30) / avgDaily30) * 100
    : avgDaily7 > 0 ? 100 : 0;

  const daysUntilStockout = avgDailyWeighted > 0
    ? Math.max(0, currentStock / avgDailyWeighted)
    : null;

  const daysToOrder = daysUntilStockout == null
    ? null
    : daysUntilStockout - leadTimeDays;

  const reorderPoint = avgDailyWeighted * leadTimeDays * (1 + safetyFactor)
    + Math.max(0, safeNumber(input.minStock));

  const target = avgDailyWeighted * (coverageTargetDays + leadTimeDays);
  const computed = Math.ceil(Math.max(0, target - currentStock));
  const recommendedQty = computed > 0 ? computed : Math.max(0, Math.ceil(safeNumber(input.suggestedQty)));

  return {
    ...input,
    currentStock,
    sold30d,
    sold7d,
    leadTimeDays,
    avgDaily30,
    avgDaily7,
    avgDailyWeighted,
    trendPercent,
    daysUntilStockout,
    stockoutDate: daysUntilStockout == null ? null : addDays(now, daysUntilStockout),
    daysToOrder,
    orderByDate: daysToOrder == null ? null : addDays(now, daysToOrder),
    reorderPoint,
    recommendedQty,
    estimatedCost: recommendedQty * Math.max(0, safeNumber(input.unitCost)),
    urgency: classify(daysToOrder, currentStock),
  };
}

/** Calcula e ordena por urgência (mais crítico primeiro). */
export function forecastAll(inputs: ForecastInput[], options: ForecastOptions = {}): ForecastResult[] {
  const now = options.now ?? new Date();
  return inputs
    .map((item) => forecastItem(item, { ...options, now }))
    .sort((a, b) => {
      const w = URGENCY_META[a.urgency].weight - URGENCY_META[b.urgency].weight;
      if (w !== 0) return w;
      return (a.daysToOrder ?? 9_999) - (b.daysToOrder ?? 9_999);
    });
}

/** Texto curto de prazo para exibir na tabela. */
export function formatDaysToOrder(result: ForecastResult): string {
  if (result.daysToOrder == null) return "sem histórico";
  if (result.daysToOrder <= 0) return `atrasado ${Math.abs(Math.floor(result.daysToOrder))}d`;
  return `${Math.floor(result.daysToOrder)}d`;
}

export function formatDate(date: Date | null): string {
  if (!date) return "—";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
