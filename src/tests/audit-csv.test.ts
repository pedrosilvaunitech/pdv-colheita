/**
 * Testes da geração de CSV da auditoria (lógica pura, sem rede).
 * Rodar: `bunx vitest run src/tests/audit-csv.test.ts`
 */
import { describe, it, expect } from "vitest";
import {
  buildAuditCsv,
  buildRateLimitCsv,
  csvFilename,
  type AuditCsvRow,
} from "@/lib/audit-csv";

const row = (over: Partial<AuditCsvRow> = {}): AuditCsvRow => ({
  function_name: "verify_admin_code",
  allowed: false,
  user_id: "11111111-1111-1111-1111-111111111111",
  store_id: "22222222-2222-2222-2222-222222222222",
  detail: "código inválido",
  created_at: "2026-07-27T12:00:00.000Z",
  ...over,
});

describe("buildAuditCsv", () => {
  it("emite BOM, diretiva sep e cabeçalho completo", () => {
    const csv = buildAuditCsv([row()]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.split("\r\n")[0]).toBe("\uFEFFsep=;");
    expect(csv).toContain('"data_hora_iso"');
    expect(csv).toContain('"funcao_tecnica"');
  });

  it("traduz o rótulo mas preserva o nome técnico", () => {
    const csv = buildAuditCsv([row()], () => "Validação de código admin");
    expect(csv).toContain('"Validação de código admin"');
    expect(csv).toContain('"verify_admin_code"');
  });

  it("marca permitida/negada corretamente", () => {
    expect(buildAuditCsv([row({ allowed: true })])).toContain('"permitida"');
    expect(buildAuditCsv([row({ allowed: false })])).toContain('"negada"');
  });

  it("escapa aspas e quebras de linha sem corromper colunas", () => {
    const csv = buildAuditCsv([row({ detail: 'tem "aspas"\ne quebra' })]);
    expect(csv).toContain('"tem ""aspas""\ne quebra"');
    // 1 BOM/sep + cabeçalho + 1 registro (a quebra fica dentro das aspas).
    expect(csv.trimEnd().split("\r\n")).toHaveLength(3);
  });

  it("neutraliza fórmulas (CSV injection)", () => {
    const csv = buildAuditCsv([row({ detail: "=HYPERLINK(1)" })]);
    expect(csv).toContain(`"'=HYPERLINK(1)"`);
  });

  it("aceita campos nulos", () => {
    const csv = buildAuditCsv([row({ user_id: null, store_id: null, detail: null })]);
    expect(csv).toContain('"";"";""');
  });
});

describe("buildRateLimitCsv", () => {
  it("exporta tentativas e janela de bloqueio", () => {
    const csv = buildRateLimitCsv([
      {
        function_name: "verify_admin_code",
        user_id: "u1",
        attempts: 8,
        blocked_until: "2026-07-27T12:10:00.000Z",
      },
    ]);
    expect(csv).toContain('"8"');
    expect(csv).toContain('"2026-07-27T12:10:00.000Z"');
  });
});

describe("csvFilename", () => {
  it("inclui prefixo, sufixo e carimbo de tempo", () => {
    const name = csvFilename("auditoria-rpc", "negadas", new Date(2026, 6, 27, 14, 32));
    expect(name).toBe("auditoria-rpc-negadas-2026-07-27-1432.csv");
  });

  it("omite o sufixo quando ausente", () => {
    expect(csvFilename("bloqueios", undefined, new Date(2026, 0, 5, 9, 4))).toBe(
      "bloqueios-2026-01-05-0904.csv",
    );
  });
});
