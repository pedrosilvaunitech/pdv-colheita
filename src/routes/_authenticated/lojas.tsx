import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Plus, Store as StoreIcon, Star, StarOff, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { useMyProfile, useSetDefaultStore, useCurrentStore, useStores } from "@/lib/current-store";

export const Route = createFileRoute("/_authenticated/lojas")({
  component: LojasPage,
});

const storeSchema = z.object({
  name: z.string().trim().min(1, "Razão social obrigatória").max(200),
  fantasy_name: z.string().trim().max(200).optional().or(z.literal("")),
  cnpj: z.string().trim().max(20).optional().or(z.literal("")),
  ie: z.string().trim().max(20).optional().or(z.literal("")),
  address_line: z.string().trim().max(255).optional().or(z.literal("")),
  city: z.string().trim().max(120).optional().or(z.literal("")),
  state: z.string().trim().length(2, "UF com 2 letras").optional().or(z.literal("")),
  zip: z.string().trim().max(10).optional().or(z.literal("")),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  tax_regime: z.enum(["simples_nacional", "simples_nacional_excesso", "regime_normal", "mei"]),
});
type StoreForm = z.infer<typeof storeSchema>;

type Store = {
  id: string; name: string; fantasy_name: string | null; cnpj: string | null; ie: string | null;
  address_line: string | null; city: string | null; state: string | null; zip: string | null;
  phone: string | null; tax_regime: string;
};

