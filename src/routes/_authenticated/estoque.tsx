import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Plus, ArrowDownCircle, ArrowUpCircle, RefreshCcw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/estoque")({
  component: EstoquePage,
});

function EstoquePage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: stocks } = useQuery({
    queryKey: ["stocks", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_stocks").select("*, products(name,barcode,unit)")
        .eq("store_id", storeId!);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: movements } = useQuery({
    queryKey: ["movements", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_movements").select("*, products(name,barcode)")
        .eq("store_id", storeId!)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const move = useMutation({
    mutationFn: async (p: { product_id: string; type: "entrada" | "saida" | "ajuste"; quantity: number; reason: string }) => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error("Não autenticado");
      const { error } = await supabase.from("stock_movements").insert({
        store_id: storeId!, product_id: p.product_id, type: p.type,
        quantity: p.quantity, reason: p.reason, created_by: user.user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Movimentação registrada");
      qc.invalidateQueries({ queryKey: ["stocks"] });
      qc.invalidateQueries({ queryKey: ["movements"] });
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!store) return <StoreRequired />;

  return (
    <div>
      <PageHeader
        title="Estoque"
        description="Posições atuais e histórico de movimentações da loja."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button size="sm" className="gap-2"><Plus className="size-4" /> Nova movimentação</Button></DialogTrigger>
            <MovementDialog storeId={storeId!} onSubmit={(v) => move.mutate(v)} loading={move.isPending} />
          </Dialog>
        }
      />
      <div className="p-6 grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section>
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><RefreshCcw className="size-4" /> Posição de estoque</h2>
          <div className="border border-border rounded-md bg-card overflow-hidden">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Produto</TableHead>
                <TableHead className="w-24 text-right">Qtd</TableHead>
                <TableHead className="w-24 text-right">Mínimo</TableHead>
                <TableHead className="w-20">Status</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {stocks?.length === 0 && <TableRow><TableCell colSpan={4} className="text-center py-10 text-sm text-muted-foreground">Sem posições registradas.</TableCell></TableRow>}
                {stocks?.map((s) => {
                  const low = Number(s.min_quantity) > 0 && Number(s.quantity) <= Number(s.min_quantity);
                  return (
                    <TableRow key={s.id}>
                      <TableCell><div className="text-sm">{s.products?.name}</div><div className="font-mono text-[10px] text-muted-foreground">{s.products?.barcode || "—"}</div></TableCell>
                      <TableCell className="text-right font-mono">{Number(s.quantity).toFixed(3)}</TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">{Number(s.min_quantity).toFixed(3)}</TableCell>
                      <TableCell>{low ? <Badge variant="outline" className="border-warning/40 text-warning">baixo</Badge> : <Badge variant="outline" className="border-primary/40 text-primary">ok</Badge>}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold mb-3">Últimas movimentações</h2>
          <div className="border border-border rounded-md bg-card overflow-hidden">
            <Table>
              <TableHeader><TableRow>
                <TableHead className="w-32">Quando</TableHead>
                <TableHead>Produto</TableHead>
                <TableHead className="w-24">Tipo</TableHead>
                <TableHead className="w-20 text-right">Qtd</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {movements?.length === 0 && <TableRow><TableCell colSpan={4} className="text-center py-10 text-sm text-muted-foreground">Sem movimentações.</TableCell></TableRow>}
                {movements?.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{new Date(m.created_at).toLocaleString("pt-BR")}</TableCell>
                    <TableCell className="text-sm">{m.products?.name}</TableCell>
                    <TableCell><MovBadge type={m.type} /></TableCell>
                    <TableCell className="text-right font-mono">{Number(m.quantity).toFixed(3)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>
    </div>
  );
}

function MovBadge({ type }: { type: string }) {
  if (type === "entrada" || type === "devolucao") return <Badge variant="outline" className="border-primary/40 text-primary"><ArrowDownCircle className="size-3 mr-1" />{type}</Badge>;
  if (type === "saida" || type === "venda") return <Badge variant="outline" className="border-warning/40 text-warning"><ArrowUpCircle className="size-3 mr-1" />{type}</Badge>;
  return <Badge variant="outline">{type}</Badge>;
}

function MovementDialog({ storeId, onSubmit, loading }: { storeId: string; onSubmit: (v: { product_id: string; type: "entrada" | "saida" | "ajuste"; quantity: number; reason: string }) => void; loading: boolean }) {
  const [productId, setProductId] = useState("");
  const [type, setType] = useState<"entrada" | "saida" | "ajuste">("entrada");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const { data: products } = useQuery({
    queryKey: ["prod-select", storeId],
    queryFn: async () => {
      const { data } = await supabase.from("products").select("id,name,barcode").eq("store_id", storeId).eq("active", true).order("name");
      return data ?? [];
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = Number(qty);
    if (!productId) return toast.error("Selecione o produto");
    if (!q || (type !== "ajuste" && q <= 0)) return toast.error("Quantidade inválida");
    onSubmit({ product_id: productId, type, quantity: q, reason });
  };

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Movimentação de estoque</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <div><Label className="text-xs">Produto</Label>
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
            <SelectContent>{products?.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} {p.barcode ? `· ${p.barcode}` : ""}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div><Label className="text-xs">Tipo</Label>
          <Select value={type} onValueChange={(v) => setType(v as "entrada" | "saida" | "ajuste")}>
            <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="entrada">Entrada (compra / reposição)</SelectItem>
              <SelectItem value="saida">Saída (perda / uso interno)</SelectItem>
              <SelectItem value="ajuste">Ajuste (positivo ou negativo)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div><Label className="text-xs">Quantidade {type === "ajuste" && "(use valor negativo para reduzir)"}</Label>
          <Input type="number" step="0.001" value={qty} onChange={(e) => setQty(e.target.value)} className="mt-1 font-mono" /></div>
        <div><Label className="text-xs">Motivo / observação</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1" placeholder="Ex.: NF 12345 fornecedor XPTO" /></div>
        <DialogFooter><Button type="submit" disabled={loading}>{loading ? "Salvando..." : "Registrar"}</Button></DialogFooter>
      </form>
    </DialogContent>
  );
}
