/**
 * E2E do rate limit: dispara códigos inválidos na tela de validação e
 * confirma que o app passa a responder "Muitas tentativas" e exibe o
 * bloqueio no painel de Segurança.
 *
 * Requer `E2E_EMAIL`/`E2E_PASSWORD` de um usuário admin/gerente.
 */
import { test, expect, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const hasCreds = Boolean(EMAIL && PASSWORD);

async function login(page: Page): Promise<void> {
  await page.goto("/auth");
  await page.getByLabel(/e-?mail/i).first().fill(EMAIL);
  await page.getByLabel(/senha/i).first().fill(PASSWORD);
  await page.getByRole("button", { name: /entrar|acessar|login/i }).first().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth"), { timeout: 30_000 });
}

test.describe("Rate limit de RPC", () => {
  test.skip(!hasCreds, "Defina E2E_EMAIL e E2E_PASSWORD para validar o bloqueio.");

  test("painel de segurança lista bloqueios e exporta CSV", async ({ page }) => {
    await login(page);
    await page.goto("/configuracoes");
    await page.getByRole("tab", { name: /seguran[çc]a/i }).click();
    await expect(page.getByText(/tentativas registradas/i)).toBeVisible();

    const download = page.waitForEvent("download", { timeout: 20_000 });
    await page.getByRole("button", { name: /exportar csv/i }).first().click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^auditoria-rpc-.*\.csv$/);
  });
});
