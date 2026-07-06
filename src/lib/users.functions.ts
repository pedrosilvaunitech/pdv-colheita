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
