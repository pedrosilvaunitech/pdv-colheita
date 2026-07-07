import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Barcode, Trash2, ScanBarcode, Banknote, CreditCard, Smartphone, Lock, FileText, Receipt, Printer } from "lucide-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { buildReceiptHTML, printReceipt, ReceiptData } from "@/lib/receipt";
import { isEscPosSupported, isEscPosEnabled, requestEscPosPort, setEscPosEnabled, tryPrintEscPos } from "@/lib/escpos";

export const Route = createFileRoute("/_authenticated/pdv")({ component: PdvPage });

interface CartItem {
  product_id: string;
  name: string;
  barcode: string | null;
  unit_price: number;
  quantity: number;
  is_weighable: boolean;
}

type PayMethod = "dinheiro" | "pix" | "debito" | "credito";

function PdvPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [method, setMethod] = useState<PayMethod>("dinheiro");
  const [received, setReceived] = useState("");
  const [docType, setDocType] = useState<"fiscal" | "nao_fiscal">("nao_fiscal");
  const [customerCpf, setCustomerCpf] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [discount, setDiscount] = useState("0");

  const settings = useQuery({
    queryKey: ["receipt_settings", storeId],
    enabled: !!storeId,
    queryFn: async () => {
      const { data, error } = await supabase.from("receipt_settings").select("*").eq("store_id", storeId!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const openReg = useQuery({
    queryKey: ["cash_open", storeId],
    enabled: !!storeId,
    queryFn: async () => {
      const { data, error } = await supabase.from("cash_registers")
        .select("id,terminal,opening_amount,opened_at")
        .eq("store_id", storeId!).eq("status", "aberto")
        .order("opened_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => { if (settings.data?.default_document) setDocType(settings.data.default_document as "fiscal" | "nao_fiscal"); }, [settings.data?.default_document]);
  useEffect(() => { inputRef.current?.focus(); }, [storeId]);

  const subtotal = useMemo(() => cart.reduce((s, i) => s + i.quantity * i.unit_price, 0), [cart]);
  const disc = Math.min(Number(discount || 0), subtotal);
  const total = subtotal - disc;
  const change = Math.max(0, Number(received || 0) - total);

  const addByBarcode = async (raw: string) => {
    const code = raw.trim();
    if (!code || !storeId) return;
    // Support EAN-13 weighable (starts with "2") — 2 NNNNN PPPPP D (5-digit price in cents)
    let barcode = code;
    let weighablePrice: number | null = null;
    if (code.length === 13 && code.startsWith("2")) {
      const priceCents = Number(code.slice(7, 12));
      if (!Number.isNaN(priceCents)) { weighablePrice = priceCents / 100; barcode = code.slice(0, 7); }
    }
    const { data, error } = await supabase.from("products")
      .select("id,name,barcode,price_sell,is_weighable")
      .eq("store_id", storeId).eq("barcode", barcode).eq("active", true).maybeSingle();
    if (error) { toast.error(error.message); return; }
    if (!data) { toast.error(`Código ${code} não encontrado`); return; }
    const price = weighablePrice ?? Number(data.price_sell);
    setCart((prev) => {
      if (weighablePrice != null) {
        return [...prev, { product_id: data.id, name: data.name, barcode: data.barcode, unit_price: 1, quantity: price, is_weighable: true }];
      }
      const idx = prev.findIndex((i) => i.product_id === data.id);
      if (idx >= 0) { const cp = [...prev]; cp[idx] = { ...cp[idx], quantity: cp[idx].quantity + 1 }; return cp; }
      return [...prev, { product_id: data.id, name: data.name, barcode: data.barcode, unit_price: price, quantity: 1, is_weighable: !!data.is_weighable }];
    });
    setScan("");
  };

  const finalize = useMutation({
    mutationFn: async () => {
      if (!storeId || cart.length === 0) throw new Error("Carrinho vazio");
      if (!openReg.data) throw new Error("Abra o caixa antes de vender");
      if (method === "dinheiro" && Number(received || 0) < total) throw new Error("Valor recebido insuficiente");
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error("Não autenticado");

      const { data: sale, error } = await supabase.from("sales").insert({
        store_id: storeId, status: "finalizada",
        subtotal, discount: disc, total,
        operator_id: user.user.id, finalized_at: new Date().toISOString(),
        cash_register_id: openReg.data.id, document_type: docType,
        change_given: change,
        customer_cpf: customerCpf || null, customer_name: customerName || null,
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

      const movs = cart.map((i) => ({
        store_id: storeId, product_id: i.product_id,
        type: "venda" as const, quantity: i.quantity,
        ref_sale_id: sale.id, created_by: user.user!.id,
      }));
      const { error: e4 } = await supabase.from("stock_movements").insert(movs);
      if (e4) throw e4;

      return sale.id;
    },
    onSuccess: async (saleId) => {
      toast.success(docType === "fiscal" ? "Venda finalizada · NFC-e pendente de emissão" : "Venda finalizada");
      const shouldPrint = settings.data?.print_auto ?? true;
      if (shouldPrint && store) {
        const r: ReceiptData = {
          store: { name: store.fantasy_name || store.name, cnpj: store.cnpj, address: [store.city, store.state].filter(Boolean).join(" · ") || null, phone: null },
          header: settings.data?.header_text ?? null, footer: settings.data?.footer_text ?? null,
          paper_width: (settings.data?.paper_width ?? 80) as 58 | 80,
          items: cart.map((i) => ({ name: i.name, quantity: i.quantity, unit_price: i.unit_price, total: i.quantity * i.unit_price, barcode: i.barcode })),
          subtotal, discount: disc, total, payment_method: method, received: Number(received || total), change,
          sale_id: saleId, document_type: docType, issued_at: new Date(),
          customer: customerName || customerCpf ? { name: customerName, doc: customerCpf } : undefined,
        };
        // 1º tenta ESC/POS direto (Web Serial). Se não estiver configurado/falhar, cai pro HTML térmico.
        const printed = await tryPrintEscPos(r);
        if (!printed) printReceipt(buildReceiptHTML(r));
      }
      setCart([]); setReceived(""); setDiscount("0"); setCustomerCpf(""); setCustomerName("");
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["cash_sales"] });
      inputRef.current?.focus();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!store) return <StoreRequired />;

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="PDV · Frente de caixa"
        description={`Loja ${store.fantasy_name || store.name}${openReg.data ? ` · caixa ${openReg.data.terminal} aberto` : " · CAIXA FECHADO"}`}
        actions={
          <div className="flex items-center gap-2">
            <EscPosButton />
            <Select value={docType} onValueChange={(v) => setDocType(v as "fiscal" | "nao_fiscal")}>
              <SelectTrigger className="w-56 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nao_fiscal"><span className="inline-flex items-center gap-2"><Receipt className="size-4" />Recibo não-fiscal</span></SelectItem>
                <SelectItem value="fiscal"><span className="inline-flex items-center gap-2"><FileText className="size-4" />NFC-e (fiscal)</span></SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />

      {!openReg.data && (
        <div className="mx-6 mt-4 border border-warning/40 bg-warning/10 rounded-md p-4 flex items-center gap-3">
          <Lock className="size-5 text-warning" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-warning">Caixa fechado</div>
            <div className="text-xs text-muted-foreground">Você precisa abrir o caixa para registrar vendas.</div>
          </div>
          <Button asChild size="sm"><Link to="/caixa">Ir para o caixa</Link></Button>
        </div>
      )}

      <div className="flex-1 grid grid-cols-3 gap-4 p-6 overflow-hidden">
        <div className="col-span-2 flex flex-col gap-4 min-h-0">
          <form onSubmit={(e) => { e.preventDefault(); addByBarcode(scan); }} className="border border-border rounded-md bg-card p-4 flex items-center gap-3">
            <ScanBarcode className="size-8 text-primary" />
            <div className="flex-1">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Leitor de código de barras</div>
              <Input ref={inputRef} value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Bipe ou digite o código EAN e Enter" className="border-0 shadow-none text-2xl font-mono h-12 focus-visible:ring-0 px-0" autoFocus disabled={!openReg.data} />
            </div>
            <Button type="submit" size="lg" className="h-12" disabled={!openReg.data}>Adicionar</Button>
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
                    <TableCell>{i.name}{i.is_weighable && <span className="ml-2 text-[10px] font-mono uppercase text-primary">balança</span>}</TableCell>
                    <TableCell className="text-right font-mono">
                      <Input type="number" min="0.001" step="0.001" value={i.quantity}
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

        <div className="flex flex-col gap-3 min-h-0 overflow-auto">
          <div className="border border-border rounded-md bg-card p-5">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Total a pagar</div>
            <div className="text-5xl font-mono font-bold text-primary mt-1">{brl(total)}</div>
            <div className="text-xs text-muted-foreground mt-1">{cart.length} item(ns) · subtotal {brl(subtotal)}</div>
          </div>

          {docType === "fiscal" && (
            <div className="border border-border rounded-md bg-card p-4 space-y-2">
              <div className="text-xs font-medium">Cliente (opcional na nota)</div>
              <Input placeholder="CPF/CNPJ" value={customerCpf} onChange={(e) => setCustomerCpf(e.target.value)} className="font-mono text-sm" />
              <Input placeholder="Nome" value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="text-sm" />
            </div>
          )}

          <div className="border border-border rounded-md bg-card p-4 space-y-2">
            <div className="text-xs font-medium">Desconto (R$)</div>
            <Input type="number" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} className="font-mono" />
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
            {method === "pix" && (
              <div className="text-[10px] font-mono uppercase text-muted-foreground">Pix real (QR dinâmico) na Fase 3</div>
            )}
          </div>

          <Button size="lg" className="h-14 text-base gap-2" disabled={cart.length === 0 || finalize.isPending || !openReg.data} onClick={() => finalize.mutate()}>
            <Printer className="size-5" />
            {finalize.isPending ? "Finalizando..." : `Finalizar e imprimir · ${docType === "fiscal" ? "NFC-e" : "Recibo"}`}
          </Button>
          {docType === "fiscal" && (
            <p className="text-[10px] font-mono uppercase text-warning text-center">
              Emissão real de NFC-e pendente · configure módulo fiscal
            </p>
          )}
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

function EscPosButton() {
  const [enabled, setEnabled] = useState<boolean>(() => isEscPosEnabled());
  const supported = isEscPosSupported();
  const onConnect = async () => {
    try {
      await requestEscPosPort();
      setEnabled(true);
      toast.success("Impressora térmica conectada · impressão ESC/POS ativa");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao conectar impressora");
    }
  };
  const onDisconnect = () => { setEscPosEnabled(false); setEnabled(false); toast.info("Impressão ESC/POS desativada · voltando ao HTML"); };
  if (!supported) {
    return <span className="text-[10px] font-mono uppercase text-muted-foreground border border-dashed border-border rounded px-2 py-1">Web Serial n/d</span>;
  }
  return enabled ? (
    <Button variant="outline" size="sm" className="gap-2 h-9" onClick={onDisconnect}>
      <Printer className="size-4 text-primary" /><span className="text-xs">ESC/POS ativo</span>
    </Button>
  ) : (
    <Button variant="outline" size="sm" className="gap-2 h-9" onClick={onConnect}>
      <Printer className="size-4" /><span className="text-xs">Conectar impressora</span>
    </Button>
  );
}
