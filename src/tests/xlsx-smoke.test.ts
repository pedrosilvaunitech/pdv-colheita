import { describe, it, expect } from "vitest";
import { buildAuditWorkbook, buildRateLimitWorkbook, xlsxFilename } from "@/lib/audit-xlsx";
describe("xlsx", () => {
  it("gera planilha", async () => {
    const wb = await buildAuditWorkbook([
      { function_name: "verify_admin_code", allowed: false, user_id: "u1", store_id: "s1", detail: "=CMD()", created_at: new Date().toISOString() },
      { function_name: "verify_admin_code", allowed: true, user_id: "u2", store_id: "s1", detail: null, created_at: new Date().toISOString() },
    ], { store: { name: "Loja X", cnpj: "1", logoUrl: null }, labelFor: () => "Validação" });
    const buf = await wb.xlsx.writeBuffer();
    expect(buf.byteLength).toBeGreaterThan(1000);
    const ws = wb.getWorksheet("Auditoria RPC")!;
    expect(String(ws.getCell("A1").value)).toContain("Auditoria");
    expect(ws.autoFilter).toBeTruthy();
    const wb2 = await buildRateLimitWorkbook([{ function_name: "f", user_id: "u", attempts: 9, blocked_until: new Date(Date.now()+6e4).toISOString() }]);
    expect((await wb2.xlsx.writeBuffer()).byteLength).toBeGreaterThan(1000);
    expect(xlsxFilename("a","b")).toMatch(/\.xlsx$/);
  });
});
