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
import { Badge } from "@/components/ui/badge";
import { Plus, ShoppingBag, Trash2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/compras")({
  component: ComprasPage,
});

type Purchase = {
  id: string;
  doc_number: string | null;
  doc_series: string | null;
  status: string;
  total: number;
  received_at: string | null;
  created_at: string;
  supplier_id: string | null;
  suppliers?: { name: string } | null;
};

function ComprasPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [openNew, setOpenNew] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data: purchases } = useQuery({
    queryKey: ["purchases", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchases")
        .select("*, suppliers(name)")
        .eq("store_id", storeId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Purchase[];
    },
  });

  const { data: suppliers } = useQuery({
    queryKey: ["suppliers-lite", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("id,name").eq("store_id", storeId!).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const [form, setForm] = useState({ supplier_id: "", doc_number: "", doc_series: "1", notes: "" });
  const createDraft = useMutation({
    mutationFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) throw new Error("Não autenticado");
      const clean = {
        store_id: storeId!,
        supplier_id: form.supplier_id || null,
        doc_number: form.doc_number || null,
        doc_series: form.doc_series || null,
        notes: form.notes || null,
        status: "rascunho",
        total: 0,
        created_by: userRes.user.id,
      };
      const { data, error } = await supabase.from("purchases").insert(clean).select("id").single();
      if (error) throw new Error(error.message);
      return data.id as string;
    },
    onSuccess: (id) => {
      toast.success("Rascunho de compra criado");
      qc.invalidateQueries({ queryKey: ["purchases"] });
      setOpenNew(false);
      setForm({ supplier_id: "", doc_number: "", doc_series: "1", notes: "" });
      setDetailId(id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!store) return <StoreRequired />;

  return (
    <div>
      <PageHeader
        title="Compras / Notas fiscais de entrada"
        description="Registre notas de entrada. Ao confirmar a compra, o estoque é atualizado automaticamente."
        actions={
          <Dialog open={openNew} onOpenChange={setOpenNew}>
            <DialogTrigger asChild><Button size="sm" className="gap-2"><Plus className="size-4" /> Nova compra</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Nova compra</DialogTitle></DialogHeader>
              <form onSubmit={(e) => { e.preventDefault(); createDraft.mutate(); }} className="grid grid-cols-2 gap-3">
                <FF label="Fornecedor" cn="col-span-2">
                  <Select value={form.supplier_id} onValueChange={(v) => setForm({ ...form, supplier_id: v })}>
                    <SelectTrigger><SelectValue placeholder="Selecione (opcional)" /></SelectTrigger>
                    <SelectContent>
                      {suppliers?.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FF>
                <FF label="Nº da NF"><Input className="font-mono" value={form.doc_number} onChange={(e) => setForm({ ...form, doc_number: e.target.value })} /></FF>
                <FF label="Série"><Input className="font-mono" value={form.doc_series} onChange={(e) => setForm({ ...form, doc_series: e.target.value })} /></FF>
                <FF label="Observações" cn="col-span-2"><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></FF>
                <DialogFooter className="col-span-2"><Button type="submit" disabled={createDraft.isPending}>{createDraft.isPending ? "Criando…" : "Criar rascunho"}</Button></DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        }
      />
      <div className="p-6">
        <div className="border border-border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="w-28">NF</TableHead>
              <TableHead>Fornecedor</TableHead>
              <TableHead className="w-32">Status</TableHead>
              <TableHead className="w-40">Data</TableHead>
              <TableHead className="w-32 text-right">Total</TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {purchases?.length === 0 && (
                <TableRow><TableCell colSpan={6} className="p-0">
                  <EmptyState title="Nenhuma compra registrada" description="Crie uma compra e adicione os itens da nota fiscal de entrada." />
                </TableCell></TableRow>
              )}
              {purchases?.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs"><ShoppingBag className="size-3 inline mr-1" />{p.doc_number || "—"}</TableCell>
                  <TableCell>{p.suppliers?.name || <span className="text-muted-foreground">sem fornecedor</span>}</TableCell>
                  <TableCell><StatusBadge status={p.status} /></TableCell>
                  <TableCell className="font-mono text-xs">{new Date(p.received_at ?? p.created_at).toLocaleString("pt-BR")}</TableCell>
                  <TableCell className="text-right font-mono">{Number(p.total).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</TableCell>
                  <TableCell><Button size="sm" variant="outline" onClick={() => setDetailId(p.id)}>Abrir</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {detailId && <PurchaseDrawer purchaseId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    rascunho: "border-muted-foreground/30 text-muted-foreground",
    confirmada: "border-primary/40 text-primary bg-primary/10",
    cancelada: "border-destructive/40 text-destructive bg-destructive/10",
  };
  return <Badge variant="outline" className={map[status] || ""}>{status}</Badge>;
}

function PurchaseDrawer({ purchaseId, onClose }: { purchaseId: string; onClose: () => void }) {
  const { storeId } = useCurrentStore();
  const qc = useQueryClient();

  const { data: purchase } = useQuery({
    queryKey: ["purchase", purchaseId],
    queryFn: async () => {
      const { data, error } = await supabase.from("purchases").select("*, suppliers(name)").eq("id", purchaseId).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const { data: items } = useQuery({
    queryKey: ["purchase-items", purchaseId],
    queryFn: async () => {
      const { data, error } = await supabase.from("purchase_items").select("*, products(name,unit)").eq("purchase_id", purchaseId);
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: products } = useQuery({
    queryKey: ["products-lite", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase.from("products").select("id,name,barcode,price_cost,unit").eq("store_id", storeId!).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const [item, setItem] = useState({ product_id: "", quantity: "1", unit_cost: "0" });

  const addItem = useMutation({
    mutationFn: async () => {
      if (!item.product_id) throw new Error("Escolha um produto");
      const qty = Number(item.quantity), cost = Number(item.unit_cost);
      if (!qty || qty <= 0) throw new Error("Quantidade inválida");
      const { error } = await supabase.from("purchase_items").insert({
        purchase_id: purchaseId, store_id: storeId!,
        product_id: item.product_id, quantity: qty, unit_cost: cost, total: qty * cost,
      });
      if (error) throw new Error(error.message);
      const newTotal = Number(purchase?.total ?? 0) + qty * cost;
      await supabase.from("purchases").update({ total: newTotal }).eq("id", purchaseId);
    },
    onSuccess: () => {
      toast.success("Item adicionado");
      qc.invalidateQueries({ queryKey: ["purchase-items", purchaseId] });
      qc.invalidateQueries({ queryKey: ["purchase", purchaseId] });
      qc.invalidateQueries({ queryKey: ["purchases"] });
      setItem({ product_id: "", quantity: "1", unit_cost: "0" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeItem = useMutation({
    mutationFn: async (id: string) => {
      const removed = items?.find((i) => i.id === id);
      const { error } = await supabase.from("purchase_items").delete().eq("id", id);
      if (error) throw new Error(error.message);
      if (removed) {
        const newTotal = Number(purchase?.total ?? 0) - Number(removed.total);
        await supabase.from("purchases").update({ total: Math.max(0, newTotal) }).eq("id", purchaseId);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-items", purchaseId] });
      qc.invalidateQueries({ queryKey: ["purchase", purchaseId] });
      qc.invalidateQueries({ queryKey: ["purchases"] });
    },
  });

  const confirm = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("purchases").update({ status: "confirmada" }).eq("id", purchaseId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Compra confirmada. Estoque atualizado.");
      qc.invalidateQueries();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const readonly = purchase?.status !== "rascunho";

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Compra {purchase?.doc_number ? `NF ${purchase.doc_number}` : ""}
            {purchase && <StatusBadge status={purchase.status} />}
          </DialogTitle>
          <div className="text-xs text-muted-foreground">
            Fornecedor: {purchase?.suppliers?.name || "—"}
          </div>
        </DialogHeader>

        {!readonly && (
          <div className="grid grid-cols-6 gap-2 border border-border rounded-md p-3 bg-muted/20">
            <div className="col-span-3">
              <Label className="text-xs">Produto</Label>
              <Select value={item.product_id} onValueChange={(v) => {
                const p = products?.find((x) => x.id === v);
                setItem({ product_id: v, quantity: item.quantity, unit_cost: String(p?.price_cost ?? 0) });
              }}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione…" /></SelectTrigger>
                <SelectContent>{products?.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs">Qtd.</Label><Input type="number" step="0.001" value={item.quantity} onChange={(e) => setItem({ ...item, quantity: e.target.value })} className="mt-1" /></div>
            <div><Label className="text-xs">Custo unit.</Label><Input type="number" step="0.01" value={item.unit_cost} onChange={(e) => setItem({ ...item, unit_cost: e.target.value })} className="mt-1" /></div>
            <div className="flex items-end"><Button size="sm" onClick={() => addItem.mutate()} disabled={addItem.isPending} className="w-full">Adicionar</Button></div>
          </div>
        )}

        <div className="border border-border rounded-md overflow-hidden">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Produto</TableHead>
              <TableHead className="w-24 text-right">Qtd.</TableHead>
              <TableHead className="w-28 text-right">Custo</TableHead>
              <TableHead className="w-28 text-right">Total</TableHead>
              {!readonly && <TableHead className="w-10"></TableHead>}
            </TableRow></TableHeader>
            <TableBody>
              {(items ?? []).length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-xs text-muted-foreground py-6">Sem itens ainda.</TableCell></TableRow>
              )}
              {items?.map((it) => (
                <TableRow key={it.id}>
                  <TableCell>{it.products?.name}</TableCell>
                  <TableCell className="text-right font-mono">{Number(it.quantity).toFixed(3)} {it.products?.unit}</TableCell>
                  <TableCell className="text-right font-mono">{Number(it.unit_cost).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</TableCell>
                  <TableCell className="text-right font-mono">{Number(it.total).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</TableCell>
                  {!readonly && (
                    <TableCell>
                      <Button size="icon" variant="ghost" onClick={() => removeItem.mutate(it.id)}><Trash2 className="size-4 text-destructive" /></Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="flex items-center justify-between w-full sm:justify-between">
          <div className="text-sm">
            Total: <span className="font-mono font-semibold">
              {Number(purchase?.total ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
            </span>
          </div>
          {!readonly && (
            <Button onClick={() => confirm.mutate()} disabled={confirm.isPending || (items?.length ?? 0) === 0} className="gap-2">
              <CheckCircle2 className="size-4" /> Confirmar entrada
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FF({ label, cn: c, children }: { label: string; cn?: string; children: React.ReactNode }) {
  return <div className={c}><Label className="text-xs">{label}</Label><div className="mt-1">{children}</div></div>;
}
