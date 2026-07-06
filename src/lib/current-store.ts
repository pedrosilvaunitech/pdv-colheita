import { useEffect, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const KEY = "bastion:current-store";

export interface StoreRow {
  id: string;
  name: string;
  fantasy_name: string | null;
  cnpj: string | null;
  ie: string | null;
  city: string | null;
  state: string | null;
  tax_regime: string;
}

export function useStores() {
  return useQuery({
    queryKey: ["stores"],
    queryFn: async (): Promise<StoreRow[]> => {
      const { data, error } = await supabase
        .from("stores")
        .select("id,name,fantasy_name,cnpj,ie,city,state,tax_regime")
        .order("name");
      if (error) throw error;
      return (data ?? []) as StoreRow[];
    },
    refetchOnWindowFocus: true,
  });
}

export function useMyProfile() {
  return useQuery({
    queryKey: ["my-profile"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, default_store_id")
        .eq("id", u.user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useSetDefaultStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (storeId: string) => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Sem sessão");
      const { error } = await supabase
        .from("profiles")
        .update({ default_store_id: storeId })
        .eq("id", u.user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Loja padrão definida");
      qc.invalidateQueries({ queryKey: ["my-profile"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCurrentStoreId() {
  const [storeId, setStoreId] = useState<string | null>(null);
  const { data: stores } = useStores();
  const { data: profile } = useMyProfile();

  useEffect(() => {
    if (!stores) return;
    const saved = typeof window !== "undefined" ? localStorage.getItem(KEY) : null;
    const preferred = profile?.default_store_id;

    let next: string | null = null;
    if (preferred && stores.some((s) => s.id === preferred)) next = preferred;
    else if (saved && stores.some((s) => s.id === saved)) next = saved;
    else if (stores.length > 0) next = stores[0].id;

    setStoreId(next);
    if (next) localStorage.setItem(KEY, next);
  }, [stores, profile?.default_store_id]);

  const change = useCallback((id: string) => {
    localStorage.setItem(KEY, id);
    setStoreId(id);
    window.dispatchEvent(new Event("bastion:store-changed"));
  }, []);

  useEffect(() => {
    const h = () => {
      const s = localStorage.getItem(KEY);
      if (s) setStoreId(s);
    };
    window.addEventListener("bastion:store-changed", h);
    return () => window.removeEventListener("bastion:store-changed", h);
  }, []);

  return { storeId, setStoreId: change, stores: stores ?? [] };
}

export function useCurrentStore() {
  const { storeId, stores, setStoreId } = useCurrentStoreId();
  const current = stores.find((s) => s.id === storeId) ?? null;
  return { store: current, storeId, stores, setStoreId };
}
