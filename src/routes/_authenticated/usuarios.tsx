import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useStores } from "@/lib/current-store";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/usuarios")({
  component: UsuariosPage,
});

function UsuariosPage() {
  const { data: stores = [] } = useStores();
  const [storeFilter, setStoreFilter] = useState<string>("__all__");

  const storeIds = useMemo(() => stores.map((s) => s.id), [stores]);

  const { data: roles = [] } = useQuery({
    queryKey: ["roles-all", storeIds],
    enabled: storeIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("id,user_id,role,created_at,store_id")
        .in("store_id", storeIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  const userIds = useMemo(() => Array.from(new Set(roles.map((r) => r.user_id))), [roles]);

  const { data: profiles = [] } = useQuery({
    queryKey: ["profiles-of-roles", userIds],
    enabled: userIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", userIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  const profileMap = useMemo(() => Object.fromEntries(profiles.map((p) => [p.id, p])), [profiles]);
  const storeMap = useMemo(() => Object.fromEntries(stores.map((s) => [s.id, s])), [stores]);

  const filtered = storeFilter === "__all__" ? roles : roles.filter((r) => r.store_id === storeFilter);

  return (
    <div>
      <PageHeader
        title="Usuários & papéis"
        description="Todos os usuários e papéis de todas as lojas às quais você tem acesso."
      />
      <div className="p-6 space-y-4">
        <div className="border border-border rounded-md bg-card p-4 text-xs text-muted-foreground">
          Para adicionar um novo usuário: peça para ele criar conta em <b>Entrar → Criar conta</b>, depois um admin da loja concede o papel.
        </div>

        <div className="flex items-end gap-3">
          <div className="w-72">
            <Label className="text-xs">Filtrar por loja</Label>
            <Select value={storeFilter} onValueChange={setStoreFilter}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todas as lojas ({stores.length})</SelectItem>
                {stores.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.fantasy_name || s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="text-xs text-muted-foreground pb-2">
            {filtered.length} vínculo(s) · {new Set(filtered.map((r) => r.user_id)).size} usuário(s)
          </div>
        </div>

        <div className="border border-border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Usuário</TableHead>
              <TableHead>Loja</TableHead>
              <TableHead className="w-32">Papel</TableHead>
              <TableHead className="w-40">Desde</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center py-10 text-sm text-muted-foreground">
                  {stores.length === 0 ? "Cadastre uma loja primeiro." : "Sem papéis registrados."}
                </TableCell></TableRow>
              )}
              {filtered.map((r) => {
                const p = profileMap[r.user_id];
                const s = storeMap[r.store_id];
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="text-sm">{p?.full_name || <span className="text-muted-foreground">sem nome</span>}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{r.user_id}</div>
                    </TableCell>
                    <TableCell className="text-sm">{s?.fantasy_name || s?.name || <span className="text-muted-foreground font-mono text-[10px]">{r.store_id}</span>}</TableCell>
                    <TableCell><RoleBadge role={r.role} /></TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{new Date(r.created_at).toLocaleString("pt-BR")}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, string> = {
    admin: "border-primary/40 text-primary",
    gerente: "border-info/40 text-info",
    caixa: "border-warning/40 text-warning",
    estoquista: "border-muted-foreground/40 text-muted-foreground",
  };
  return <Badge variant="outline" className={map[role] || ""}>{role}</Badge>;
}
