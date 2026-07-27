/**
 * Testes do rate limit ad-hoc das RPCs sensíveis.
 *
 * Duas camadas:
 *  A) Sem sessão (papel `anon`) — o contador nunca deve ser alcançável nem
 *     vazar informação; as tentativas devem morrer na permissão, não no
 *     contador. Sempre executam.
 *  B) Com sessão (E2E_EMAIL/E2E_PASSWORD) — dispara tentativas inválidas
 *     suficientes para provocar o bloqueio real e valida a mensagem
 *     "Muitas tentativas". Pulado quando não há credenciais.
 *
 * Rodar: `bunx vitest run src/tests/rate-limit.test.ts`
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

const hasEnv = Boolean(SUPABASE_URL && SUPABASE_KEY);
const hasCreds = hasEnv && Boolean(EMAIL && PASSWORD);

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** Client anônimo de verdade: remove o Authorization implícito do SDK. */
const anon = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === `Bearer ${SUPABASE_KEY}`) headers.delete("Authorization");
      headers.set("apikey", SUPABASE_KEY);
      return fetch(input, { ...init, headers });
    },
  },
});

/** Helpers internos: só podem rodar de dentro das funções SECURITY DEFINER. */
const INTERNAL_HELPERS: Array<{ name: string; args: Record<string, unknown> }> = [
  {
    name: "enforce_rate_limit",
    args: { _function_name: "verify_admin_code", _store_id: null, _max_attempts: 1, _window_secs: 1, _block_secs: 1 },
  },
  {
    name: "register_rate_limit_failure",
    args: { _function_name: "verify_admin_code", _store_id: null, _max_attempts: 1, _window_secs: 1, _block_secs: 1 },
  },
  { name: "clear_rate_limit", args: { _function_name: "verify_admin_code", _store_id: null } },
];

describe.skipIf(!hasEnv)("Rate limit — superfície anônima", () => {
  it("bloqueia SELECT anônimo em rpc_rate_limits", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (anon as any).from("rpc_rate_limits").select("*").limit(1);
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });

  it("bloqueia INSERT anônimo em rpc_rate_limits", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (anon as any)
      .from("rpc_rate_limits")
      .insert({ user_id: ZERO_UUID, function_name: "fake", attempts: 0 });
    expect(error).not.toBeNull();
  });

  it.each(INTERNAL_HELPERS)("nega execução anônima de $name", async ({ name, args }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (anon as any).rpc(name, args);
    expect(error).not.toBeNull();
  });

  it("tentativas anônimas repetidas param na permissão, não no contador", async () => {
    const messages: string[] = [];
    for (let i = 0; i < 12; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (anon as any).rpc("verify_admin_code", {
        _store_id: ZERO_UUID,
        _code: "00000",
      });
      expect(error).not.toBeNull();
      messages.push(error?.message ?? "");
    }
    // "Não autenticado" (ou erro de permissão) — jamais um bloqueio por
    // tentativas, que revelaria que o contador aceita chamadas sem sessão.
    expect(messages.some((m) => /muitas tentativas/i.test(m))).toBe(false);
  });
});

describe.skipIf(!hasCreds)("Rate limit — bloqueio real com sessão", () => {
  let authed: SupabaseClient;
  let storeId = "";

  beforeAll(async () => {
    authed = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await authed.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (error) throw new Error(`Login de teste falhou: ${error.message}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (authed as any).from("user_roles").select("store_id").limit(1);
    storeId = data?.[0]?.store_id ?? "";
    if (!storeId) throw new Error("Usuário de teste não está vinculado a nenhuma loja.");
  }, 30_000);

  it(
    "bloqueia verify_admin_code após tentativas inválidas consecutivas",
    async () => {
      const messages: string[] = [];
      // O limite configurado é 8 em 300s; 10 tentativas garantem o bloqueio.
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (authed as any).rpc("verify_admin_code", {
          _store_id: storeId,
          _code: "99999",
        });
        if (error) messages.push(error.message);
      }
      expect(messages.some((m) => /muitas tentativas/i.test(m))).toBe(true);

      // O bloqueio precisa estar materializado e visível ao gestor.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (authed as any)
        .from("rpc_rate_limits")
        .select("function_name, attempts, blocked_until")
        .eq("function_name", "verify_admin_code")
        .eq("store_id", storeId)
        .limit(1);
      expect(data?.[0]?.attempts ?? 0).toBeGreaterThanOrEqual(8);
      expect(data?.[0]?.blocked_until).toBeTruthy();
    },
    60_000,
  );

  it("registra as tentativas negadas na trilha de auditoria", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (authed as any)
      .from("rpc_audit_log")
      .select("function_name, allowed")
      .eq("function_name", "verify_admin_code")
      .eq("allowed", false)
      .limit(1);
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});
