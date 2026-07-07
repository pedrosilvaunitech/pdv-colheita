import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, BarChart3, Bot, CalendarDays, PackagePlus, ShoppingCart, TrendingDown, TrendingUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/relatorios")({ component: RelatoriosPage });

type Period = "today" | "month" | "custom";
type SaleRow = { id: string; total: number; created_at: string; finalized_at: string | null };
type ItemRow = { sale_id: string; product_id: string; product_name: string; quantity: number; total: number };
type ProductRow = { id: string; name: string; category: string | null; min_stock: number; max_stock: number | null; reorder_qty: number | null };
type StockRow = { product_id: string; quantity: number; min_quantity: number };
type PaymentRow = { method: string; amount: number; sale_id: string; installments: number | null };

function RelatoriosPage() {
  const { store, storeId } = useCurrentStore();
  const [period, setPeriod] = useState<Period>("month");
  const [from, setFrom] = useState(() => startOfMonthInput());
  const [to, setTo] = useState(() => todayInput());
  const [category, setCategory] = useState("__all__");

  const range = useMemo(() => buildRange(period, from, to), [period, from, to]);

  const report = useQuery({
    queryKey: ["reports", storeId, range.fromIso, range.toIso, category],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const salesRes = await supabase
        .from("sales")
        .select("id,total,created_at,finalized_at")
        .eq("store_id", storeId!)
        .eq("status", "finalizada")
        .gte("created_at", range.fromIso)
        .lte("created_at", range.toIso)
        .order("created_at", { ascending: true });
      if (salesRes.error) throw salesRes.error;
      const sales = (salesRes.data ?? []) as SaleRow[];
      const saleIds = sales.map((s) => s.id);

      const [productsRes, stocksRes] = await Promise.all([
        supabase.from("products").select("id,name,category,min_stock,max_stock,reorder_qty").eq("store_id", storeId!).eq("active", true),
        supabase.from("product_stocks").select("product_id,quantity,min_quantity").eq("store_id", storeId!),
      ]);
      if (productsRes.error) throw productsRes.error;
      if (stocksRes.error) throw stocksRes.error;

      if (saleIds.length === 0) {
        return buildReport([], [], [], productsRes.data ?? [], stocksRes.data ?? [], category);
      }

      const [itemsRes, paymentsRes] = await Promise.all([
        supabase.from("sale_items").select("sale_id,product_id,product_name,quantity,total").eq("store_id", storeId!).in("sale_id", saleIds),
        supabase.from("sale_payments").select("method,amount,sale_id,installments").eq("store_id", storeId!).in("sale_id", saleIds),
      ]);
      if (itemsRes.error) throw itemsRes.error;
      if (paymentsRes.error) throw paymentsRes.error;
      return buildReport(sales, itemsRes.data ?? [], paymentsRes.data ?? [], productsRes.data ?? [], stocksRes.data ?? [], category);
    },
  });

  if (!store) return <StoreRequired />;

  const data = report.data ?? emptyReport();

  return (
    <div>
      <PageHeader
        title="Relatórios"
        description={`Vendas, rankings, gráficos e reposição orientada por dados · ${store.fantasy_name || store.name}`}
        actions={
          <Button size="sm" variant="outline" className="gap-2" onClick={() => report.refetch()}>
            <BarChart3 className="size-4" /> Atualizar
          </Button>
        }
      />
      <div className="p-6 space-y-4">
        <section className="border border-border rounded-md bg-card p-4 grid gap-3 md:grid-cols-5">
          <div>
            <Label>Período</Label>
            <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Hoje</SelectItem>
                <SelectItem value="month">Mês atual</SelectItem>
                <SelectItem value="custom">Personalizado</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>De</Label>
            <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPeriod("custom"); }} />
          </div>
          <div>
            <Label>Até</Label>
            <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPeriod("custom"); }} />
          </div>
          <div className="md:col-span-2">
            <Label>Categoria</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todas as categorias</SelectItem>
                {data.categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </section>

        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi label="Vendas no dia" value={brl(data.todayTotal)} icon={CalendarDays} tone="primary" />
          <Kpi label="Vendas no mês" value={brl(data.monthTotal)} icon={TrendingUp} tone="primary" />
          <Kpi label="Vendas no período" value={brl(data.total)} icon={ShoppingCart} />
          <Kpi label="Ticket médio" value={brl(data.avgTicket)} icon={BarChart3} />
        </section>

        <section className="grid gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2 border border-border rounded-md bg-card p-4">
            <h2 className="text-sm font-semibold">Evolução de vendas</h2>
            <div className="h-72 mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.daily} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke="var(--color-muted-foreground)" fontSize={11} />
                  <YAxis stroke="var(--color-muted-foreground)" fontSize={11} tickFormatter={(v) => compactBrl(Number(v))} />
                  <Tooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", color: "var(--color-foreground)" }} formatter={(v) => brl(Number(v))} />
                  <Line type="monotone" dataKey="total" stroke="var(--color-primary)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="border border-border rounded-md bg-card p-4">
            <h2 className="text-sm font-semibold">Pagamentos</h2>
            <div className="h-72 mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.payments} layout="vertical" margin={{ top: 10, right: 20, bottom: 0, left: 20 }}>
                  <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                  <XAxis type="number" stroke="var(--color-muted-foreground)" fontSize={11} tickFormatter={(v) => compactBrl(Number(v))} />
                  <YAxis type="category" dataKey="method" stroke="var(--color-muted-foreground)" fontSize={11} />
                  <Tooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", color: "var(--color-foreground)" }} formatter={(v) => brl(Number(v))} />
                  <Bar dataKey="amount" fill="var(--color-accent)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-3">
          <Ranking title="Mais vendidos" rows={data.topSelling} icon={TrendingUp} empty="Sem vendas no período." />
          <Ranking title="Menos vendidos" rows={data.lowSelling} icon={TrendingDown} empty="Sem itens suficientes para ranking." />
          <div className="border border-primary/30 rounded-md bg-primary/5 p-4">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-primary" />
              <h2 className="text-sm font-semibold">Indicações de IA</h2>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">Baseadas somente nos relatórios de venda e estoque desta loja.</p>
            <div className="mt-4 space-y-3">
              {data.recommendations.length === 0 && <p className="text-sm text-muted-foreground">Sem recomendação crítica de abastecimento agora.</p>}
              {data.recommendations.map((r) => (
                <div key={r.productId} className="border border-border rounded-md bg-card/70 p-3">
                  <div className="flex items-start gap-2">
                    <PackagePlus className="size-4 text-primary mt-0.5" />
                    <div className="flex-1">
                      <div className="text-sm font-medium">{r.name}</div>
                      <div className="text-xs text-muted-foreground mt-1">{r.reason}</div>
                      <div className="mt-2 flex items-center gap-2">
                        <Badge variant="outline" className="text-primary border-primary/40">Repor {r.suggestedQty.toFixed(0)} un.</Badge>
                        <Badge variant="outline">{r.daysOfStock === null ? "sem cobertura" : `${r.daysOfStock.toFixed(1)} dias`}</Badge>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function buildReport(sales: SaleRow[], items: ItemRow[], payments: PaymentRow[], products: ProductRow[], stocks: StockRow[], category: string) {
  const productMap = new Map(products.map((p) => [p.id, p]));
  const stockMap = new Map(stocks.map((s) => [s.product_id, s]));
  const filteredItems = category === "__all__" ? items : items.filter((i) => (productMap.get(i.product_id)?.category || "Sem categoria") === category);
  const filteredSaleIds = new Set(filteredItems.map((i) => i.sale_id));
  const filteredSales = category === "__all__" ? sales : sales.filter((s) => filteredSaleIds.has(s.id));
  const filteredPayments = category === "__all__" ? payments : payments.filter((p) => filteredSaleIds.has(p.sale_id));
  const total = filteredSales.reduce((sum, s) => sum + Number(s.total || 0), 0);
  const now = new Date();
  const todayKey = dayKey(now);
  const monthKey = monthInput(now);
  const todayTotal = sales.filter((s) => dayKey(new Date(s.created_at)) === todayKey).reduce((sum, s) => sum + Number(s.total || 0), 0);
  const monthTotal = sales.filter((s) => monthInput(new Date(s.created_at)) === monthKey).reduce((sum, s) => sum + Number(s.total || 0), 0);
  const dailyMap = new Map<string, number>();
  for (const s of filteredSales) dailyMap.set(dayKey(new Date(s.created_at)), (dailyMap.get(dayKey(new Date(s.created_at))) || 0) + Number(s.total || 0));
  const daily = Array.from(dailyMap.entries()).map(([date, value]) => ({ label: date.slice(5).split("-").reverse().join("/"), total: value }));
  const paymentMap = new Map<string, number>();
  for (const p of filteredPayments) paymentMap.set(paymentLabel(p.method), (paymentMap.get(paymentLabel(p.method)) || 0) + Number(p.amount || 0));
  const paymentsChart = Array.from(paymentMap.entries()).map(([method, amount]) => ({ method, amount })).sort((a, b) => b.amount - a.amount);
  const itemMap = new Map<string, { productId: string; name: string; category: string; quantity: number; total: number }>();
  for (const item of filteredItems) {
    const prod = productMap.get(item.product_id);
    const current = itemMap.get(item.product_id) ?? { productId: item.product_id, name: item.product_name, category: prod?.category || "Sem categoria", quantity: 0, total: 0 };
    current.quantity += Number(item.quantity || 0);
    current.total += Number(item.total || 0);
    itemMap.set(item.product_id, current);
  }
  const ranking = Array.from(itemMap.values()).sort((a, b) => b.quantity - a.quantity);
  const recommendations = ranking.map((r) => {
    const stock = stockMap.get(r.productId);
    const prod = productMap.get(r.productId);
    const currentStock = Number(stock?.quantity ?? 0);
    const avgDaily = r.quantity / Math.max(1, 30);
    const daysOfStock = avgDaily > 0 ? currentStock / avgDaily : null;
    const target = Number(prod?.reorder_qty ?? prod?.max_stock ?? Math.max(Number(prod?.min_stock ?? 0) * 2, r.quantity));
    const suggestedQty = Math.max(0, Math.ceil(target - currentStock));
    const low = currentStock <= Number(prod?.min_stock ?? stock?.min_quantity ?? 0);
    return {
      productId: r.productId,
      name: r.name,
      suggestedQty,
      daysOfStock,
      score: (low ? 1000 : 0) + r.quantity + Math.max(0, 15 - (daysOfStock ?? 15)) * 10,
      reason: low
        ? `Estoque abaixo do mínimo e ${r.quantity.toFixed(1)} un. vendidas no período.`
        : `Alta saída no período (${r.quantity.toFixed(1)} un.) e cobertura estimada baixa.`,
    };
  }).filter((r) => r.suggestedQty > 0).sort((a, b) => b.score - a.score).slice(0, 5);
  return {
    total,
    todayTotal,
    monthTotal,
    avgTicket: filteredSales.length ? total / filteredSales.length : 0,
    daily,
    payments: paymentsChart,
    topSelling: ranking.slice(0, 8),
    lowSelling: ranking.slice().reverse().filter((r) => r.quantity > 0).slice(0, 8),
    categories: Array.from(new Set(products.map((p) => p.category || "Sem categoria"))).sort(),
    recommendations,
  };
}

function emptyReport(): ReturnType<typeof buildReport> {
  return buildReport([], [], [], [], [], "__all__");
}

function Ranking({ title, rows, icon: Icon, empty }: { title: string; rows: Array<{ productId: string; name: string; category: string; quantity: number; total: number }>; icon: React.ComponentType<{ className?: string }>; empty: string }) {
  return (
    <div className="border border-border rounded-md bg-card p-4">
      <div className="flex items-center gap-2 mb-3"><Icon className="size-4 text-primary" /><h2 className="text-sm font-semibold">{title}</h2></div>
      <Table>
        <TableHeader><TableRow><TableHead>Produto</TableHead><TableHead className="text-right">Qtd</TableHead><TableHead className="text-right">Total</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.length === 0 && <TableRow><TableCell colSpan={3} className="text-center py-8 text-sm text-muted-foreground">{empty}</TableCell></TableRow>}
          {rows.map((r) => <TableRow key={r.productId}><TableCell><div className="font-medium text-sm">{r.name}</div><div className="text-[10px] text-muted-foreground">{r.category}</div></TableCell><TableCell className="text-right font-mono">{r.quantity.toFixed(2)}</TableCell><TableCell className="text-right font-mono">{brl(r.total)}</TableCell></TableRow>)}
        </TableBody>
      </Table>
    </div>
  );
}

function Kpi({ label, value, icon: Icon, tone = "default" }: { label: string; value: string; icon: React.ComponentType<{ className?: string }>; tone?: "default" | "primary" | "warning" }) {
  const cls = tone === "primary" ? "text-primary" : tone === "warning" ? "text-warning" : "text-foreground";
  return <div className="border border-border rounded-md bg-card p-4"><div className="flex items-center justify-between text-muted-foreground"><span className="text-[10px] uppercase font-mono">{label}</span><Icon className={`size-4 ${cls}`} /></div><div className={`mt-2 text-xl font-semibold font-mono ${cls}`}>{value}</div></div>;
}

function buildRange(period: Period, from: string, to: string) {
  const start = period === "today" ? new Date() : period === "month" ? new Date(new Date().getFullYear(), new Date().getMonth(), 1) : new Date(`${from}T00:00:00`);
  const end = period === "today" || period === "month" ? new Date() : new Date(`${to}T23:59:59`);
  if (period === "today") start.setHours(0, 0, 0, 0);
  return { fromIso: start.toISOString(), toIso: end.toISOString() };
}

function brl(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function compactBrl(v: number) { return v >= 1000 ? `R$ ${(v / 1000).toFixed(1)}k` : `R$ ${v.toFixed(0)}`; }
function dayKey(d: Date) { return d.toISOString().slice(0, 10); }
function todayInput() { return dayKey(new Date()); }
function startOfMonthInput() { const d = new Date(); return dayKey(new Date(d.getFullYear(), d.getMonth(), 1)); }
function monthInput(d: Date) { return d.toISOString().slice(0, 7); }
function paymentLabel(method: string) {
  const labels: Record<string, string> = { dinheiro: "Dinheiro", pix: "PIX", debito: "Débito", credito: "Crédito", credito_avista: "Crédito à vista", credito_parcelado: "Crédito parcelado" };
  return labels[method] ?? method;
}