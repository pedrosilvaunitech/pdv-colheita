/**
 * Testes de concorrência da emissão fiscal.
 *
 * Cobrem os três invariantes que impedem nota duplicada e excesso de conexões:
 *  1. o semáforo nunca deixa passar mais que o limite de transmissões;
 *  2. chamadas concorrentes para a mesma venda compartilham uma execução;
 *  3. a política de retentativa classifica e escalona corretamente.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_SEFAZ_CONNECTIONS,
  currentSefazConnections,
  singleFlight,
  withSefazSlot,
} from "@/lib/sefaz-connection";
import { classifyFiscalError, decideRetry } from "@/lib/fiscal-retry-policy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("semáforo de conexões SEFAZ", () => {
  it("nunca ultrapassa o limite de transmissões simultâneas", async () => {
    let peak = 0;
    const tasks = Array.from({ length: 20 }, () =>
      withSefazSlot(async () => {
        peak = Math.max(peak, currentSefazConnections());
        await sleep(5);
        return true;
      }),
    );
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(MAX_SEFAZ_CONNECTIONS);
    expect(currentSefazConnections()).toBe(0);
  });

  it("libera o slot mesmo quando a transmissão falha", async () => {
    await expect(
      withSefazSlot(async () => {
        throw new Error("SEFAZ fora do ar");
      }),
    ).rejects.toThrow("SEFAZ fora do ar");
    expect(currentSefazConnections()).toBe(0);
  });
});

describe("deduplicação por venda", () => {
  it("emite uma única vez quando a mesma venda é despachada em paralelo", async () => {
    let runs = 0;
    const emit = () =>
      singleFlight("venda-1", async () => {
        runs += 1;
        await sleep(10);
        return runs;
      });

    const [a, b, c] = await Promise.all([emit(), emit(), emit()]);
    expect(runs).toBe(1);
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it("vendas diferentes emitem em paralelo", async () => {
    let runs = 0;
    const emit = (id: string) =>
      singleFlight(id, async () => {
        runs += 1;
        await sleep(5);
        return id;
      });
    const out = await Promise.all([emit("v1"), emit("v2"), emit("v3")]);
    expect(runs).toBe(3);
    expect(out).toEqual(["v1", "v2", "v3"]);
  });

  it("permite nova emissão depois que a anterior termina", async () => {
    let runs = 0;
    const emit = () => singleFlight("venda-2", async () => (runs += 1));
    await emit();
    await emit();
    expect(runs).toBe(2);
  });
});

describe("política de retentativa", () => {
  it("classifica os erros conhecidos", () => {
    expect(classifyFiscalError("Agente local offline.")).toBe("transient");
    expect(classifyFiscalError("Serviço em manutenção (cStat 108)")).toBe("sefaz_down");
    expect(classifyFiscalError("cStat 656 consumo indevido")).toBe("throttled");
    expect(classifyFiscalError("Rejeição: certificado vencido")).toBe("permanent");
    expect(classifyFiscalError("blablabla")).toBe("unknown");
  });

  it("rejeição de conteúdo sai do ciclo automático", () => {
    const d = decideRetry("Rejeição: CSC inválido", 1);
    expect(d.permanent).toBe(true);
    expect(d.retryable).toBe(false);
    expect(d.delayMs).toBe(0);
  });

  it("aumenta a espera a cada tentativa e recua mais em throttling", () => {
    const first = decideRetry("Failed to fetch", 1).delayMs;
    const third = decideRetry("Failed to fetch", 3).delayMs;
    expect(third).toBeGreaterThan(first);

    const throttled = decideRetry("HTTP 429 rate limit", 1).delayMs;
    expect(throttled).toBeGreaterThan(first);
  });

  it("desiste após esgotar o teto de tentativas", () => {
    const d = decideRetry("Failed to fetch", 99);
    expect(d.permanent).toBe(true);
    expect(d.reason).toMatch(/Limite/);
  });
});
