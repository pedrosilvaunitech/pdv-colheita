import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Plus, Store as StoreIcon, Star, StarOff } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { useMyProfile, useSetDefaultStore, useCurrentStore } from "@/lib/current-store";

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

function LojasPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: stores } = useQuery({
    queryKey: ["stores"],
    queryFn: async () => {
      const { data, error } = await supabase.from("stores").select("*").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async (payload: z.infer<typeof storeSchema>) => {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw new Error(`Sessão inválida: ${userErr.message}`);
      if (!userRes.user) throw new Error("Você não está autenticado. Faça login novamente.");
      const clean = {
        name: payload.name,
        fantasy_name: payload.fantasy_name || null,
        cnpj: payload.cnpj || null,
        ie: payload.ie || null,
        address_line: payload.address_line || null,
        city: payload.city || null,
        state: payload.state ? payload.state.toUpperCase() : null,
        zip: payload.zip || null,
        phone: payload.phone || null,
        tax_regime: payload.tax_regime,
        created_by: userRes.user.id,
      };
      const { error } = await supabase.from("stores").insert(clean);
      if (error) throw new Error(`${error.message}${error.details ? ` — ${error.details}` : ""}${error.hint ? ` (${error.hint})` : ""}`);
    },
    onSuccess: () => { toast.success("Loja cadastrada. Você é admin dela."); qc.invalidateQueries({ queryKey: ["stores"] }); setOpen(false); },
    onError: (e: Error) => toast.error(e.message),
  });


  return (
    <div>
      <PageHeader
        title="Lojas"
        description="Multi-loja: cada loja tem estoque, usuários e configuração fiscal próprios."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button size="sm" className="gap-2"><Plus className="size-4" /> Nova loja</Button></DialogTrigger>
            <StoreDialog onSubmit={(v) => create.mutate(v)} loading={create.isPending} />
          </Dialog>
        }
      />
      <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        {stores?.length === 0 && (
          <div className="col-span-full border border-dashed border-border rounded-md p-10 text-center bg-card/40">
            <StoreIcon className="size-8 mx-auto text-muted-foreground" />
            <h3 className="mt-3 text-sm font-medium">Nenhuma loja ainda</h3>
            <p className="text-xs text-muted-foreground mt-1">Cadastre sua primeira loja para começar a usar o sistema.</p>
          </div>
        )}
        {stores?.map((s) => (
          <div key={s.id} className="border border-border rounded-md bg-card p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-semibold">{s.fantasy_name || s.name}</div>
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
          </div>
        ))}
      </div>
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

function StoreDialog({ onSubmit, loading }: { onSubmit: (v: z.infer<typeof storeSchema>) => void; loading: boolean }) {
  const [form, setForm] = useState<z.infer<typeof storeSchema>>({
    name: "", fantasy_name: "", cnpj: "", ie: "",
    address_line: "", city: "", state: "", zip: "", phone: "",
    tax_regime: "simples_nacional",
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = storeSchema.safeParse(form);
    if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
    onSubmit(parsed.data);
  };
  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader><DialogTitle>Nova loja</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="grid grid-cols-2 gap-4">
        <F label="Razão social" cn="col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></F>
        <F label="Nome fantasia" cn="col-span-2"><Input value={form.fantasy_name} onChange={(e) => setForm({ ...form, fantasy_name: e.target.value })} /></F>
        <F label="CNPJ"><Input className="font-mono" value={form.cnpj} onChange={(e) => setForm({ ...form, cnpj: e.target.value })} /></F>
        <F label="Inscrição estadual"><Input className="font-mono" value={form.ie} onChange={(e) => setForm({ ...form, ie: e.target.value })} /></F>
        <F label="Regime tributário" cn="col-span-2">
          <Select value={form.tax_regime} onValueChange={(v) => setForm({ ...form, tax_regime: v as typeof form.tax_regime })}>
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
        <DialogFooter className="col-span-2"><Button type="submit" disabled={loading}>{loading ? "Salvando..." : "Criar loja"}</Button></DialogFooter>
      </form>
    </DialogContent>
  );
}

function F({ label, cn: c, children }: { label: string; cn?: string; children: React.ReactNode }) {
  return <div className={c}><Label className="text-xs">{label}</Label><div className="mt-1">{children}</div></div>;
}
