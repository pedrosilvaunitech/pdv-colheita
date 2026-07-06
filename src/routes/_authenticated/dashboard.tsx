import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { DollarSign, ShoppingCart, Package, AlertTriangle, TrendingUp, FileCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

interface Kpis {
  todaySales: number;
  todayCount: number;
  avgTicket: number;
  productCount: number;
  lowStock: number;
  invoicesToday: number;
  invoicesRejected: number;
}

function Dashboard() {
  const { store, storeId } = useCurrentStore();

  const { data: k } = useQuery({
    queryKey: ["dashboard", storeId],
    enabled: Boolean(storeId),
    queryFn: async (): Promise<Kpis> => {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const iso = today.toISOString();
      const [sales, products, stocks, invoices] = await Promise.all([
        supabase.from("sales").select("total,status,created_at").eq("store_id", storeId!).eq("status", "finalizada").gte("created_at", iso),
        supabase.from("products").select("id", { count: "exact", head: true }).eq("store_id", storeId!).eq("active", true),
        supabase.from("product_stocks").select("quantity,min_quantity").eq("store_id", storeId!),
        supabase.from("invoices").select("status,created_at").eq("store_id", storeId!).gte("created_at", iso),
      ]);
      const totals = (sales.data ?? []).reduce((s, r) => s + Number(r.total || 0), 0);
      const count = sales.data?.length ?? 0;
      const low = (stocks.data ?? []).filter((s) => Number(s.quantity) <= Number(s.min_quantity) && Number(s.min_quantity) > 0).length;
      const inv = invoices.data ?? [];
      return {
        todaySales: totals,
        todayCount: count,
        avgTicket: count ? totals / count : 0,
        productCount: products.count ?? 0,
        lowStock: low,
        invoicesToday: inv.filter((i) => i.status === "autorizada").length,
        invoicesRejected: inv.filter((i) => i.status === "rejeitada").length,
      };
    },
  });

  if (!store) return <StoreRequired />;

  return (
    <div>
      <PageHeader
        title="Dashboard operacional"
        description={`Visão consolidada da loja ${store.fantasy_name || store.name}`}
      />
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="Vendas hoje" value={brl(k?.todaySales ?? 0)} icon={DollarSign} tone="primary" />
          <Kpi label="Cupons hoje" value={String(k?.todayCount ?? 0)} icon={ShoppingCart} />
          <Kpi label="Ticket médio" value={brl(k?.avgTicket ?? 0)} icon={TrendingUp} />
          <Kpi label="Produtos ativos" value={String(k?.productCount ?? 0)} icon={Package} />
          <Kpi label="Estoque baixo" value={String(k?.lowStock ?? 0)} icon={AlertTriangle} tone={k?.lowStock ? "warning" : "muted"} />
          <Kpi label="NFC-e autorizadas" value={String(k?.invoicesToday ?? 0)} icon={FileCheck} tone="primary" />
          <Kpi label="NFC-e rejeitadas" value={String(k?.invoicesRejected ?? 0)} icon={AlertTriangle} tone={k?.invoicesRejected ? "destructive" : "muted"} />
        </div>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="border border-border rounded-md bg-card p-5">
            <h2 className="text-sm font-semibold mb-3">Acessos rápidos</h2>
            <div className="grid grid-cols-2 gap-2">
              <QuickLink to="/pdv" label="Abrir PDV" hint="F1 · vender" />
              <QuickLink to="/produtos" label="Cadastrar produto" hint="EAN + preço" />
              <QuickLink to="/estoque" label="Mover estoque" hint="entrada / saída" />
              <QuickLink to="/fiscal" label="Configurar fiscal" hint="passo a passo" />
            </div>
          </div>

          <div className="border border-border rounded-md bg-card p-5">
            <h2 className="text-sm font-semibold mb-3">Status fiscal</h2>
            <p className="text-xs text-muted-foreground mb-4">
              A emissão de nota fiscal exige CNPJ, IE, certificado digital A1 e homologação com a SEFAZ. Configure passo a passo no módulo <b>Nota Fiscal</b>.
            </p>
            <Link to="/fiscal" className="text-xs font-mono text-primary hover:underline">
              → Abrir checklist fiscal
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

function brl(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function Kpi({
  label, value, icon: Icon, tone = "default",
}: {
  label: string; value: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "primary" | "warning" | "destructive" | "muted";
}) {
  const toneClass = {
    default: "text-foreground",
    primary: "text-primary",
    warning: "text-warning",
    destructive: "text-destructive",
    muted: "text-muted-foreground",
  }[tone];
  return (
    <div className="border border-border rounded-md bg-card p-4">
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-[10px] uppercase tracking-wider font-mono">{label}</span>
        <Icon className={cn("size-4", toneClass)} />
      </div>
      <div className={cn("mt-2 text-xl font-semibold font-mono", toneClass)}>{value}</div>
    </div>
  );
}

function QuickLink({ to, label, hint }: { to: string; label: string; hint: string }) {
  return (
    <Link
      to={to}
      className="border border-border rounded-sm p-3 hover:border-primary hover:bg-primary/5 transition-colors"
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mt-1">{hint}</div>
    </Link>
  );
}
