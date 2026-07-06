import { useEffect, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

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
  });
}

export function useCurrentStoreId() {
  const [storeId, setStoreId] = useState<string | null>(null);
  const { data: stores } = useStores();

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem(KEY) : null;
    if (saved && stores?.some((s) => s.id === saved)) {
      setStoreId(saved);
    } else if (stores && stores.length > 0) {
      setStoreId(stores[0].id);
      localStorage.setItem(KEY, stores[0].id);
    } else {
      setStoreId(null);
    }
  }, [stores]);

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
