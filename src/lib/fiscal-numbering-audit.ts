/**
 * Auditoria de numeração de NFC-e.
 *
 * A numeração é reservada atomicamente no banco (`reserve_nfce_number`), mas
 * a nota autorizada só é confiável se o número gravado em `invoices` for o
 * MESMO que foi reservado e transmitido à SEFAZ. Duas patologias importam:
 *
 *  - **Duplicidade**: dois registros com a mesma (ambiente, série, número).
 *    Na SEFAZ isso vira rejeição por duplicidade e, se ambas passaram, um
 *    problema fiscal real que precisa de cancelamento.
 *  - **Lacuna**: número reservado que nunca virou nota autorizada (caixa caiu
 *    no meio da transmissão). Precisa ser inutilizado junto à SEFAZ.
 *
 * Este módulo só lê e classifica — nenhuma correção é aplicada sozinha.
 */

import { supabase } from "@/integrations/supabase/client";

export interface NumberingRecord {
  id: string;
  sale_id: string | null;
  series: number;
  number: number;
  environment: string;
  status: string;
  access_key: string | null;
  terminal_key: string | null;
  created_at: string;
}

export interface DuplicateGroup {
  environment: string;
  series: number;
  number: number;
  records: NumberingRecord[];
  /** Terminais envolvidos — dois caixas na mesma numeração é o cenário grave. */
  terminals: string[];
}

export interface NumberingGap {
  environment: string;
  series: number;
  /** Intervalo ausente, inclusivo. */
  from: number;
  to: number;
  count: number;
}

export interface NumberingAuditReport {
  checkedAt: string;
  total: number;
  duplicates: DuplicateGroup[];
  gaps: NumberingGap[];
  /** Maior número emitido por (ambiente, série). */
  highest: { environment: string; series: number; number: number }[];
  /** Próximo número que a loja vai reservar (config atual). */
  nextNumber: number | null;
  nextSeries: number | null;
  /** A configuração está atrás da realidade? Reservar geraria duplicidade. */
  configBehind: boolean;
  ok: boolean;
}

const key = (env: string, series: number) => `${env}::${series}`;

/**
 * Roda a auditoria sobre as notas de uma loja.
 *
 * @param limit teto de notas analisadas (mais recentes primeiro).
 */
export async function auditNfceNumbering(storeId: string, limit = 2000): Promise<NumberingAuditReport> {
  const [invRes, cfgRes] = await Promise.all([
    supabase
      .from("invoices")
      .select("id, sale_id, series, number, environment, status, access_key, terminal_key, created_at")
      .eq("store_id", storeId)
      .eq("type", "nfce")
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("fiscal_configs")
      .select("nfce_series, nfce_next_number, environment")
      .eq("store_id", storeId)
      .maybeSingle(),
  ]);

  if (invRes.error) throw new Error(invRes.error.message);

  const records = (invRes.data ?? []) as NumberingRecord[];
  // Notas canceladas/inutilizadas ainda ocupam número — entram na análise.
  const counted = records.filter((r) => r.status !== "rascunho");

  // ── Duplicidades ────────────────────────────────────────────
  const buckets = new Map<string, NumberingRecord[]>();
  for (const r of counted) {
    const k = `${r.environment}::${r.series}::${r.number}`;
    const list = buckets.get(k);
    if (list) list.push(r);
    else buckets.set(k, [r]);
  }

  const duplicates: DuplicateGroup[] = [];
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    duplicates.push({
      environment: list[0].environment,
      series: list[0].series,
      number: list[0].number,
      records: list,
      terminals: Array.from(new Set(list.map((r) => r.terminal_key ?? "desconhecido"))),
    });
  }
  duplicates.sort((a, b) => b.number - a.number);

  // ── Lacunas por (ambiente, série) ───────────────────────────
  const bySeries = new Map<string, number[]>();
  for (const r of counted) {
    const k = key(r.environment, r.series);
    const list = bySeries.get(k);
    if (list) list.push(r.number);
    else bySeries.set(k, [r.number]);
  }

  const gaps: NumberingGap[] = [];
  const highest: NumberingAuditReport["highest"] = [];

  for (const [k, numbersRaw] of bySeries) {
    const [environment, seriesRaw] = k.split("::");
    const series = Number(seriesRaw);
    const numbers = Array.from(new Set(numbersRaw)).sort((a, b) => a - b);
    highest.push({ environment, series, number: numbers[numbers.length - 1] });

    for (let i = 1; i < numbers.length; i += 1) {
      const prev = numbers[i - 1];
      const curr = numbers[i];
      if (curr - prev > 1) {
        gaps.push({ environment, series, from: prev + 1, to: curr - 1, count: curr - prev - 1 });
      }
    }
  }
  gaps.sort((a, b) => b.from - a.from);

  // ── Configuração x realidade ────────────────────────────────
  const cfg = cfgRes.data as
    | { nfce_series: number | null; nfce_next_number: number | null; environment: string | null }
    | null;
  const nextSeries = cfg?.nfce_series ?? null;
  const nextNumber = cfg?.nfce_next_number ?? null;

  let configBehind = false;
  if (cfg && nextSeries !== null && nextNumber !== null) {
    const top = highest.find((h) => h.environment === (cfg.environment ?? "") && h.series === nextSeries);
    configBehind = Boolean(top && nextNumber <= top.number);
  }

  return {
    checkedAt: new Date().toISOString(),
    total: counted.length,
    duplicates,
    gaps,
    highest,
    nextNumber,
    nextSeries,
    configBehind,
    ok: duplicates.length === 0 && !configBehind,
  };
}

/** Resumo em uma linha para banner/badge. */
export function numberingSummary(report: NumberingAuditReport): string {
  if (report.duplicates.length > 0) {
    return `${report.duplicates.length} número(s) duplicado(s) — risco fiscal, revise imediatamente.`;
  }
  if (report.configBehind) {
    return "A numeração configurada está atrás da última nota emitida — a próxima reserva causaria duplicidade.";
  }
  if (report.gaps.length > 0) {
    const missing = report.gaps.reduce((s, g) => s + g.count, 0);
    return `Sem duplicidades. ${missing} número(s) sem nota — considere inutilizar junto à SEFAZ.`;
  }
  return `Numeração íntegra em ${report.total} nota(s) analisada(s).`;
}
