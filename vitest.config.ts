import { defineConfig } from "vitest/config";

/**
 * Vitest cuida apenas dos testes unitários/integração em `src/`.
 * Os specs de `e2e/` pertencem ao Playwright (`bun run test:e2e`).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**", ".output/**"],
    environment: "node",
  },
});
