import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Barcode, Trash2, ScanBarcode, Banknote, CreditCard, Smartphone } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/pdv")({
  component: PdvPage,
});

interface CartItem {
  product_id: string;
  name: string;
  barcode: string | null;
  unit_price: number;
  quantity: number;
}

function PdvPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [method, setMethod] = useState<"dinheiro" | "pix" | "debito" | "credito">("dinheiro");
  const [received, setReceived] = useState("");

  useEffect(() => { inputRef.current?.focus(); }, [storeId]);

  const total = useMemo(() => cart.reduce((s, i) => s + i.quantity * i.unit_price, 0), [cart]);
  const change = Math.max(0, Number(received || 0) - total);

  const addByBarcode = async (raw: string) => {
    const code = raw.trim();
    if (!code || !storeId) return;
    const { data, error } = await supabase.from("products").select("id,name,barcode,price_sell").eq("store_id", storeId).eq("barcode", code).eq("active", true).maybeSingle();
    if (error) { toast.error(error.message); return; }
    if (!data) { toast.error(`Código ${code} não encontrado`); return; }
    setCart((prev) => {
      const idx = prev.findIndex((i) => i.product_id === data.id);
      if (idx >= 0) { const cp = [...prev]; cp[idx] = { ...cp[idx], quantity: cp[idx].quantity + 1 }; return cp; }
      return [...prev, { product_id: data.id, name: data.name, barcode: data.barcode, unit_price: Number(data.price_sell), quantity: 1 }];
    });
    setScan("");
  };

  const finalize = useMutation({
    mutationFn: async () => {
      if (!storeId || cart.length === 0) throw new Error("Carrinho vazio");
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error("Não autenticado");
      const { data: sale, error } = await supabase.from("sales").insert({
        store_id: storeId, status: "finalizada",
        subtotal: total, discount: 0, total,
        operator_id: user.user.id, finalized_at: new Date().toISOString(),
      }).select("id").single();
      if (error) throw error;

      const items = cart.map((i) => ({
        sale_id: sale.id, store_id: storeId, product_id: i.product_id,
        product_name: i.name, barcode: i.barcode, quantity: i.quantity,
        unit_price: i.unit_price, total: i.quantity * i.unit_price,
      }));
      const { error: e2 } = await supabase.from("sale_items").insert(items);
      if (e2) throw e2;

      const { error: e3 } = await supabase.from("sale_payments").insert({
        sale_id: sale.id, store_id: storeId, method, amount: total,
      });
      if (e3) throw e3;

      // baixa estoque
      const movs = cart.map((i) => ({
        store_id: storeId, product_id: i.product_id,
        type: "venda" as const, quantity: i.quantity,
        ref_sale_id: sale.id, created_by: user.user!.id,
      }));
      const { error: e4 } = await supabase.from("stock_movements").insert(movs);
      if (e4) throw e4;

      return sale.id;
    },
    onSuccess: () => {
      toast.success("Venda finalizada");
      setCart([]); setReceived(""); qc.invalidateQueries({ queryKey: ["dashboard"] });
      inputRef.current?.focus();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!store) return <StoreRequired />;

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="PDV · Frente de caixa"
        description={`Loja ${store.fantasy_name || store.name} · operador ativo`}
      />
      <div className="flex-1 grid grid-cols-3 gap-4 p-6 overflow-hidden">
        {/* Coluna scan + carrinho */}
        <div className="col-span-2 flex flex-col gap-4 min-h-0">
          <form onSubmit={(e) => { e.preventDefault(); addByBarcode(scan); }} className="border border-border rounded-md bg-card p-4 flex items-center gap-3">
            <ScanBarcode className="size-8 text-primary" />
            <div className="flex-1">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Leitor de código de barras</div>
              <Input ref={inputRef} value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Bipe ou digite o código EAN e Enter" className="border-0 shadow-none text-2xl font-mono h-12 focus-visible:ring-0 px-0" autoFocus />
            </div>
            <Button type="submit" size="lg" className="h-12">Adicionar</Button>
          </form>

          <div className="flex-1 border border-border rounded-md bg-card overflow-auto min-h-0">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead className="w-32">Código</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead className="w-20 text-right">Qtd</TableHead>
                  <TableHead className="w-24 text-right">Unit.</TableHead>
                  <TableHead className="w-28 text-right">Total</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cart.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center py-16 text-sm text-muted-foreground">Carrinho vazio. Bipe um produto.</TableCell></TableRow>
                )}
                {cart.map((i, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="font-mono text-xs"><Barcode className="size-3 inline mr-1" />{i.barcode || "—"}</TableCell>
                    <TableCell>{i.name}</TableCell>
                    <TableCell className="text-right font-mono">
                      <Input type="number" min="1" step="0.001" value={i.quantity}
                        onChange={(e) => { const cp = [...cart]; cp[idx] = { ...cp[idx], quantity: Number(e.target.value) || 1 }; setCart(cp); }}
                        className="h-7 w-20 text-right font-mono ml-auto" />
                    </TableCell>
                    <TableCell className="text-right font-mono">{brl(i.unit_price)}</TableCell>
                    <TableCell className="text-right font-mono font-semibold">{brl(i.quantity * i.unit_price)}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => setCart(cart.filter((_, x) => x !== idx))}><Trash2 className="size-4 text-destructive" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Coluna totais + pagamento */}
        <div className="flex flex-col gap-4 min-h-0">
          <div className="border border-border rounded-md bg-card p-5">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Total a pagar</div>
            <div className="text-5xl font-mono font-bold text-primary mt-1">{brl(total)}</div>
            <div className="text-xs text-muted-foreground mt-1">{cart.length} item(ns) · {cart.reduce((s, i) => s + i.quantity, 0).toFixed(0)} un.</div>
          </div>

          <div className="border border-border rounded-md bg-card p-5 space-y-3">
            <div className="text-xs font-medium mb-1">Forma de pagamento</div>
            <div className="grid grid-cols-2 gap-2">
              <PayBtn active={method === "dinheiro"} onClick={() => setMethod("dinheiro")} icon={Banknote} label="Dinheiro" />
              <PayBtn active={method === "pix"} onClick={() => setMethod("pix")} icon={Smartphone} label="PIX" />
              <PayBtn active={method === "debito"} onClick={() => setMethod("debito")} icon={CreditCard} label="Débito" />
              <PayBtn active={method === "credito"} onClick={() => setMethod("credito")} icon={CreditCard} label="Crédito" />
            </div>

            {method === "dinheiro" && (
              <div>
                <div className="text-[10px] font-mono uppercase text-muted-foreground">Valor recebido</div>
                <Input type="number" step="0.01" value={received} onChange={(e) => setReceived(e.target.value)} className="font-mono text-lg" />
                <div className="text-xs mt-1 flex justify-between"><span>Troco</span><span className="font-mono font-semibold text-primary">{brl(change)}</span></div>
              </div>
            )}
          </div>

          <Button size="lg" className="h-14 text-base" disabled={cart.length === 0 || finalize.isPending} onClick={() => finalize.mutate()}>
            {finalize.isPending ? "Finalizando..." : "Finalizar venda"}
          </Button>
          <p className="text-[10px] font-mono uppercase text-muted-foreground text-center">
            Emissão de NFC-e disponível após configurar módulo fiscal
          </p>
        </div>
      </div>
    </div>
  );
}

function PayBtn({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex flex-col items-center gap-1 py-3 rounded-sm border text-xs transition-colors ${active ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent/50"}`}>
      <Icon className="size-5" />{label}
    </button>
  );
}

function brl(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
