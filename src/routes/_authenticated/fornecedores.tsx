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
import { Plus, Truck } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/fornecedores")({
  component: FornecedoresPage,
});

function FornecedoresPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", cnpj: "", phone: "", email: "", city: "", state: "", address_line: "", notes: "" });

  const { data } = useQuery({
    queryKey: ["suppliers", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("*").eq("store_id", storeId!).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("Nome do fornecedor obrigatório");
      const clean = {
        store_id: storeId!, name: form.name.trim(),
        cnpj: form.cnpj || null, phone: form.phone || null, email: form.email || null,
        city: form.city || null, state: form.state ? form.state.toUpperCase() : null,
        address_line: form.address_line || null, notes: form.notes || null,
      };
      const { error } = await supabase.from("suppliers").insert(clean);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Fornecedor cadastrado");
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      setOpen(false);
      setForm({ name: "", cnpj: "", phone: "", email: "", city: "", state: "", address_line: "", notes: "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!store) return <StoreRequired />;

  return (
    <div>
      <PageHeader
        title="Fornecedores"
        description="Cadastro de fornecedores para compras (notas de entrada) e vínculo com produtos."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button size="sm" className="gap-2"><Plus className="size-4" /> Novo fornecedor</Button></DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader><DialogTitle>Novo fornecedor</DialogTitle></DialogHeader>
              <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="grid grid-cols-2 gap-3">
                <FF label="Razão social / nome" cn="col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></FF>
                <FF label="CNPJ"><Input className="font-mono" value={form.cnpj} onChange={(e) => setForm({ ...form, cnpj: e.target.value })} /></FF>
                <FF label="Telefone"><Input className="font-mono" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></FF>
                <FF label="E-mail" cn="col-span-2"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></FF>
                <FF label="Endereço" cn="col-span-2"><Input value={form.address_line} onChange={(e) => setForm({ ...form, address_line: e.target.value })} /></FF>
                <FF label="Cidade"><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></FF>
                <FF label="UF"><Input maxLength={2} className="uppercase" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} /></FF>
                <FF label="Observações" cn="col-span-2"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} /></FF>
                <DialogFooter className="col-span-2"><Button type="submit" disabled={create.isPending}>{create.isPending ? "Salvando…" : "Cadastrar"}</Button></DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        }
      />
      <div className="p-6">
        <div className="border border-border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fornecedor</TableHead>
                <TableHead className="w-40 font-mono text-xs">CNPJ</TableHead>
                <TableHead className="w-40">Contato</TableHead>
                <TableHead className="w-40">Cidade / UF</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.length === 0 && (
                <TableRow><TableCell colSpan={4} className="p-0">
                  <EmptyState title="Nenhum fornecedor" description="Cadastre fornecedores para registrar notas fiscais de entrada." />
                </TableCell></TableRow>
              )}
              {data?.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium flex items-center gap-2"><Truck className="size-4 text-muted-foreground" />{s.name}</TableCell>
                  <TableCell className="font-mono text-xs">{s.cnpj || "—"}</TableCell>
                  <TableCell className="text-xs">{[s.phone, s.email].filter(Boolean).join(" · ") || "—"}</TableCell>
                  <TableCell className="text-xs">{[s.city, s.state].filter(Boolean).join(" / ") || "—"}</TableCell>
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
