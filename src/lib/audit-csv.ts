/**
 * Geração de CSV da auditoria de RPC.
 *
 * Fica isolado do componente por dois motivos:
 *  1. é lógica pura e determinística → testável sem DOM;
 *  2. o mesmo formato é reaproveitado pela exportação de bloqueios.
 *
 * Formato: RFC 4180 com delimitador `;` (padrão pt-BR do Excel), CRLF,
 * BOM UTF-8 e a diretiva `sep=;` na primeira linha — sem ela o Excel em
 * locales que usam `,` ignora o delimitador e joga tudo numa coluna só.
 */

export interface AuditCsvRow {
  function_name: string;
  allowed: boolean;
  user_id: string | null;
  store_id: string | null;
  detail: string | null;
  created_at: string;
}

export interface RateLimitCsvRow {
  function_name: string;
  user_id: string;
  attempts: number;
  blocked_until: string | null;
}

/** Escapa um campo no padrão RFC 4180 (sempre entre aspas). */
function esc(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  // Prefixo defensivo contra CSV injection em planilhas (=, +, -, @, tab, CR).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const body = rows.map((cols) => cols.map(esc).join(";"));
  return "\uFEFF" + ["sep=;", header.map(esc).join(";"), ...body].join("\r\n") + "\r\n";
}

function localDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR");
}

/**
 * Monta o CSV da trilha de auditoria.
 * `labelFor` traduz o nome técnico da função para o rótulo exibido na tela,
 * garantindo que o arquivo bata exatamente com o que o usuário viu.
 */
export function buildAuditCsv(
  rows: readonly AuditCsvRow[],
  labelFor: (fn: string) => string = (fn) => fn,
): string {
  return toCsv(
    ["data_hora", "data_hora_iso", "funcao", "funcao_tecnica", "resultado", "usuario", "loja", "detalhe"],
    rows.map((r) => [
      localDateTime(r.created_at),
      r.created_at,
      labelFor(r.function_name),
      r.function_name,
      r.allowed ? "permitida" : "negada",
      r.user_id ?? "",
      r.store_id ?? "",
      r.detail ?? "",
    ]),
  );
}

/** Monta o CSV dos bloqueios de rate limit ativos. */
export function buildRateLimitCsv(
  rows: readonly RateLimitCsvRow[],
  labelFor: (fn: string) => string = (fn) => fn,
): string {
  return toCsv(
    ["funcao", "funcao_tecnica", "usuario", "tentativas", "bloqueado_ate", "bloqueado_ate_iso"],
    rows.map((r) => [
      labelFor(r.function_name),
      r.function_name,
      r.user_id,
      r.attempts,
      r.blocked_until ? localDateTime(r.blocked_until) : "",
      r.blocked_until ?? "",
    ]),
  );
}

/** Nome de arquivo estável e ordenável: `auditoria-rpc-negadas-2026-07-27-1432.csv`. */
export function csvFilename(prefix: string, suffix?: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return [prefix, suffix, stamp].filter(Boolean).join("-") + ".csv";
}

/** Dispara o download no browser. Isolado para o componente ficar declarativo. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
