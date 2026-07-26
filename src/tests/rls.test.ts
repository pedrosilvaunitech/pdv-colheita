/**
 * Testes automatizados de RLS / superfície pública.
 *
 * Executam com a chave publishable (papel `anon`), exatamente como um
 * atacante não autenticado veria a API. A premissa do app é simples:
 * NENHUMA tabela e NENHUMA função sensível pode responder sem login.
 *
 * Rodar: `bunx vitest run src/tests/rls.test.ts`
 */
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

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

/** Toda tabela do schema público exposta pela Data API. */
const TABLES = [
  "cash_movements", "cash_registers", "comanda_items", "comandas", "customers",
  "drawer_events", "fiscal_checklist", "fiscal_configs", "invoices", "pix_charges",
  "pix_configs", "print_logs", "product_stocks", "products", "profiles",
  "purchase_items", "purchases", "receipt_settings", "rpc_audit_log", "sale_items",
  "sale_payments", "sales", "stock_movements", "stores", "suppliers",
  "user_roles", "user_store_codes",
] as const;

/** Funções SECURITY DEFINER que jamais podem ser chamadas sem sessão. */
const RPCS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: "verify_admin_code", args: { _store_id: "00000000-0000-0000-0000-000000000000", _code: "00000" } },
  { name: "lookup_admin_code", args: { _code: "00000" } },
  { name: "has_role", args: { _user_id: "00000000-0000-0000-0000-000000000000", _store_id: "00000000-0000-0000-0000-000000000000", _role: "admin" } },
  { name: "has_store_access", args: { _user_id: "00000000-0000-0000-0000-000000000000", _store_id: "00000000-0000-0000-0000-000000000000" } },
  { name: "can_manage_store", args: { _user_id: "00000000-0000-0000-0000-000000000000", _store_id: "00000000-0000-0000-0000-000000000000" } },
  { name: "can_operate_pdv", args: { _user_id: "00000000-0000-0000-0000-000000000000", _store_id: "00000000-0000-0000-0000-000000000000" } },
  { name: "set_store_master_password", args: { _store_id: "00000000-0000-0000-0000-000000000000", _password: "hack" } },
  { name: "regenerate_admin_code", args: { _store_id: "00000000-0000-0000-0000-000000000000", _user_id: "00000000-0000-0000-0000-000000000000" } },
  { name: "set_user_store_permissions", args: { _store_id: "00000000-0000-0000-0000-000000000000", _user_id: "00000000-0000-0000-0000-000000000000", _can_all: true, _can_sangria: true, _can_open_close_cash: true } },
  { name: "reserve_nfce_number", args: { _store_id: "00000000-0000-0000-0000-000000000000" } },
  { name: "cleanup_orphan_user_links", args: {} },
  { name: "log_rpc_attempt", args: { _function_name: "fake", _store_id: null, _allowed: true, _detail: "x" } },
];

const hasEnv = Boolean(SUPABASE_URL && SUPABASE_KEY);

describe.skipIf(!hasEnv)("RLS — leitura anônima", () => {
  it.each(TABLES)("bloqueia SELECT anônimo em %s", async (table) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (anon as any).from(table).select("*").limit(1);
    // Ou o PostgREST nega (permissão/RLS) ou a RLS devolve conjunto vazio.
    // Vazamento = qualquer linha retornada sem sessão.
    expect(error ? [] : (data ?? [])).toHaveLength(0);
  });
});

describe.skipIf(!hasEnv)("RLS — escrita anônima", () => {
  it.each(["sales", "products", "stores", "user_roles", "rpc_audit_log"] as const)(
    "bloqueia INSERT anônimo em %s",
    async (table) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (anon as any).from(table).insert({ id: "00000000-0000-0000-0000-000000000000" });
      expect(error).toBeTruthy();
    },
  );
});

describe.skipIf(!hasEnv)("RPC — superfície SECURITY DEFINER", () => {
  it.each(RPCS.map((r) => [r.name, r.args] as const))(
    "bloqueia execução anônima de %s",
    async (name, args) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (anon as any).rpc(name, args);
      expect(error, `${name} respondeu sem autenticação`).toBeTruthy();
    },
  );
});
