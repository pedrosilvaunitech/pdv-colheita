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
import { Plus, Search, Barcode } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

export const Route = createFileRoute("/_authenticated/produtos")({
  component: ProdutosPage,
});

const productSchema = z.object({
  name: z.string().trim().min(1, "Nome obrigatório").max(200),
  barcode: z.string().trim().max(64).optional().or(z.literal("")),
  sku: z.string().trim().max(64).optional().or(z.literal("")),
  unit: z.string().trim().min(1).max(8),
  category: z.string().trim().max(80).optional().or(z.literal("")),
  price_sell: z.coerce.number().min(0),
  price_cost: z.coerce.number().min(0),
  min_stock: z.coerce.number().min(0),
  max_stock: z.coerce.number().min(0).optional(),
  lead_time_days: z.coerce.number().int().min(0).max(365),
  supplier_id: z.string().uuid().optional().or(z.literal("")),
  ncm: z.string().trim().max(10).optional().or(z.literal("")),
  cfop: z.string().trim().max(6).optional().or(z.literal("")),
  csosn: z.string().trim().max(6).optional().or(z.literal("")),
});


function ProdutosPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const { data: products } = useQuery({
    queryKey: ["products", storeId, search],
    enabled: Boolean(storeId),
    queryFn: async () => {
      let q = supabase.from("products").select("*, product_stocks(quantity)").eq("store_id", storeId!).order("name");
      if (search.trim()) q = q.or(`name.ilike.%${search}%,barcode.ilike.%${search}%,sku.ilike.%${search}%`);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async (payload: z.infer<typeof productSchema>) => {
      const clean = {
        store_id: storeId!,
        name: payload.name,
        barcode: payload.barcode || null,
        sku: payload.sku || null,
        unit: payload.unit,
        price_sell: payload.price_sell,
        price_cost: payload.price_cost,
        ncm: payload.ncm || null,
        cfop: payload.cfop || null,
        csosn: payload.csosn || null,
      };
      const { error } = await supabase.from("products").insert(clean);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Produto cadastrado");
      qc.invalidateQueries({ queryKey: ["products"] });
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!store) return <StoreRequired />;

  return (
    <div>
      <PageHeader
        title="Produtos"
        description="Cadastro de itens com código de barras (EAN/UPC), tributação e estoque."
        actions={
          <>
            <div className="relative">
              <Search className="size-4 absolute left-2 top-2.5 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome, EAN ou SKU" className="pl-8 w-72" />
            </div>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-2"><Plus className="size-4" /> Novo produto</Button>
              </DialogTrigger>
              <ProductDialog onSubmit={(v) => create.mutate(v)} loading={create.isPending} />
            </Dialog>
          </>
        }
      />
      <div className="p-6">
        <div className="border border-border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Código barras</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead className="w-20">Unid.</TableHead>
                <TableHead className="w-24 text-right">Preço</TableHead>
                <TableHead className="w-24 text-right">Custo</TableHead>
                <TableHead className="w-24 text-right">Estoque</TableHead>
                <TableHead className="w-24">NCM</TableHead>
                <TableHead className="w-24">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products?.length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center py-12 text-sm text-muted-foreground">Nenhum produto cadastrado.</TableCell></TableRow>
              )}
              {products?.map((p) => {
                const stock = Array.isArray(p.product_stocks) && p.product_stocks[0] ? Number(p.product_stocks[0].quantity) : 0;
                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">
                      {p.barcode ? (<span className="inline-flex items-center gap-1"><Barcode className="size-3" />{p.barcode}</span>) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="font-mono text-xs uppercase">{p.unit}</TableCell>
                    <TableCell className="text-right font-mono">{brl(Number(p.price_sell))}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">{brl(Number(p.price_cost))}</TableCell>
                    <TableCell className="text-right font-mono">{stock.toFixed(3)}</TableCell>
                    <TableCell className="font-mono text-xs">{p.ncm || "—"}</TableCell>
                    <TableCell>{p.active ? <Badge variant="outline" className="border-primary/40 text-primary">ativo</Badge> : <Badge variant="secondary">inativo</Badge>}</TableCell>
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

function ProductDialog({ onSubmit, loading }: { onSubmit: (v: z.infer<typeof productSchema>) => void; loading: boolean }) {
  const [form, setForm] = useState({
    name: "", barcode: "", sku: "", unit: "UN",
    price_sell: "0", price_cost: "0", ncm: "", cfop: "5102", csosn: "102",
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = productSchema.safeParse(form);
    if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
    onSubmit(parsed.data);
  };

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader><DialogTitle>Novo produto</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="grid grid-cols-2 gap-4">
        <Field label="Código de barras (EAN)" className="col-span-2">
          <Input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value.replace(/\D/g, "") })} placeholder="7891234567890" className="font-mono" autoFocus />
        </Field>
        <Field label="Nome" className="col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
        <Field label="SKU interno"><Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} /></Field>
        <Field label="Unidade">
          <Select value={form.unit} onValueChange={(v) => setForm({ ...form, unit: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["UN","KG","G","L","ML","CX","PC","M"].map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Preço de venda (R$)"><Input type="number" step="0.01" min="0" value={form.price_sell} onChange={(e) => setForm({ ...form, price_sell: e.target.value })} /></Field>
        <Field label="Preço de custo (R$)"><Input type="number" step="0.01" min="0" value={form.price_cost} onChange={(e) => setForm({ ...form, price_cost: e.target.value })} /></Field>
        <Field label="NCM"><Input value={form.ncm} onChange={(e) => setForm({ ...form, ncm: e.target.value })} placeholder="ex 22021000" className="font-mono" /></Field>
        <Field label="CFOP"><Input value={form.cfop} onChange={(e) => setForm({ ...form, cfop: e.target.value })} className="font-mono" /></Field>
        <Field label="CSOSN (Simples)"><Input value={form.csosn} onChange={(e) => setForm({ ...form, csosn: e.target.value })} className="font-mono" /></Field>
        <DialogFooter className="col-span-2">
          <Button type="submit" disabled={loading}>{loading ? "Salvando..." : "Cadastrar"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <Label className="text-xs">{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function brl(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
