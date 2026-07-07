import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Barcode, Trash2, ScanBarcode, Banknote, CreditCard, Smartphone, Lock, FileText, Receipt, Printer, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { buildReceiptHTML, printReceipt, ReceiptData } from "@/lib/receipt";
import { tryPrintEscPos } from "@/lib/escpos";
import { EscPosPrinterButton } from "@/components/pdv/escpos-printer-button";
import { PixChargeModal } from "@/components/pix-charge-modal";
import { CaixaQuickActions } from "@/components/pdv/caixa-quick-actions";
import { ScaleWidget } from "@/components/pdv/scale-widget";
import { getToledoScale } from "@/lib/toledo-scale";

export const Route = createFileRoute("/_authenticated/pdv")({
  component: PdvPage,
  validateSearch: (s: Record<string, unknown>) => ({ kiosk: s.kiosk === "1" || s.kiosk === 1 ? "1" as const : undefined }),
});

interface CartItem {
  product_id: string;
  name: string;
  barcode: string | null;
  unit_price: number;
  quantity: number;
  is_weighable: boolean;
}

type PayMethod = "dinheiro" | "pix" | "debito" | "credito";
interface PayEntry {
  method: PayMethod;
  amount: number;
  installments?: number; // credito parcelado
  label: string; // ex: "PIX", "Crédito 3x"
}

const METHOD_LABEL: Record<PayMethod, string> = {
  dinheiro: "Dinheiro",
  pix: "PIX",
  debito: "Débito",
  credito: "Crédito",
};

function PdvPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [docType, setDocType] = useState<"fiscal" | "nao_fiscal">("nao_fiscal");
  const [customerCpf, setCustomerCpf] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [discount, setDiscount] = useState("0");

  // Pagamentos parciais
  const [payments, setPayments] = useState<PayEntry[]>([]);
  const [payMethod, setPayMethod] = useState<PayMethod>("dinheiro");
  const [payAmount, setPayAmount] = useState<string>("");
  const [payInstallments, setPayInstallments] = useState<number>(1);
  const [pixOpen, setPixOpen] = useState(false);
  const [pixAmount, setPixAmount] = useState<number>(0);

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
  const total = Math.max(0, subtotal - disc);
  const paid = useMemo(() => payments.reduce((s, p) => s + p.amount, 0), [payments]);
  const remaining = Math.max(0, Number((total - paid).toFixed(2)));
  const overpaid = Math.max(0, Number((paid - total).toFixed(2))); // troco (só faz sentido em dinheiro)
  const canFinalize = cart.length > 0 && total > 0 && paid + 1e-9 >= total;

  // Sempre que muda o total ou pagamentos, sugere o restante no input
  useEffect(() => {
    setPayAmount(remaining > 0 ? remaining.toFixed(2) : "");
  }, [remaining, payMethod]);

  const addByBarcode = async (raw: string) => {
    let code = raw.trim();
    if (!code || !storeId) return;

    // Prefixo multiplicador: "N*<codigo>"  ou  "N*"  (sem código = aplica ao último item).
    // Exemplos: "3*7891234567895" → 3 unidades em UMA linha.
    //           "5*"              → multiplica a última linha por 5.
    let multiplier = 1;
    const mMatch = code.match(/^(\d+)\s*[*xX]\s*(.*)$/);
    if (mMatch) {
      const n = Number(mMatch[1]);
      if (!Number.isFinite(n) || n <= 0 || n > 9999) { toast.error("Multiplicador inválido"); return; }
      multiplier = n;
      code = mMatch[2].trim();
      // Se só veio "N*" sem código, aplica no último item do carrinho.
      if (!code) {
        setCart((prev) => {
          if (prev.length === 0) { toast.error("Carrinho vazio — bipe um produto primeiro"); return prev; }
          const cp = [...prev];
          const last = cp[cp.length - 1];
          cp[cp.length - 1] = { ...last, quantity: Number((last.quantity * multiplier).toFixed(3)) };
          toast.success(`${last.name} × ${multiplier}`);
          return cp;
        });
        setScan("");
        return;
      }
    }

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

    // Regra de linhas:
    //  - Peso embutido (EAN-2)  → sempre linha nova (peso é único).
    //  - Com multiplicador N*   → adiciona UMA linha com quantidade N (não mescla).
    //  - Bip simples repetido   → cada bip cria uma linha nova, nunca soma.
    setCart((prev) => {
      if (weighablePrice != null) {
        return [...prev, { product_id: data.id, name: data.name, barcode: data.barcode, unit_price: 1, quantity: price, is_weighable: true }];
      }
      const qty = multiplier;
      return [...prev, { product_id: data.id, name: data.name, barcode: data.barcode, unit_price: price, quantity: qty, is_weighable: !!data.is_weighable }];
    });
    if (multiplier > 1) toast.success(`${data.name} × ${multiplier}`);
    setScan("");
  };

  /**
   * Aplica um peso lido da balança ao último item pesável do carrinho.
   * Se nenhum item pesável estiver presente, avisa o operador.
   * Se a balança emitir uma leitura durante a chamada de leitura direta
   * pelo scanner, o mesmo caminho pode ser usado.
   */
  const applyWeightToLastWeighable = (kg: number) => {
    if (kg <= 0) { toast.error("Peso inválido"); return; }
    setCart((prev) => {
      const idx = [...prev].reverse().findIndex((i) => i.is_weighable);
      if (idx === -1) { toast.error("Nenhum item pesável no carrinho. Bipe o produto pesável primeiro."); return prev; }
      const realIdx = prev.length - 1 - idx;
      const cp = [...prev];
      cp[realIdx] = { ...cp[realIdx], quantity: Number(kg.toFixed(3)) };
      toast.success(`Peso ${kg.toFixed(3)} kg aplicado em "${cp[realIdx].name}"`);
      return cp;
    });
  };

  // Se a balança já estiver ligada e o operador bipar um produto pesável
  // sem preço embutido, tenta ler o peso automaticamente após adicionar ao carrinho.
  useEffect(() => {
    const last = cart[cart.length - 1];
    if (!last || !last.is_weighable) return;
    // só dispara auto-leitura quando qty ainda é 1 (default) e a balança está conectada
    if (last.quantity !== 1) return;
    const scale = getToledoScale();
    if (!scale.isOpen()) return;
    let cancelled = false;
    scale.requestWeight().then((r) => {
      if (cancelled) return;
      if (r.status === "ok" && r.weightKg > 0) applyWeightToLastWeighable(r.weightKg);
    }).catch(() => { /* silencioso — operador pode ler manualmente */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.length]);

  const MIN_PARCEL_VALUE = 5; // R$ mínimo por parcela (regra usual de adquirente)
  const MAX_INSTALLMENTS = 12;

  const addPayment = () => {
    const value = Number(payAmount || 0);
    if (!Number.isFinite(value) || value <= 0) { toast.error("Informe um valor válido de pagamento"); return; }
    // Validação de parcelas — só permite parcelamento em crédito
    let installments: number | undefined;
    if (payMethod === "credito") {
      const n = Math.trunc(Number(payInstallments || 1));
      if (!Number.isInteger(n) || n < 1 || n > MAX_INSTALLMENTS) {
        toast.error(`Parcelas devem ser um número inteiro entre 1 e ${MAX_INSTALLMENTS}`); return;
      }
      if (n > 1 && value / n < MIN_PARCEL_VALUE) {
        toast.error(`Cada parcela precisa ser ≥ ${brl(MIN_PARCEL_VALUE)} (parcela atual: ${brl(value / n)})`); return;
      }
      installments = n;
    } else if (payInstallments !== 1) {
      // reset silencioso: parcelas só existem para crédito
      setPayInstallments(1);
    }
    if (payMethod === "pix") {
      if (!openReg.data) { toast.error("Abra o caixa antes"); return; }
      setPixAmount(value);
      setPixOpen(true);
      return;
    }
    const label = installments && installments > 1
      ? `Crédito ${installments}x de ${brl(value / installments)}`
      : METHOD_LABEL[payMethod];
    setPayments((p) => [...p, { method: payMethod, amount: value, installments, label }]);
    setPayAmount("");
    setPayInstallments(1);
  };

  const removePayment = (idx: number) => setPayments((p) => p.filter((_, i) => i !== idx));

  const finalize = useMutation({
    mutationFn: async () => {
      if (!storeId || cart.length === 0) throw new Error("Carrinho vazio");
      if (!openReg.data) throw new Error("Abra o caixa antes de vender");
      if (paid + 1e-9 < total) throw new Error(`Faltam ${brl(remaining)} para completar o pagamento`);
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error("Não autenticado");

      // Ajusta o último pagamento em dinheiro para absorver o troco (over) no valor recebido total,
      // mas o "amount" gravado por pagamento reflete o valor efetivamente pago à venda (sem troco)
      const change = overpaid;

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

      // Rateia o troco: reduz o excedente do último pagamento em dinheiro (se houver);
      // caso contrário, do último pagamento (raro — só ocorre se todo mundo pagou "demais").
      const payRows = payments.map((p) => ({ ...p }));
      if (change > 0) {
        const lastCashIdx = [...payRows].reverse().findIndex((p) => p.method === "dinheiro");
        const targetIdx = lastCashIdx === -1 ? payRows.length - 1 : payRows.length - 1 - lastCashIdx;
        payRows[targetIdx] = { ...payRows[targetIdx], amount: Number((payRows[targetIdx].amount - change).toFixed(2)) };
      }
      const { error: e3 } = await supabase.from("sale_payments").insert(
        payRows.map((p) => ({
          sale_id: sale.id, store_id: storeId, method: p.method, amount: p.amount,
          installments: p.installments ?? null,
        }))
      );
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
        const paymentLabel = payments.map((p) => `${p.label} ${brl(p.amount)}`).join(" + ");
        const r: ReceiptData = {
          store: { name: store.fantasy_name || store.name, cnpj: store.cnpj, address: [store.city, store.state].filter(Boolean).join(" · ") || null, phone: null },
          header: settings.data?.header_text ?? null, footer: settings.data?.footer_text ?? null,
          paper_width: (settings.data?.paper_width ?? 80) as 58 | 80,
          items: cart.map((i) => ({ name: i.name, quantity: i.quantity, unit_price: i.unit_price, total: i.quantity * i.unit_price, barcode: i.barcode })),
          subtotal, discount: disc, total, payment_method: paymentLabel || "—", received: paid, change: overpaid,
          sale_id: saleId, document_type: docType, issued_at: new Date(),
          customer: customerName || customerCpf ? { name: customerName, doc: customerCpf } : undefined,
        };
        const printed = await tryPrintEscPos(r);
        if (!printed) printReceipt(buildReceiptHTML(r));
      }
      setCart([]); setPayments([]); setDiscount("0"); setCustomerCpf(""); setCustomerName("");
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
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {storeId && <CaixaQuickActions storeId={storeId} />}
            <ScaleWidget onWeight={(kg) => applyWeightToLastWeighable(kg)} />
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
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Leitor · use <span className="text-primary">N*</span> antes do código para quantidade (ex.: 3*789… ou apenas 5* para multiplicar o último item)</div>
              <Input ref={inputRef} value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Bipe ou digite EAN — prefixo N* multiplica" className="border-0 shadow-none text-2xl font-mono h-12 focus-visible:ring-0 px-0" autoFocus disabled={!openReg.data} />
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
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="border border-border rounded p-2">
                <div className="text-[10px] font-mono uppercase text-muted-foreground">Pago</div>
                <div className="font-mono font-semibold">{brl(paid)}</div>
              </div>
              <div className={`border rounded p-2 ${remaining > 0 ? "border-warning/50 bg-warning/5" : "border-primary/50 bg-primary/5"}`}>
                <div className="text-[10px] font-mono uppercase text-muted-foreground">Restante</div>
                <div className={`font-mono font-semibold ${remaining > 0 ? "text-warning" : "text-primary"}`}>{brl(remaining)}</div>
              </div>
            </div>
            {overpaid > 0 && (
              <div className="text-xs mt-2 flex justify-between"><span className="text-muted-foreground">Troco</span><span className="font-mono font-semibold text-primary">{brl(overpaid)}</span></div>
            )}
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

          <div className="border border-border rounded-md bg-card p-4 space-y-3">
            <div className="text-xs font-medium mb-1">Forma de pagamento</div>
            <div className="grid grid-cols-2 gap-2">
              <PayBtn active={payMethod === "dinheiro"} onClick={() => setPayMethod("dinheiro")} icon={Banknote} label="Dinheiro" />
              <PayBtn active={payMethod === "pix"} onClick={() => setPayMethod("pix")} icon={Smartphone} label="PIX" />
              <PayBtn active={payMethod === "debito"} onClick={() => setPayMethod("debito")} icon={CreditCard} label="Débito" />
              <PayBtn active={payMethod === "credito"} onClick={() => setPayMethod("credito")} icon={CreditCard} label="Crédito" />
            </div>

            {payMethod === "credito" && (
              <div>
                <div className="text-[10px] font-mono uppercase text-muted-foreground">Parcelas</div>
                <Select value={String(payInstallments)} onValueChange={(v) => setPayInstallments(Number(v))}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                      <SelectItem key={n} value={String(n)}>{n === 1 ? "1x à vista" : `${n}x ${brl(Number(payAmount || 0) / n)}`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <div className="text-[10px] font-mono uppercase text-muted-foreground">Valor deste pagamento</div>
              <div className="flex gap-2">
                <Input type="number" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} className="font-mono text-lg" />
                <Button type="button" variant="outline" size="sm" className="h-10 shrink-0" onClick={() => setPayAmount(remaining.toFixed(2))} disabled={remaining <= 0}>Restante</Button>
              </div>
            </div>

            <Button type="button" size="sm" className="w-full gap-2" onClick={addPayment} disabled={!openReg.data || total <= 0}>
              <Plus className="size-4" /> {payMethod === "pix" ? "Gerar QR PIX" : "Adicionar pagamento"}
            </Button>

            {payments.length > 0 && (
              <div className="border-t border-border pt-2 space-y-1">
                {payments.map((p, idx) => (
                  <div key={idx} className="flex items-center justify-between text-xs font-mono py-1">
                    <span className="text-muted-foreground">{p.label}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{brl(p.amount)}</span>
                      <button type="button" onClick={() => removePayment(idx)} className="text-destructive hover:opacity-70"><X className="size-3" /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Button size="lg" className="h-14 text-base gap-2" disabled={!canFinalize || finalize.isPending || !openReg.data} onClick={() => finalize.mutate()}>
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

      {storeId && (
        <PixChargeModal
          open={pixOpen}
          onClose={() => setPixOpen(false)}
          onPaid={() => {
            setPayments((p) => [...p, { method: "pix", amount: pixAmount, label: "PIX" }]);
            setPixOpen(false);
          }}
          storeId={storeId}
          amount={pixAmount}
          description={`Venda PDV · ${cart.length} item(ns)`}
        />
      )}
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

function EscPosButton() { return <EscPosPrinterButton />; }
