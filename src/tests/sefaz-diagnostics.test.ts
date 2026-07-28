import { describe, it, expect } from "vitest";
import { diagnoseSefazFailure } from "@/lib/sefaz-diagnostics";
describe("diagnose", () => {
  it("mapeia casos", () => {
    expect(diagnoseSefazFailure("Motor NFC-e não carregado (falta node-dfe).").code).toBe("engine_missing");
    expect(diagnoseSefazFailure("Agente Local não respondeu em 127.0.0.1:9100.").code).toBe("agent_offline");
    expect(diagnoseSefazFailure("Arquivo .pfx não encontrado").code).toBe("certificate");
    expect(diagnoseSefazFailure("Serviço em manutenção (cStat 108)").code).toBe("sefaz_down");
    expect(diagnoseSefazFailure("Failed to fetch").code).toBe("network");
    expect(diagnoseSefazFailure("blablabla").code).toBe("unknown");
  });
});
