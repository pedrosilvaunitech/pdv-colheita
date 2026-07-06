import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useStores } from "@/lib/current-store";
import { linkUserToStore, cleanupOrphanLinks } from "@/lib/users.functions";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, UserPlus, Star, RefreshCw, ShieldAlert, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

export const Route = createFileRoute("/_authenticated/usuarios")({
  component: UsuariosPage,
});

type AppRole = Database["public"]["Enums"]["app_role"];

const linkSchema = z.object({
  storeId: z.string().uuid("Selecione uma loja"),
  email: z.string().trim().email("Email inválido"),
  role: z.enum(["admin_dev", "admin", "gerente", "caixa", "estoquista"]),
});

function UsuariosPage() {
  const qc = useQueryClient();
  const { data: stores = [], isLoading: storesLoading } = useStores();
  const [storeFilter, setStoreFilter] = useState<string>("__all__");
  const [linkOpen, setLinkOpen] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  useEffect(() => { supabase.auth.getUser().then((r) => setCurrentUserId(r.data.user?.id ?? null)); }, []);

  const storeIds = useMemo(() => stores.map((s) => s.id), [stores]);

  const { data: roles = [], isLoading: rolesLoading } = useQuery({
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

  const { data: profiles = [], isLoading: profilesLoading } = useQuery({
    queryKey: ["profiles-of-roles", userIds],
    enabled: userIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email, default_store_id")
        .in("id", userIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  const profileMap = useMemo(() => Object.fromEntries(profiles.map((p) => [p.id, p])), [profiles]);
  const storeMap = useMemo(() => Object.fromEntries(stores.map((s) => [s.id, s])), [stores]);

  const filtered = storeFilter === "__all__" ? roles : roles.filter((r) => r.store_id === storeFilter);
  const loading = storesLoading || rolesLoading || profilesLoading;

  const linkUser = useMutation({
    mutationFn: async (payload: z.infer<typeof linkSchema>) => linkUserToStore({ data: payload }),
    onSuccess: async () => {
      toast.success("Usuário vinculado à loja");
      setLinkOpen(false);
      await qc.invalidateQueries({ queryKey: ["roles-all"] });
      await qc.invalidateQueries({ queryKey: ["profiles-of-roles"] });
      await qc.invalidateQueries({ queryKey: ["stores"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const setDefault = useMutation({
    mutationFn: async (payload: { userId: string; storeId: string }) => {
      const { error } = await supabase.from("profiles").update({ default_store_id: payload.storeId }).eq("id", payload.userId);
      if (error) throw error;
    },
    onSuccess: async () => { toast.success("Loja padrão do usuário atualizada"); await qc.invalidateQueries({ queryKey: ["profiles-of-roles"] }); await qc.invalidateQueries({ queryKey: ["my-profile"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Usuários & papéis"
        description="Todos os usuários e papéis de todas as lojas às quais você tem acesso."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="gap-2" onClick={() => { qc.invalidateQueries({ queryKey: ["roles-all"] }); qc.invalidateQueries({ queryKey: ["profiles-of-roles"] }); qc.invalidateQueries({ queryKey: ["stores"] }); toast.success("Atualizado"); }}>
              <RefreshCw className="size-4" /> Atualizar
            </Button>
            <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-2" disabled={stores.length === 0}>
                  <UserPlus className="size-4" /> Vincular usuário
                </Button>
              </DialogTrigger>
              <LinkUserDialog
                stores={stores}
                loading={linkUser.isPending}
                onSubmit={(payload) => linkUser.mutate(payload)}
              />
            </Dialog>
          </div>
        }
      />
      <div className="p-6 space-y-4">
        <Tabs defaultValue="lista">
          <TabsList>
            <TabsTrigger value="lista">Lista de vínculos</TabsTrigger>
            <TabsTrigger value="auditoria">Auditoria</TabsTrigger>
          </TabsList>

          <TabsContent value="lista" className="mt-4 space-y-4">
            <div className="border border-border rounded-md bg-card p-4 text-xs text-muted-foreground">
              Para adicionar um usuário: ele cria a conta em <b>Entrar → Criar conta</b>, depois um admin/gerente vincula o e-mail a uma loja.
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
              <TableHead className="w-40">Loja padrão</TableHead>
              <TableHead className="w-40">Desde</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center py-10 text-sm text-muted-foreground">
                  {loading ? "Carregando usuários e vínculos..." : stores.length === 0 ? "Nenhuma loja cadastrada. Cadastre uma loja primeiro." : "Sem usuários vinculados para este filtro."}
                </TableCell></TableRow>
              )}
              {filtered.map((r) => {
                const p = profileMap[r.user_id];
                const s = storeMap[r.store_id];
                const isDefault = p?.default_store_id === r.store_id;
                const canSetOwn = currentUserId === r.user_id;
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="text-sm flex items-center gap-2">
                        {p?.full_name || <span className="text-muted-foreground">sem nome</span>}
                        {canSetOwn && <Badge variant="outline" className="border-primary/40 text-primary text-[10px]">você</Badge>}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground">{p?.email || r.user_id}</div>
                    </TableCell>
                    <TableCell className="text-sm">{s?.fantasy_name || s?.name || <span className="text-muted-foreground font-mono text-[10px]">{r.store_id}</span>}</TableCell>
                    <TableCell><RoleBadge role={r.role} /></TableCell>
                    <TableCell>
                      {isDefault ? (
                        <Badge variant="outline" className="border-primary/40 text-primary gap-1"><Star className="size-3" /> Padrão</Badge>
                      ) : canSetOwn ? (
                        <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => setDefault.mutate({ userId: r.user_id, storeId: r.store_id })}>
                          <Star className="size-3" /> Definir
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{new Date(r.created_at).toLocaleString("pt-BR")}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
          </TabsContent>

          <TabsContent value="auditoria" className="mt-4">
            <AuditPanel roles={roles} profiles={profiles} stores={stores} loading={loading} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function AuditPanel({ roles, profiles, stores, loading }: {
  roles: Array<{ id: string; user_id: string; store_id: string; role: string }>;
  profiles: Array<{ id: string; full_name: string | null; email: string | null; default_store_id: string | null }>;
  stores: Array<{ id: string; name: string; fantasy_name: string | null }>;
  loading: boolean;
}) {
  const storeIdSet = new Set(stores.map((s) => s.id));
  const profileMap = Object.fromEntries(profiles.map((p) => [p.id, p]));
  const orphanRoles = roles.filter((r) => !storeIdSet.has(r.store_id));
  const usersWithoutDefault = profiles.filter((p) => !p.default_store_id);
  const usersWithInvalidDefault = profiles.filter((p) => p.default_store_id && !storeIdSet.has(p.default_store_id));
  const rolesByStore = stores.map((s) => ({ store: s, count: roles.filter((r) => r.store_id === s.id).length }));
  const storesWithoutAdmin = stores.filter((s) => !roles.some((r) => r.store_id === s.id && r.role === "admin"));

  const Metric = ({ label, value, tone = "neutral", icon: Icon }: { label: string; value: number; tone?: "ok" | "warn" | "neutral"; icon: typeof CheckCircle2 }) => (
    <div className={`border rounded-md p-4 ${tone === "warn" ? "border-warning/40 bg-warning/5" : tone === "ok" ? "border-primary/40 bg-primary/5" : "border-border bg-card"}`}>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground"><Icon className="size-3" /> {label}</div>
      <div className={`text-2xl font-mono mt-1 ${tone === "warn" ? "text-warning" : tone === "ok" ? "text-primary" : ""}`}>{value}</div>
    </div>
  );

  if (loading) return <div className="text-sm text-muted-foreground">Auditando...</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Lojas" value={stores.length} icon={CheckCircle2} tone="ok" />
        <Metric label="Usuários" value={profiles.length} icon={CheckCircle2} tone="ok" />
        <Metric label="Vínculos" value={roles.length} icon={CheckCircle2} tone="ok" />
        <Metric label="Vínculos órfãos" value={orphanRoles.length} icon={ShieldAlert} tone={orphanRoles.length ? "warn" : "neutral"} />
        <Metric label="Sem loja padrão" value={usersWithoutDefault.length} icon={ShieldAlert} tone={usersWithoutDefault.length ? "warn" : "neutral"} />
        <Metric label="Padrão inválida" value={usersWithInvalidDefault.length} icon={ShieldAlert} tone={usersWithInvalidDefault.length ? "warn" : "neutral"} />
        <Metric label="Lojas sem admin" value={storesWithoutAdmin.length} icon={ShieldAlert} tone={storesWithoutAdmin.length ? "warn" : "neutral"} />
      </div>

      <div className="border border-border rounded-md bg-card overflow-hidden">
        <div className="px-4 py-2 text-xs font-semibold border-b border-border">Vínculos por loja</div>
        <Table>
          <TableHeader><TableRow><TableHead>Loja</TableHead><TableHead className="w-32 text-right">Vínculos</TableHead></TableRow></TableHeader>
          <TableBody>
            {rolesByStore.map(({ store, count }) => (
              <TableRow key={store.id}>
                <TableCell className="text-sm">{store.fantasy_name || store.name}</TableCell>
                <TableCell className="text-right font-mono">{count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {usersWithoutDefault.length > 0 && (
        <div className="border border-warning/40 rounded-md bg-warning/5 p-4">
          <div className="text-xs font-semibold text-warning mb-2">Usuários sem loja padrão ({usersWithoutDefault.length})</div>
          <ul className="text-xs space-y-1 font-mono">
            {usersWithoutDefault.slice(0, 20).map((p) => (<li key={p.id}>{p.email || p.id}</li>))}
          </ul>
        </div>
      )}

      {orphanRoles.length > 0 && (
        <div className="border border-destructive/40 rounded-md bg-destructive/5 p-4">
          <div className="text-xs font-semibold text-destructive mb-2">Vínculos órfãos (loja removida) — {orphanRoles.length}</div>
          <ul className="text-xs space-y-1 font-mono">
            {orphanRoles.slice(0, 20).map((r) => (
              <li key={r.id}>{profileMap[r.user_id]?.email || r.user_id} · store={r.store_id.slice(0, 8)} · {r.role}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function LinkUserDialog({
  stores,
  loading,
  onSubmit,
}: {
  stores: Array<{ id: string; name: string; fantasy_name: string | null }>;
  loading: boolean;
  onSubmit: (payload: z.infer<typeof linkSchema>) => void;
}) {
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AppRole>("caixa");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = linkSchema.safeParse({ storeId, email, role });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    onSubmit(parsed.data);
  };

  return (
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>Vincular usuário à loja</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="user-email">Email do usuário</Label>
          <Input
            id="user-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="usuario@empresa.com"
            autoComplete="email"
            required
          />
        </div>
        <div className="space-y-2">
          <Label>Loja</Label>
          <Select value={storeId} onValueChange={setStoreId}>
            <SelectTrigger><SelectValue placeholder="Selecione a loja" /></SelectTrigger>
            <SelectContent>
              {stores.map((store) => (
                <SelectItem key={store.id} value={store.id}>{store.fantasy_name || store.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Papel</Label>
          <Select value={role} onValueChange={(value) => setRole(value as AppRole)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="admin_dev">Admin Dev</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="gerente">Gerente</SelectItem>
              <SelectItem value="caixa">Caixa</SelectItem>
              <SelectItem value="estoquista">Estoquista</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button type="submit" disabled={loading || stores.length === 0}>
            {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
            Vincular
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, string> = {
    admin_dev: "border-destructive/40 text-destructive",
    admin: "border-primary/40 text-primary",
    gerente: "border-info/40 text-info",
    caixa: "border-warning/40 text-warning",
    estoquista: "border-muted-foreground/40 text-muted-foreground",
  };
  return <Badge variant="outline" className={map[role] || ""}>{role.replace("_", " ")}</Badge>;
}
