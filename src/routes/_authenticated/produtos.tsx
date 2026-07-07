import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Barcode, Pencil, Trash2, Percent, Power, PowerOff, TagIcon } from "lucide-react";
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
type ProductForm = z.infer<typeof productSchema>;

type ProductRow = {
  id: string; store_id: string; name: string; barcode: string | null; sku: string | null;
  unit: string; category: string | null; price_sell: number; price_cost: number;
  min_stock: number; max_stock: number | null; lead_time_days: number; supplier_id: string | null;
  ncm: string | null; cfop: string | null; csosn: string | null; active: boolean;
  product_stocks?: Array<{ quantity: number }>;
};

function ProdutosPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[]; label: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPriceOpen, setBulkPriceOpen] = useState(false);

  const { data: products = [] } = useQuery({
    queryKey: ["products", storeId, search],
    enabled: Boolean(storeId),
    queryFn: async () => {
      let q = supabase.from("products").select("*, product_stocks(quantity)").eq("store_id", storeId!).order("name");
      if (search.trim()) q = q.or(`name.ilike.%${search}%,barcode.ilike.%${search}%,sku.ilike.%${search}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ProductRow[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["products"] });

  const create = useMutation({
    mutationFn: async (payload: ProductForm) => {
      const { error } = await supabase.from("products").insert(cleanProduct(payload, storeId!));
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { toast.success("Produto cadastrado"); invalidate(); setCreateOpen(false); },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: ProductForm }) => {
      const { error } = await supabase.from("products").update(cleanProduct(patch, storeId!)).eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { toast.success("Produto atualizado"); invalidate(); setEditing(null); },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMany = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase.from("products").delete().in("id", ids);
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, ids) => {
      toast.success(`${ids.length} produto(s) excluído(s)`);
      setSelected((s) => { const n = new Set(s); ids.forEach((i) => n.delete(i)); return n; });
      setConfirmDelete(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setActiveMany = useMutation({
    mutationFn: async ({ ids, active }: { ids: string[]; active: boolean }) => {
      const { error } = await supabase.from("products").update({ active }).in("id", ids);
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, v) => { toast.success(`${v.ids.length} produto(s) ${v.active ? "ativado(s)" : "desativado(s)"}`); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkPrice = useMutation({
    mutationFn: async ({ ids, field, mode, value }: { ids: string[]; field: "price_sell" | "price_cost"; mode: "set" | "percent" | "delta"; value: number }) => {
      const rows = products.filter((p) => ids.includes(p.id));
      const updates = rows.map((p) => {
        const cur = Number(p[field]);
        let next = cur;
        if (mode === "set") next = value;
        else if (mode === "percent") next = +(cur * (1 + value / 100)).toFixed(2);
        else if (mode === "delta") next = +(cur + value).toFixed(2);
        return { id: p.id, next: Math.max(0, next) };
      });
      // update em paralelo em pequenos lotes
      const CHUNK = 25;
      for (let i = 0; i < updates.length; i += CHUNK) {
        const slice = updates.slice(i, i + CHUNK);
        await Promise.all(slice.map((u) => supabase.from("products").update({ [field]: u.next }).eq("id", u.id)));
      }
    },
    onSuccess: (_d, v) => { toast.success(`Preços atualizados em ${v.ids.length} produto(s)`); setBulkPriceOpen(false); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const allChecked = products.length > 0 && products.every((p) => selected.has(p.id));
  const someChecked = selected.size > 0 && !allChecked;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(products.map((p) => p.id)));
  const toggleOne = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (!store) return <StoreRequired />;

  const selectedArr = Array.from(selected);

  return (
    <div>
      <PageHeader
        title="Produtos"
        description="Cadastro, edição, exclusão e ajuste de preços — individual ou em massa."
        actions={
          <>
            <div className="relative">
              <Search className="size-4 absolute left-2 top-2.5 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome, EAN ou SKU" className="pl-8 w-72" />
            </div>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-2"><Plus className="size-4" /> Novo produto</Button>
              </DialogTrigger>
              <ProductDialog title="Novo produto" onSubmit={(v) => create.mutate(v)} loading={create.isPending} />
            </Dialog>
          </>
        }
      />
      <div className="p-6 space-y-3">
        {selected.size > 0 && (
          <div className="border border-primary/40 bg-primary/5 rounded-md px-4 py-2.5 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs">{selected.size} selecionado(s)</span>
            <div className="flex-1" />
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setBulkPriceOpen(true)}>
              <Percent className="size-3.5" /> Alterar preços
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setActiveMany.mutate({ ids: selectedArr, active: true })} disabled={setActiveMany.isPending}>
              <Power className="size-3.5" /> Ativar
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setActiveMany.mutate({ ids: selectedArr, active: false })} disabled={setActiveMany.isPending}>
              <PowerOff className="size-3.5" /> Desativar
            </Button>
            <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => setConfirmDelete({ ids: selectedArr, label: `${selectedArr.length} produto(s)` })}>
              <Trash2 className="size-3.5" /> Excluir
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Limpar</Button>
          </div>
        )}

        <div className="border border-border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allChecked ? true : someChecked ? "indeterminate" : false} onCheckedChange={toggleAll} aria-label="Selecionar todos" />
                </TableHead>
                <TableHead className="w-32">Cód. barras</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead className="w-20">Unid.</TableHead>
                <TableHead className="w-24 text-right">Preço</TableHead>
                <TableHead className="w-24 text-right">Custo</TableHead>
                <TableHead className="w-24 text-right">Estoque</TableHead>
                <TableHead className="w-20">Status</TableHead>
                <TableHead className="w-24 text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-center py-12 text-sm text-muted-foreground">Nenhum produto encontrado.</TableCell></TableRow>
              )}
              {products.map((p) => {
                const stock = Array.isArray(p.product_stocks) && p.product_stocks[0] ? Number(p.product_stocks[0].quantity) : 0;
                const isSel = selected.has(p.id);
                return (
                  <TableRow key={p.id} className={isSel ? "bg-primary/5" : ""}>
                    <TableCell><Checkbox checked={isSel} onCheckedChange={() => toggleOne(p.id)} aria-label={`Selecionar ${p.name}`} /></TableCell>
                    <TableCell className="font-mono text-xs">
                      {p.barcode ? (<span className="inline-flex items-center gap-1"><Barcode className="size-3" />{p.barcode}</span>) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="font-medium">
                      {p.name}
                      {p.category && <div className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5"><TagIcon className="size-2.5" />{p.category}</div>}
                    </TableCell>
                    <TableCell className="font-mono text-xs uppercase">{p.unit}</TableCell>
                    <TableCell className="text-right font-mono">{brl(Number(p.price_sell))}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">{brl(Number(p.price_cost))}</TableCell>
                    <TableCell className="text-right font-mono">{stock.toFixed(3)}</TableCell>
                    <TableCell>{p.active ? <Badge variant="outline" className="border-primary/40 text-primary">ativo</Badge> : <Badge variant="secondary">inativo</Badge>}</TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        <Button size="icon" variant="ghost" className="size-8" onClick={() => setEditing(p)} aria-label="Editar"><Pencil className="size-3.5" /></Button>
                        <Button size="icon" variant="ghost" className="size-8 text-destructive hover:text-destructive" onClick={() => setConfirmDelete({ ids: [p.id], label: p.name })} aria-label="Excluir"><Trash2 className="size-3.5" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Editar */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        {editing && (
          <ProductDialog
            title={`Editar — ${editing.name}`}
            initial={{
              name: editing.name, barcode: editing.barcode ?? "", sku: editing.sku ?? "",
              unit: editing.unit, category: editing.category ?? "",
              price_sell: editing.price_sell, price_cost: editing.price_cost,
              min_stock: editing.min_stock, max_stock: editing.max_stock ?? undefined,
              lead_time_days: editing.lead_time_days, supplier_id: editing.supplier_id ?? "",
              ncm: editing.ncm ?? "", cfop: editing.cfop ?? "", csosn: editing.csosn ?? "",
            }}
            onSubmit={(v) => update.mutate({ id: editing.id, patch: v })}
            loading={update.isPending}
            submitLabel="Salvar"
          />
        )}
      </Dialog>

      {/* Confirmar exclusão */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir definitivamente?</AlertDialogTitle>
            <AlertDialogDescription>
              Você vai excluir <b>{confirmDelete?.label}</b>. Estoque e histórico de movimentações associados podem ser afetados. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => confirmDelete && removeMany.mutate(confirmDelete.ids)}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Alterar preços em massa */}
      <Dialog open={bulkPriceOpen} onOpenChange={setBulkPriceOpen}>
        <BulkPriceDialog
          count={selected.size}
          loading={bulkPrice.isPending}
          onSubmit={(v) => bulkPrice.mutate({ ids: selectedArr, ...v })}
        />
      </Dialog>
    </div>
  );
}

function cleanProduct(payload: ProductForm, storeId: string) {
  return {
    store_id: storeId,
    name: payload.name,
    barcode: payload.barcode || null,
    sku: payload.sku || null,
    unit: payload.unit,
    category: payload.category || null,
    price_sell: payload.price_sell,
    price_cost: payload.price_cost,
    min_stock: payload.min_stock,
    max_stock: payload.max_stock ?? null,
    lead_time_days: payload.lead_time_days,
    supplier_id: payload.supplier_id || null,
    ncm: payload.ncm || null,
    cfop: payload.cfop || null,
    csosn: payload.csosn || null,
  };
}

function ProductDialog({
  title, initial, onSubmit, loading, submitLabel = "Cadastrar",
}: {
  title: string;
  initial?: Partial<ProductForm>;
  onSubmit: (v: ProductForm) => void;
  loading: boolean;
  submitLabel?: string;
}) {
  const { storeId } = useCurrentStore();
  const [form, setForm] = useState({
    name: initial?.name ?? "", barcode: initial?.barcode ?? "", sku: initial?.sku ?? "",
    unit: initial?.unit ?? "UN", category: initial?.category ?? "",
    price_sell: String(initial?.price_sell ?? "0"),
    price_cost: String(initial?.price_cost ?? "0"),
    min_stock: String(initial?.min_stock ?? "0"),
    max_stock: initial?.max_stock == null ? "" : String(initial.max_stock),
    lead_time_days: String(initial?.lead_time_days ?? "7"),
    supplier_id: initial?.supplier_id ?? "",
    ncm: initial?.ncm ?? "", cfop: initial?.cfop ?? "5102", csosn: initial?.csosn ?? "102",
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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = productSchema.safeParse({ ...form, max_stock: form.max_stock === "" ? undefined : form.max_stock });
    if (!parsed.success) { toast.error(parsed.error.issues[0].message); return; }
    onSubmit(parsed.data);
  };

  return (
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="grid grid-cols-2 gap-4">
        <Field label="Código de barras (EAN)" className="col-span-2">
          <Input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value.replace(/\D/g, "") })} placeholder="7891234567890" className="font-mono" autoFocus />
        </Field>
        <Field label="Nome" className="col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
        <Field label="SKU interno"><Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} /></Field>
        <Field label="Categoria"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Bebidas, Higiene…" /></Field>
        <Field label="Unidade">
          <Select value={form.unit} onValueChange={(v) => setForm({ ...form, unit: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["UN","KG","G","L","ML","CX","PC","M"].map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Fornecedor">
          <Select value={form.supplier_id || "__none__"} onValueChange={(v) => setForm({ ...form, supplier_id: v === "__none__" ? "" : v })}>
            <SelectTrigger><SelectValue placeholder="Opcional" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Sem fornecedor</SelectItem>
              {suppliers?.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Preço de venda (R$)"><Input type="number" step="0.01" min="0" value={form.price_sell} onChange={(e) => setForm({ ...form, price_sell: e.target.value })} /></Field>
        <Field label="Preço de custo (R$)"><Input type="number" step="0.01" min="0" value={form.price_cost} onChange={(e) => setForm({ ...form, price_cost: e.target.value })} /></Field>
        <Field label="Estoque mínimo"><Input type="number" step="0.001" min="0" value={form.min_stock} onChange={(e) => setForm({ ...form, min_stock: e.target.value })} /></Field>
        <Field label="Estoque máximo (opcional)"><Input type="number" step="0.001" min="0" value={form.max_stock} onChange={(e) => setForm({ ...form, max_stock: e.target.value })} /></Field>
        <Field label="Prazo de reposição (dias)"><Input type="number" min="0" value={form.lead_time_days} onChange={(e) => setForm({ ...form, lead_time_days: e.target.value })} /></Field>
        <div className="col-span-2 border-t border-border pt-3 mt-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono mb-2">Tributação</div>
          <div className="grid grid-cols-3 gap-4">
            <Field label="NCM"><Input value={form.ncm} onChange={(e) => setForm({ ...form, ncm: e.target.value })} placeholder="ex 22021000" className="font-mono" /></Field>
            <Field label="CFOP"><Input value={form.cfop} onChange={(e) => setForm({ ...form, cfop: e.target.value })} className="font-mono" /></Field>
            <Field label="CSOSN (Simples)"><Input value={form.csosn} onChange={(e) => setForm({ ...form, csosn: e.target.value })} className="font-mono" /></Field>
          </div>
        </div>
        <DialogFooter className="col-span-2">
          <Button type="submit" disabled={loading}>{loading ? "Salvando..." : submitLabel}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function BulkPriceDialog({
  count, loading, onSubmit,
}: {
  count: number; loading: boolean;
  onSubmit: (v: { field: "price_sell" | "price_cost"; mode: "set" | "percent" | "delta"; value: number }) => void;
}) {
  const [field, setField] = useState<"price_sell" | "price_cost">("price_sell");
  const [mode, setMode] = useState<"set" | "percent" | "delta">("percent");
  const [value, setValue] = useState("10");
  const preview = useMemo(() => {
    const v = Number(value) || 0;
    if (mode === "set") return `Todos os preços passarão para R$ ${v.toFixed(2)}`;
    if (mode === "percent") return `Preços ${v >= 0 ? "aumentarão" : "reduzirão"} ${Math.abs(v)}%`;
    return `Cada preço ${v >= 0 ? "somará" : "subtrairá"} R$ ${Math.abs(v).toFixed(2)}`;
  }, [mode, value]);
  return (
    <DialogContent>
      <DialogHeader><DialogTitle>Alterar preços · {count} produto(s)</DialogTitle></DialogHeader>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Campo</Label>
            <Select value={field} onValueChange={(v) => setField(v as typeof field)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="price_sell">Preço de venda</SelectItem>
                <SelectItem value="price_cost">Preço de custo</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Operação</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="percent">Ajuste percentual (%)</SelectItem>
                <SelectItem value="delta">Somar/subtrair valor (R$)</SelectItem>
                <SelectItem value="set">Definir valor fixo (R$)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label className="text-xs">Valor {mode === "percent" ? "(pode ser negativo)" : ""}</Label>
          <Input type="number" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} className="mt-1 font-mono" autoFocus />
        </div>
        <div className="text-xs text-info bg-info/5 border border-info/30 rounded-md px-3 py-2">{preview}</div>
      </div>
      <DialogFooter>
        <Button disabled={loading || count === 0} onClick={() => onSubmit({ field, mode, value: Number(value) || 0 })}>
          {loading ? "Aplicando..." : `Aplicar em ${count}`}
        </Button>
      </DialogFooter>
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
