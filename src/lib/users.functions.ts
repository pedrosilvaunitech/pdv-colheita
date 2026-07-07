import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const linkUserSchema = z.object({
  storeId: z.string().uuid(),
  email: z.string().trim().email().max(255),
  role: z.enum(["admin_dev", "admin", "gerente", "caixa", "estoquista"]),
});

export const linkUserToStore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => linkUserSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: linkedUserId, error } = await supabaseAdmin.rpc("link_user_to_store_by_email", {
      _manager_user_id: context.userId,
      _store_id: data.storeId,
      _email: data.email,
      _role: data.role,
    });
    if (error) throw new Error(error.message);
    return { userId: linkedUserId };
  });

const createUserSchema = z.object({
  storeId: z.string().uuid(),
  email: z.string().trim().email().max(255),
  password: z.string().min(6).max(100),
  fullName: z.string().trim().min(1).max(200),
  role: z.enum(["admin_dev", "admin", "gerente", "caixa", "estoquista"]),
});

export const createUserByAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => createUserSchema.parse(data))
  .handler(async ({ data, context }) => {
    // Autorização: só admin/admin_dev/gerente da loja pode criar usuário
    const { data: canManage, error: roleErr } = await context.supabase.rpc("can_manage_store", {
      _user_id: context.userId,
      _store_id: data.storeId,
    });
    if (roleErr) throw new Error(roleErr.message);
    if (!canManage) throw new Error("Sem permissão para criar usuários nesta loja.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1) cria (ou reaproveita) o usuário
    let userId: string | null = null;
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.fullName },
    });
    if (createErr) {
      // Se já existe, buscar pelo email e vincular
      if (/already been registered|already exists/i.test(createErr.message)) {
        const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
        if (listErr) throw new Error(listErr.message);
        const found = list.users.find((u) => (u.email ?? "").toLowerCase() === data.email.toLowerCase());
        if (!found) throw new Error("Usuário já existe mas não pôde ser localizado.");
        userId = found.id;
      } else {
        throw new Error(createErr.message);
      }
    } else {
      userId = created.user.id;
    }
    if (!userId) throw new Error("Falha ao criar/localizar usuário.");

    // 2) garante profile
    await supabaseAdmin.from("profiles").upsert(
      { id: userId, full_name: data.fullName, email: data.email },
      { onConflict: "id" },
    );

    // 3) vincula à loja
    const { error: linkErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: userId, store_id: data.storeId, role: data.role });
    if (linkErr && !/duplicate key/i.test(linkErr.message)) throw new Error(linkErr.message);

    return { userId };
  });

export const cleanupOrphanLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.rpc("cleanup_orphan_user_links", {
      _manager_user_id: context.userId,
    });
    if (error) throw new Error(error.message);
    return data as {
      removed_missing_store: number;
      removed_missing_user: number;
      fixed_defaults: number;
      fixed_admin_links: number;
    };
  });

const deleteUserSchema = z.object({ userId: z.string().uuid() });

export const deleteUserAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => deleteUserSchema.parse(d))
  .handler(async ({ data, context }) => {
    if (data.userId === context.userId) throw new Error("Não é possível excluir sua própria conta por aqui.");
    // Autorização: precisa ser admin/admin_dev/gerente em pelo menos UMA loja comum ao usuário-alvo.
    const { data: sharedRoles, error: shErr } = await context.supabase
      .from("user_roles")
      .select("store_id")
      .eq("user_id", data.userId);
    if (shErr) throw new Error(shErr.message);
    let allowed = false;
    for (const r of sharedRoles ?? []) {
      const { data: ok } = await context.supabase.rpc("can_manage_store", {
        _user_id: context.userId,
        _store_id: r.store_id,
      });
      if (ok) { allowed = true; break; }
    }
    if (!allowed) throw new Error("Sem permissão para excluir este usuário.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
