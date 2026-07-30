/**
 * Permissões efetivas do usuário logado na loja atual.
 *
 * A fonte da verdade é a função `user_store_permissions` no banco (SECURITY
 * DEFINER): ela combina o papel (`admin_dev`/`admin`/`gerente`/`caixa`/
 * `estoquista`) com os overrides individuais gravados em `user_store_codes`.
 * O front NUNCA decide permissão sozinho — aqui só espelhamos a decisão do
 * banco para desabilitar controles e evitar que o operador tente uma ação que
 * a RLS vai recusar depois.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "admin_dev" | "admin" | "gerente" | "caixa" | "estoquista";

export interface StorePermissions {
  /** Acesso irrestrito às ações da loja. */
  canAll: boolean;
  canSangria: boolean;
  canOpenCloseCash: boolean;
  /** Pode alterar configurações sensíveis (fiscal, servidor, hardware da loja). */
  canManageSettings: boolean;
  role: AppRole | null;
}

const DENIED: StorePermissions = {
  canAll: false,
  canSangria: false,
  canOpenCloseCash: false,
  canManageSettings: false,
  role: null,
};

/**
 * @param storeId loja corrente; sem loja a consulta fica desabilitada e o
 *                resultado é "negado", que é o padrão seguro.
 */
export function useStorePermissions(storeId: string | null | undefined) {
  const query = useQuery({
    queryKey: ["store-permissions", storeId],
    enabled: Boolean(storeId),
    staleTime: 60_000,
    queryFn: async (): Promise<StorePermissions> => {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth.user?.id;
      if (!userId || !storeId) return DENIED;

      const { data, error } = await supabase.rpc("user_store_permissions", {
        _user_id: userId,
        _store_id: storeId,
      });
      if (error) throw new Error(error.message);

      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return DENIED;

      const role = (row.role ?? null) as AppRole | null;
      const canAll = Boolean(row.can_all);
      return {
        canAll,
        canSangria: Boolean(row.can_sangria) || canAll,
        canOpenCloseCash: Boolean(row.can_open_close_cash) || canAll,
        canManageSettings:
          canAll || role === "admin_dev" || role === "admin" || role === "gerente",
        role,
      };
    },
  });

  return {
    permissions: query.data ?? DENIED,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
    refetch: query.refetch,
  };
}
