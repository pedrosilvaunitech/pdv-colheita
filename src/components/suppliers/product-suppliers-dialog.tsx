/**
 * Vínculo produto ⇄ fornecedor (N:N, tabela `product_suppliers`).
 *
 * A mesma tabela é editada de dois lados:
 *  - `SupplierProductsDialog`: partindo do fornecedor, escolhe seus produtos.
 *  - `ProductSuppliersDialog`: partindo do produto, escolhe seus fornecedores.
 *
 * Regras aplicadas aqui (o banco garante apenas a unicidade do par):
 *  - No máximo um vínculo `is_preferred` por produto. Ao marcar um novo
 *    preferencial, os demais do MESMO produto são desmarcados — é esse o
 *    fornecedor que a tela de Reposição sugere contatar.
 *  - Custos/prazos são por vínculo, porque o mesmo item costuma ter preço e
 *    prazo diferentes em cada fornecedor.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search, Star, Trash2, Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";

export interface ProductSupplierLink {
  id: string;
  product_id: string;
  supplier_id: string;
  supplier_sku: string | null;
  unit_cost: number | null;
  min_order_qty: number | null;
  lead_time_days: number | null;
  is_preferred: boolean;
  products?: { name: string; barcode: string | null; unit: string } | null;
  suppliers?: { name: string; phone: string | null; email: string | null } | null;
}

const LINK_SELECT =
  "id,product_id,supplier_id,supplier_sku,unit_cost,min_order_qty,lead_time_days,is_preferred," +
  "products(name,barcode,unit),suppliers(name,phone,email)";

/** Invalidação compartilhada: reposição e listagens dependem desses vínculos. */
function useLinkMutations(storeId: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["product-suppliers"] });
    qc.invalidateQueries({ queryKey: ["reorder"] });
    qc.invalidateQueries({ queryKey: ["reorder-suppliers"] });
  };

  const add = useMutation({
    mutationFn: async (input: { product_id: string; supplier_id: string; unit_cost?: number }) => {
      const { error } = await supabase.from("product_suppliers").insert({
        store_id: storeId,
        product_id: input.product_id,
        supplier_id: input.supplier_id,
        unit_cost: input.unit_cost ?? 0,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { toast.success("Vínculo criado"); invalidate(); },
    onError: (e: Error) =>
      toast.error(e.message.includes("duplicate") ? "Esse vínculo já existe" : e.message),
  });

  const update = useMutation({
    mutationFn: async (input: { id: string; patch: Record<string, unknown> }) => {
      const { error } = await supabase
        .from("product_suppliers")
        .update(input.patch)
        .eq("id", input.id)
        .eq("store_id", storeId);
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const setPreferred = useMutation({
    mutationFn: async (link: { id: string; product_id: string }) => {
      // Desmarca os demais do mesmo produto antes de promover este.
      const { error: clearError } = await supabase
        .from("product_suppliers")
        .update({ is_preferred: false })
        .eq("store_id", storeId)
        .eq("product_id", link.product_id);
      if (clearError) throw new Error(clearError.message);

      const { error } = await supabase
        .from("product_suppliers")
        .update({ is_preferred: true })
        .eq("id", link.id)
        .eq("store_id", storeId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { toast.success("Fornecedor preferencial atualizado"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("product_suppliers").delete().eq("id", id).eq("store_id", storeId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { toast.success("Vínculo removido"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return { add, update, setPreferred, remove };
}

function NumberCell({
  value, suffix, onCommit, disabled,
}: { value: number | null; suffix?: string; onCommit: (n: number) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value ?? 0);
  return (
    <div className="flex items-center gap-1">
      <Input
        className="h-8 w-24 text-right font-mono"
        inputMode="decimal"
        disabled={disabled}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          const n = Number(draft.replace(",", "."));
          setDraft(null);
          if (Number.isFinite(n) && n !== Number(value ?? 0)) onCommit(n);
        }}
      />
      {suffix && <span className="text-[10px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fornecedor → produtos                                              */
/* ------------------------------------------------------------------ */

export interface SupplierProductsDialogProps {
  storeId: string;
  supplier: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

export function SupplierProductsDialog({ storeId, supplier, onOpenChange }: SupplierProductsDialogProps) {
  const [search, setSearch] = useState("");
  const { add, update, setPreferred, remove } = useLinkMutations(storeId);

  const links = useQuery({
    queryKey: ["product-suppliers", "by-supplier", supplier?.id],
    enabled: Boolean(supplier?.id),
    queryFn: async (): Promise<ProductSupplierLink[]> => {
      const { data, error } = await supabase
        .from("product_suppliers")
        .select(LINK_SELECT)
        .eq("store_id", storeId)
        .eq("supplier_id", supplier!.id);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as ProductSupplierLink[];
    },
  });

  const products = useQuery({
    queryKey: ["products-lite", storeId],
    enabled: Boolean(supplier?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,barcode,unit,price_cost")
        .eq("store_id", storeId)
        .eq("active", true)
        .order("name");
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  const linkedIds = useMemo(
    () => new Set((links.data ?? []).map((l) => l.product_id)),
    [links.data],
  );

  const candidates = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return (products.data ?? [])
      .filter((p) => !linkedIds.has(p.id))
      .filter((p) =>
        p.name.toLowerCase().includes(term) || (p.barcode ?? "").toLowerCase().includes(term))
      .slice(0, 8);
  }, [products.data, linkedIds, search]);

  return (
    <Dialog open={Boolean(supplier)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Produtos de {supplier?.name}</DialogTitle>
          <DialogDescription>
            Vincule quantos produtos quiser. Marque a estrela para definir este fornecedor como
            preferencial do item — é ele que a tela de Reposição vai indicar para contato.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="size-4 absolute left-2 top-2.5 text-muted-foreground" />
            <Input
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar produto por nome ou código de barras para vincular"
            />
          </div>

          {candidates.length > 0 && (
            <div className="border border-border rounded-md divide-y divide-border">
              {candidates.map((p) => (
                <div key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>
                    {p.name}
                    {p.barcode && (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{p.barcode}</span>
                    )}
                  </span>
                  <Button
                    size="sm" variant="outline" className="gap-1"
                    disabled={add.isPending}
                    onClick={() =>
                      add.mutate({
                        product_id: p.id,
                        supplier_id: supplier!.id,
                        unit_cost: Number(p.price_cost ?? 0),
                      })}
                  >
                    <Plus className="size-3.5" /> Vincular
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="border border-border rounded-md overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>Produto</TableHead>
                  <TableHead className="w-32">Cód. fornecedor</TableHead>
                  <TableHead className="w-28 text-right">Custo</TableHead>
                  <TableHead className="w-28 text-right">Mín. pedido</TableHead>
                  <TableHead className="w-24 text-right">Entrega</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.isLoading && (
                  <TableRow><TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin inline mr-2" />Carregando vínculos…
                  </TableCell></TableRow>
                )}
                {!links.isLoading && (links.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Nenhum produto vinculado a este fornecedor.
                  </TableCell></TableRow>
                )}
                {(links.data ?? []).map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <Button
                        size="icon" variant="ghost" className="size-8"
                        title={l.is_preferred ? "Fornecedor preferencial" : "Definir como preferencial"}
                        onClick={() => setPreferred.mutate({ id: l.id, product_id: l.product_id })}
                      >
                        <Star className={`size-4 ${l.is_preferred ? "text-primary fill-current" : "text-muted-foreground"}`} />
                      </Button>
                    </TableCell>
                    <TableCell className="font-medium">
                      {l.products?.name ?? "—"}
                      {l.products?.barcode && (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{l.products.barcode}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Input
                        className="h-8 font-mono text-xs"
                        defaultValue={l.supplier_sku ?? ""}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v !== (l.supplier_sku ?? "")) update.mutate({ id: l.id, patch: { supplier_sku: v || null } });
                        }}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <NumberCell value={Number(l.unit_cost ?? 0)} onCommit={(n) => update.mutate({ id: l.id, patch: { unit_cost: n } })} />
                    </TableCell>
                    <TableCell className="text-right">
                      <NumberCell value={Number(l.min_order_qty ?? 0)} suffix={l.products?.unit} onCommit={(n) => update.mutate({ id: l.id, patch: { min_order_qty: n } })} />
                    </TableCell>
                    <TableCell className="text-right">
                      <NumberCell value={Number(l.lead_time_days ?? 0)} suffix="d" onCommit={(n) => update.mutate({ id: l.id, patch: { lead_time_days: Math.max(0, Math.round(n)) } })} />
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon" variant="ghost"
                        className="size-8 text-destructive hover:text-destructive"
                        onClick={() => remove.mutate(l.id)}
                        aria-label="Remover vínculo"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Produto → fornecedores                                             */
/* ------------------------------------------------------------------ */

export interface ProductSuppliersDialogProps {
  storeId: string;
  product: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}

export function ProductSuppliersDialog({ storeId, product, onOpenChange }: ProductSuppliersDialogProps) {
  const { add, update, setPreferred, remove } = useLinkMutations(storeId);
  const [selected, setSelected] = useState<string>("");

  const links = useQuery({
    queryKey: ["product-suppliers", "by-product", product?.id],
    enabled: Boolean(product?.id),
    queryFn: async (): Promise<ProductSupplierLink[]> => {
      const { data, error } = await supabase
        .from("product_suppliers")
        .select(LINK_SELECT)
        .eq("store_id", storeId)
        .eq("product_id", product!.id);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as ProductSupplierLink[];
    },
  });

  const suppliers = useQuery({
    queryKey: ["suppliers-lite", storeId],
    enabled: Boolean(product?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("suppliers").select("id,name").eq("store_id", storeId).order("name");
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  const linked = useMemo(() => new Set((links.data ?? []).map((l) => l.supplier_id)), [links.data]);
  const available = (suppliers.data ?? []).filter((s) => !linked.has(s.id));

  return (
    <Dialog open={Boolean(product)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Fornecedores de {product?.name}</DialogTitle>
          <DialogDescription>
            O produto pode ter vários fornecedores. O marcado com estrela é o preferencial usado
            na sugestão de reposição.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label className="text-xs">Adicionar fornecedor</Label>
              <select
                className="mt-1 w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">Selecione…</option>
                {available.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <Button
              className="gap-1"
              disabled={!selected || add.isPending}
              onClick={() => {
                add.mutate({ product_id: product!.id, supplier_id: selected });
                setSelected("");
              }}
            >
              <Plus className="size-4" /> Vincular
            </Button>
          </div>

          <div className="border border-border rounded-md overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>Fornecedor</TableHead>
                  <TableHead className="w-28 text-right">Custo</TableHead>
                  <TableHead className="w-24 text-right">Entrega</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(links.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    Nenhum fornecedor vinculado.
                  </TableCell></TableRow>
                )}
                {(links.data ?? []).map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <Button
                        size="icon" variant="ghost" className="size-8"
                        title={l.is_preferred ? "Preferencial" : "Definir como preferencial"}
                        onClick={() => setPreferred.mutate({ id: l.id, product_id: l.product_id })}
                      >
                        <Star className={`size-4 ${l.is_preferred ? "text-primary fill-current" : "text-muted-foreground"}`} />
                      </Button>
                    </TableCell>
                    <TableCell className="font-medium">
                      {l.suppliers?.name ?? "—"}
                      <div className="text-xs text-muted-foreground">
                        {[l.suppliers?.phone, l.suppliers?.email].filter(Boolean).join(" · ") || "sem contato"}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <NumberCell value={Number(l.unit_cost ?? 0)} onCommit={(n) => update.mutate({ id: l.id, patch: { unit_cost: n } })} />
                    </TableCell>
                    <TableCell className="text-right">
                      <NumberCell value={Number(l.lead_time_days ?? 0)} suffix="d" onCommit={(n) => update.mutate({ id: l.id, patch: { lead_time_days: Math.max(0, Math.round(n)) } })} />
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon" variant="ghost"
                        className="size-8 text-destructive hover:text-destructive"
                        onClick={() => remove.mutate(l.id)}
                        aria-label="Remover vínculo"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Resumo curto usado em tabelas (ex.: badge de preferencial). */
export function PreferredBadge() {
  return (
    <Badge variant="outline" className="gap-1 border-primary/40 text-primary">
      <Star className="size-3 fill-current" /> Preferencial
    </Badge>
  );
}

export { useLinkMutations };
