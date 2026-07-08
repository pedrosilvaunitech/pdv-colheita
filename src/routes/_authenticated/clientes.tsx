import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired, EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, UserSquare2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/clientes")({
  component: ClientesPage,
});

type DocType = "cpf" | "cnpj";
type CustomerForm = { name: string; doc: string; doc_type: DocType; phone: string; email: string; city: string; state: string };
const EMPTY: CustomerForm = { name: "", doc: "", doc_type: "cpf", phone: "", email: "", city: "", state: "" };

function ClientesPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [openNew, setOpenNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CustomerForm>(EMPTY);

  const { data } = useQuery({
    queryKey: ["customers", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase.from("customers").select("*").eq("store_id", storeId!).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const toPayload = (f: CustomerForm) => ({
    name: f.name.trim(),
    doc: f.doc || null,
    doc_type: f.doc ? f.doc_type : null,
    phone: f.phone || null,
    email: f.email || null,
    city: f.city || null,
    state: f.state ? f.state.toUpperCase() : null,
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("Nome obrigatório");
      const { error } = await supabase.from("customers").insert({ store_id: storeId!, ...toPayload(form) });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Cliente cadastrado");
      qc.invalidateQueries({ queryKey: ["customers"] });
      close();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async () => {
      if (!editingId) throw new Error("Nada para editar");
      if (!form.name.trim()) throw new Error("Nome obrigatório");
      const { error } = await supabase.from("customers").update(toPayload(form)).eq("id", editingId).eq("store_id", storeId!);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Cliente atualizado");
      qc.invalidateQueries({ queryKey: ["customers"] });
      close();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("customers").delete().eq("id", id).eq("store_id", storeId!);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Cliente removido");
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const startEdit = (c: Record<string, unknown>) => {
    setEditingId(String(c.id));
    setForm({
      name: (c.name as string | null) ?? "",
      doc: (c.doc as string | null) ?? "",
      doc_type: ((c.doc_type as string | null) ?? "cpf") as DocType,
      phone: (c.phone as string | null) ?? "",
      email: (c.email as string | null) ?? "",
      city: (c.city as string | null) ?? "",
      state: (c.state as string | null) ?? "",
    });
  };

  const close = () => { setOpenNew(false); setEditingId(null); setForm(EMPTY); };

  if (!store) return <StoreRequired />;

  const editorOpen = openNew || !!editingId;

  return (
    <div>
      <PageHeader
        title="Clientes"
        description="Base de clientes para emissão de NFC-e / NF-e com CPF ou CNPJ."
        actions={
          <Button size="sm" className="gap-2" onClick={() => { setForm(EMPTY); setOpenNew(true); }}>
            <Plus className="size-4" /> Novo cliente
          </Button>
        }
      />

      <Dialog open={editorOpen} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingId ? "Editar cliente" : "Novo cliente"}</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); editingId ? update.mutate() : create.mutate(); }} className="grid grid-cols-2 gap-3">
            <FF label="Nome / razão social" cn="col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></FF>
            <FF label="Tipo de documento">
              <Select value={form.doc_type} onValueChange={(v) => setForm({ ...form, doc_type: v as DocType })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="cpf">CPF</SelectItem><SelectItem value="cnpj">CNPJ</SelectItem></SelectContent>
              </Select>
            </FF>
            <FF label="Documento"><Input className="font-mono" value={form.doc} onChange={(e) => setForm({ ...form, doc: e.target.value })} /></FF>
            <FF label="Telefone"><Input className="font-mono" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></FF>
            <FF label="E-mail"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></FF>
            <FF label="Cidade"><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></FF>
            <FF label="UF"><Input maxLength={2} className="uppercase" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} /></FF>
            <DialogFooter className="col-span-2 gap-2">
              <Button type="button" variant="outline" onClick={close}>Cancelar</Button>
              <Button type="submit" disabled={create.isPending || update.isPending}>
                {editingId ? (update.isPending ? "Salvando…" : "Salvar alterações") : (create.isPending ? "Salvando…" : "Cadastrar")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="p-6">
        <div className="border border-border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Cliente</TableHead>
              <TableHead className="w-40 font-mono text-xs">Documento</TableHead>
              <TableHead className="w-48">Contato</TableHead>
              <TableHead className="w-40">Cidade / UF</TableHead>
              <TableHead className="w-28 text-right">Ações</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {data?.length === 0 && (
                <TableRow><TableCell colSpan={5} className="p-0">
                  <EmptyState title="Nenhum cliente" description="Cadastre clientes para emitir NFC-e / NF-e nominal." />
                </TableCell></TableRow>
              )}
              {data?.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium flex items-center gap-2"><UserSquare2 className="size-4 text-muted-foreground" />{c.name}</TableCell>
                  <TableCell className="font-mono text-xs">{c.doc ? `${c.doc_type?.toUpperCase()} ${c.doc}` : "—"}</TableCell>
                  <TableCell className="text-xs">{[c.phone, c.email].filter(Boolean).join(" · ") || "—"}</TableCell>
                  <TableCell className="text-xs">{[c.city, c.state].filter(Boolean).join(" / ") || "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => startEdit(c as unknown as Record<string, unknown>)} title="Editar">
                        <Pencil className="size-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => {
                        if (confirm(`Remover o cliente "${c.name}"?`)) remove.mutate(c.id);
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