function LojasPage() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Store | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Store | null>(null);

  const { data: stores = [], isLoading: storesLoading } = useStores();
  const { data: profile } = useMyProfile();
  const setDefault = useSetDefaultStore();
  const { setStoreId } = useCurrentStore();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["stores"] });
    qc.invalidateQueries({ queryKey: ["my-profile"] });
    qc.invalidateQueries({ queryKey: ["roles-all"] });
  };

  const clean = (p: StoreForm) => ({
    name: p.name,
    fantasy_name: p.fantasy_name || null,
    cnpj: p.cnpj || null,
    ie: p.ie || null,
    address_line: p.address_line || null,
    city: p.city || null,
    state: p.state ? p.state.toUpperCase() : null,
    zip: p.zip || null,
    phone: p.phone || null,
    tax_regime: p.tax_regime,
  });

  const create = useMutation({
    mutationFn: async (payload: StoreForm) => {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw new Error(`Sessão inválida: ${userErr.message}`);
      if (!userRes.user) throw new Error("Faça login novamente.");
      const { error } = await supabase.from("stores").insert({ ...clean(payload), created_by: userRes.user.id });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { toast.success("Loja cadastrada. Você é admin dela."); invalidate(); setCreateOpen(false); },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: StoreForm }) => {
      const { error } = await supabase.from("stores").update(clean(patch)).eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { toast.success("Loja atualizada"); invalidate(); setEditing(null); },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("stores").delete().eq("id", id);
      if (error) throw new Error(`${error.message}${error.details ? ` — ${error.details}` : ""}`);
    },
    onSuccess: () => { toast.success("Loja excluída"); setConfirmDelete(null); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Lojas"
        description="Multi-loja: cada loja tem estoque, usuários e configuração fiscal próprios."
        actions={
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild><Button size="sm" className="gap-2"><Plus className="size-4" /> Nova loja</Button></DialogTrigger>
            <StoreDialog title="Nova loja" onSubmit={(v) => create.mutate(v)} loading={create.isPending} />
          </Dialog>
        }
      />
      <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        {storesLoading && (
          <div className="col-span-full border border-border rounded-md p-10 text-center bg-card/40 text-sm text-muted-foreground">
            Carregando lojas disponíveis...
          </div>
        )}
        {!storesLoading && stores.length === 0 && (
          <div className="col-span-full border border-dashed border-border rounded-md p-10 text-center bg-card/40">
            <StoreIcon className="size-8 mx-auto text-muted-foreground" />
            <h3 className="mt-3 text-sm font-medium">Nenhuma loja ainda</h3>
            <p className="text-xs text-muted-foreground mt-1">Cadastre sua primeira loja para começar a usar o sistema.</p>
          </div>
        )}
        {stores.map((s) => {
          const isDefault = profile?.default_store_id === s.id;
          return (
            <div key={s.id} className={`border rounded-md bg-card p-5 ${isDefault ? "border-primary/60" : "border-border"}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-sm font-semibold flex items-center gap-2">
                    {s.fantasy_name || s.name}
                    {isDefault && <span className="text-[10px] font-mono uppercase text-primary border border-primary/40 rounded-sm px-1.5 py-0.5">Padrão</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">{s.name}</div>
                </div>
                <span className="text-[10px] font-mono uppercase text-muted-foreground border border-border rounded-sm px-2 py-1">
                  {s.tax_regime.replace(/_/g, " ")}
                </span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <Info label="CNPJ" value={s.cnpj} mono />
                <Info label="IE" value={s.ie} mono />
                <Info label="Cidade / UF" value={[s.city, s.state].filter(Boolean).join(" / ")} />
                <Info label="Telefone" value={s.phone} mono />
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setStoreId(s.id)}>Selecionar</Button>
                <Button
                  size="sm"
                  variant={isDefault ? "secondary" : "default"}
                  disabled={isDefault || setDefault.isPending}
                  onClick={() => setDefault.mutate(s.id)}
                  className="gap-1.5"
                >
                  {isDefault ? <><StarOff className="size-3.5" /> Já é padrão</> : <><Star className="size-3.5" /> Definir como padrão</>}
                </Button>
                <div className="flex-1" />
                <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setEditing(s)}>
                  <Pencil className="size-3.5" /> Editar
                </Button>
                <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setConfirmDelete(s)}>
                  <Trash2 className="size-3.5" /> Excluir
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        {editing && (
          <StoreDialog
            title={`Editar — ${editing.fantasy_name || editing.name}`}
            initial={{
              name: editing.name, fantasy_name: editing.fantasy_name ?? "",
              cnpj: editing.cnpj ?? "", ie: editing.ie ?? "",
              address_line: editing.address_line ?? "", city: editing.city ?? "",
              state: editing.state ?? "", zip: editing.zip ?? "", phone: editing.phone ?? "",
              tax_regime: (editing.tax_regime as StoreForm["tax_regime"]) ?? "simples_nacional",
            }}
            onSubmit={(v) => update.mutate({ id: editing.id, patch: v })}
            loading={update.isPending}
            submitLabel="Salvar alterações"
          />
        )}
      </Dialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir loja definitivamente?</AlertDialogTitle>
            <AlertDialogDescription>
              A loja <b>{confirmDelete?.fantasy_name || confirmDelete?.name}</b> será removida, junto com produtos, estoques, vendas, vínculos de usuários e configuração fiscal desta loja. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-mono uppercase text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono" : ""}>{value || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

function StoreDialog({
  title, initial, onSubmit, loading, submitLabel = "Criar loja",
}: {
  title: string;
  initial?: Partial<StoreForm>;
  onSubmit: (v: StoreForm) => void;
  loading: boolean;
  submitLabel?: string;
}) {
  const [form, setForm] = useState<StoreForm>({
    name: initial?.name ?? "",
    fantasy_name: initial?.fantasy_name ?? "",
    cnpj: initial?.cnpj ?? "",
    ie: initial?.ie ?? "",
    address_line: initial?.address_line ?? "",
    city: initial?.city ?? "",
    state: initial?.state ?? "",
    zip: initial?.zip ?? "",
    phone: initial?.phone ?? "",
    tax_regime: initial?.tax_regime ?? "simples_nacional",
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = storeSchema.safeParse(form);
    if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
    onSubmit(parsed.data);
  };
  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="grid grid-cols-2 gap-4">
        <F label="Razão social" cn="col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></F>
        <F label="Nome fantasia" cn="col-span-2"><Input value={form.fantasy_name} onChange={(e) => setForm({ ...form, fantasy_name: e.target.value })} /></F>
        <F label="CNPJ"><Input className="font-mono" value={form.cnpj} onChange={(e) => setForm({ ...form, cnpj: e.target.value })} /></F>
        <F label="Inscrição estadual"><Input className="font-mono" value={form.ie} onChange={(e) => setForm({ ...form, ie: e.target.value })} /></F>
        <F label="Regime tributário" cn="col-span-2">
          <Select value={form.tax_regime} onValueChange={(v) => setForm({ ...form, tax_regime: v as StoreForm["tax_regime"] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="mei">MEI</SelectItem>
              <SelectItem value="simples_nacional">Simples Nacional</SelectItem>
              <SelectItem value="simples_nacional_excesso">Simples Nacional — excesso sublimite</SelectItem>
              <SelectItem value="regime_normal">Regime normal (Lucro Presumido / Real)</SelectItem>
            </SelectContent>
          </Select>
        </F>
        <F label="Endereço" cn="col-span-2"><Input value={form.address_line} onChange={(e) => setForm({ ...form, address_line: e.target.value })} /></F>
        <F label="Cidade"><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></F>
        <F label="UF"><Input maxLength={2} className="uppercase" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} /></F>
        <F label="CEP"><Input className="font-mono" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} /></F>
        <F label="Telefone"><Input className="font-mono" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></F>
        <DialogFooter className="col-span-2"><Button type="submit" disabled={loading}>{loading ? "Salvando..." : submitLabel}</Button></DialogFooter>
      </form>
    </DialogContent>
  );
}

function F({ label, cn: c, children }: { label: string; cn?: string; children: React.ReactNode }) {
  return <div className={c}><Label className="text-xs">{label}</Label><div className="mt-1">{children}</div></div>;
}
