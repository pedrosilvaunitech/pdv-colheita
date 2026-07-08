import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired, EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Truck, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/fornecedores")({
  component: FornecedoresPage,
});

type SupplierForm = {
  name: string; cnpj: string; phone: string; email: string;
  city: string; state: string; address_line: string; notes: string;
};

const EMPTY: SupplierForm = { name: "", cnpj: "", phone: "", email: "", city: "", state: "", address_line: "", notes: "" };

interface SupplierRow extends SupplierForm { id: string }

function FornecedoresPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [openNew, setOpenNew] = useState(false);
  const [editing, setEditing] = useState<SupplierRow | null>(null);
  const [form, setForm] = useState<SupplierForm>(EMPTY);

  const { data } = useQuery({
    queryKey: ["suppliers", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("*").eq("store_id", storeId!).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const toPayload = (f: SupplierForm) => ({
    name: f.name.trim(),
    cnpj: f.cnpj || null, phone: f.phone || null, email: f.email || null,
    city: f.city || null, state: f.state ? f.state.toUpperCase() : null,
    address_line: f.address_line || null, notes: f.notes || null,
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("Nome do fornecedor obrigatório");
      const { error } = await supabase.from("suppliers").insert({ store_id: storeId!, ...toPayload(form) });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Fornecedor cadastrado");
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      setOpenNew(false); setForm(EMPTY);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async () => {
      if (!editing) throw new Error("Nada para editar");
      if (!form.name.trim()) throw new Error("Nome do fornecedor obrigatório");
      const { error } = await supabase.from("suppliers").update(toPayload(form)).eq("id", editing.id).eq("store_id", storeId!);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Fornecedor atualizado");
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      setEditing(null); setForm(EMPTY);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("suppliers").delete().eq("id", id).eq("store_id", storeId!);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Fornecedor removido");
      qc.invalidateQueries({ queryKey: ["suppliers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const startEdit = (s: SupplierRow & Record<string, unknown>) => {
    setEditing(s);
    setForm({
      name: s.name ?? "",
      cnpj: (s.cnpj as string | null) ?? "",
      phone: (s.phone as string | null) ?? "",
      email: (s.email as string | null) ?? "",
      city: (s.city as string | null) ?? "",
      state: (s.state as string | null) ?? "",
      address_line: (s.address_line as string | null) ?? "",
      notes: (s.notes as string | null) ?? "",
    });
  };

  if (!store) return <StoreRequired />;

  const editorOpen = openNew || !!editing;
  const closeEditor = () => { setOpenNew(false); setEditing(null); setForm(EMPTY); };

  return (
    <div>
      <PageHeader
        title="Fornecedores"
        description="Cadastro de fornecedores para compras (notas de entrada) e vínculo com produtos."
        actions={
          <Button size="sm" className="gap-2" onClick={() => { setForm(EMPTY); setOpenNew(true); }}>
            <Plus className="size-4" /> Novo fornecedor
          </Button>
        }
      />

      <Dialog open={editorOpen} onOpenChange={(o) => !o && closeEditor()}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{editing ? "Editar fornecedor" : "Novo fornecedor"}</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); editing ? update.mutate() : create.mutate(); }} className="grid grid-cols-2 gap-3">
            <FF label="Razão social / nome" cn="col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></FF>
            <FF label="CNPJ"><Input className="font-mono" value={form.cnpj} onChange={(e) => setForm({ ...form, cnpj: e.target.value })} /></FF>
            <FF label="Telefone"><Input className="font-mono" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></FF>
            <FF label="E-mail" cn="col-span-2"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></FF>
            <FF label="Endereço" cn="col-span-2"><Input value={form.address_line} onChange={(e) => setForm({ ...form, address_line: e.target.value })} /></FF>
            <FF label="Cidade"><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></FF>
            <FF label="UF"><Input maxLength={2} className="uppercase" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} /></FF>
            <FF label="Observações" cn="col-span-2"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} /></FF>
            <DialogFooter className="col-span-2 gap-2">
              <Button type="button" variant="outline" onClick={closeEditor}>Cancelar</Button>
              <Button type="submit" disabled={create.isPending || update.isPending}>
                {editing ? (update.isPending ? "Salvando…" : "Salvar alterações") : (create.isPending ? "Salvando…" : "Cadastrar")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="p-6">
        <div className="border border-border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fornecedor</TableHead>
                <TableHead className="w-40 font-mono text-xs">CNPJ</TableHead>
                <TableHead className="w-40">Contato</TableHead>
                <TableHead className="w-40">Cidade / UF</TableHead>
                <TableHead className="w-28 text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.length === 0 && (
                <TableRow><TableCell colSpan={5} className="p-0">
                  <EmptyState title="Nenhum fornecedor" description="Cadastre fornecedores para registrar notas fiscais de entrada." />
                </TableCell></TableRow>
              )}
              {data?.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium flex items-center gap-2"><Truck className="size-4 text-muted-foreground" />{s.name}</TableCell>
                  <TableCell className="font-mono text-xs">{s.cnpj || "—"}</TableCell>
                  <TableCell className="text-xs">{[s.phone, s.email].filter(Boolean).join(" · ") || "—"}</TableCell>
                  <TableCell className="text-xs">{[s.city, s.state].filter(Boolean).join(" / ") || "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => startEdit(s as SupplierRow)} title="Editar">
                        <Pencil className="size-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => {
                        if (confirm(`Remover o fornecedor "${s.name}"?`)) remove.mutate(s.id);
                      }} title="Remover">
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function FF({ label, cn: c, children }: { label: string; cn?: string; children: React.ReactNode }) {
  return <div className={c}><Label className="text-xs">{label}</Label><div className="mt-1">{children}</div></div>;
}
