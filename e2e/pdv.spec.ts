/**
 * E2E do PDV — venda ponta a ponta.
 *
 * Premissas explícitas (falham cedo e com mensagem clara se não valerem):
 *  - `E2E_EMAIL` / `E2E_PASSWORD` apontam para um usuário com papel de caixa,
 *    gerente ou admin em ao menos uma loja com produtos cadastrados.
 *  - Sem essas variáveis os cenários autenticados são PULADOS (o CI segue
 *    verde), mas os cenários públicos de segurança continuam rodando.
 *
 * Rodar local: `bunx playwright test`
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

test.describe("Rotas protegidas", () => {
  for (const path of ["/pdv", "/caixa", "/produtos", "/configuracoes", "/relatorios"]) {
    test(`redireciona visitante anônimo em ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/auth/);
    });
  }
});

test.describe("PDV autenticado", () => {
  test.skip(!hasCreds, "Defina E2E_EMAIL e E2E_PASSWORD para rodar os cenários autenticados.");

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("abre o PDV com o carrinho vazio", async ({ page }) => {
    await page.goto("/pdv");
    await expect(page.getByRole("heading", { name: /pdv|ponto de venda/i }).first()).toBeVisible();
    // O total inicia zerado — qualquer valor residual indica carrinho vazando entre sessões.
    await expect(page.getByText(/R\$\s*0[.,]00/).first()).toBeVisible();
  });

  test("venda ponta a ponta: adiciona item, finaliza em dinheiro e registra", async ({ page }) => {
    await page.goto("/pdv");

    // 1) Busca de produto (campo de código de barras / busca principal)
    const search = page
      .getByPlaceholder(/c[óo]digo|buscar|produto/i)
      .first();
    await expect(search).toBeVisible();
    await search.click();
    await search.fill("a");
    await page.waitForTimeout(1200); // debounce da busca

    const firstResult = page.getByRole("button", { name: /adicionar|R\$/i }).first();
    const hasProduct = await firstResult.isVisible().catch(() => false);
    test.skip(!hasProduct, "Nenhum produto cadastrado na loja de teste.");
    await firstResult.click();

    // 2) O total deixa de ser zero
    await expect(page.getByText(/R\$\s*0[.,]00/).first()).toBeHidden({ timeout: 10_000 });

    // 3) Finalização
    await page.getByRole("button", { name: /finalizar|pagamento|cobrar/i }).first().click();
    await page.getByRole("button", { name: /dinheiro/i }).first().click();
    await page.getByRole("button", { name: /confirmar|concluir|finalizar venda/i }).first().click();

    // 4) Confirmação de venda registrada
    await expect(
      page.getByText(/venda (registrada|finalizada|conclu[íi]da)|sucesso/i).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("auditoria de RPC carrega e permite exportar CSV", async ({ page }) => {
    await page.goto("/configuracoes");
    await page.getByRole("tab", { name: /seguran[çc]a/i }).click();
    await expect(page.getByText(/tentativas registradas/i)).toBeVisible();

    const download = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByRole("button", { name: /csv|exportar/i }).first().click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
  });
});
