import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired, EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, UserSquare2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/clientes")({
  component: ClientesPage,
});

function ClientesPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", doc: "", doc_type: "cpf" as "cpf" | "cnpj", phone: "", email: "", city: "", state: "" });

  const { data } = useQuery({
    queryKey: ["customers", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase.from("customers").select("*").eq("store_id", storeId!).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("Nome obrigatório");
      const clean = {
        store_id: storeId!, name: form.name.trim(),
        doc: form.doc || null, doc_type: form.doc ? form.doc_type : null,
        phone: form.phone || null, email: form.email || null,
        city: form.city || null, state: form.state ? form.state.toUpperCase() : null,
      };
      const { error } = await supabase.from("customers").insert(clean);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Cliente cadastrado");
      qc.invalidateQueries({ queryKey: ["customers"] });
      setOpen(false);
      setForm({ name: "", doc: "", doc_type: "cpf", phone: "", email: "", city: "", state: "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!store) return <StoreRequired />;

  return (
    <div>
      <PageHeader
        title="Clientes"
        description="Base de clientes para emissão de NFC-e / NF-e com CPF ou CNPJ."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button size="sm" className="gap-2"><Plus className="size-4" /> Novo cliente</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Novo cliente</DialogTitle></DialogHeader>
              <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="grid grid-cols-2 gap-3">
                <FF label="Nome / razão social" cn="col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></FF>
                <FF label="Tipo de documento">
                  <Select value={form.doc_type} onValueChange={(v) => setForm({ ...form, doc_type: v as "cpf" | "cnpj" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="cpf">CPF</SelectItem><SelectItem value="cnpj">CNPJ</SelectItem></SelectContent>
                  </Select>
                </FF>
                <FF label="Documento"><Input className="font-mono" value={form.doc} onChange={(e) => setForm({ ...form, doc: e.target.value })} /></FF>
                <FF label="Telefone"><Input className="font-mono" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></FF>
                <FF label="E-mail"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></FF>
                <FF label="Cidade"><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></FF>
                <FF label="UF"><Input maxLength={2} className="uppercase" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} /></FF>
                <DialogFooter className="col-span-2"><Button type="submit" disabled={create.isPending}>{create.isPending ? "Salvando…" : "Cadastrar"}</Button></DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        }
      />
      <div className="p-6">
        <div className="border border-border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Cliente</TableHead>
              <TableHead className="w-40 font-mono text-xs">Documento</TableHead>
              <TableHead className="w-48">Contato</TableHead>
              <TableHead className="w-40">Cidade / UF</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {data?.length === 0 && (
                <TableRow><TableCell colSpan={4} className="p-0">
                  <EmptyState title="Nenhum cliente" description="Cadastre clientes para emitir NFC-e / NF-e nominal." />
                </TableCell></TableRow>
              )}
              {data?.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium flex items-center gap-2"><UserSquare2 className="size-4 text-muted-foreground" />{c.name}</TableCell>
                  <TableCell className="font-mono text-xs">{c.doc ? `${c.doc_type?.toUpperCase()} ${c.doc}` : "—"}</TableCell>
                  <TableCell className="text-xs">{[c.phone, c.email].filter(Boolean).join(" · ") || "—"}</TableCell>
                  <TableCell className="text-xs">{[c.city, c.state].filter(Boolean).join(" / ") || "—"}</TableCell>
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
