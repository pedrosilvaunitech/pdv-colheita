import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired, EmptyState } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, TrendingDown, PackageX, PackageCheck, Search, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/reposicao")({
  component: ReposicaoPage,
});

type Row = {
  product_id: string;
  store_id: string;
  name: string;
  barcode: string | null;
  sku: string | null;
  unit: string;
  min_stock: number | null;
  max_stock: number | null;
  reorder_qty: number | null;
  lead_time_days: number | null;
  supplier_id: string | null;
  current_stock: number | null;
  sold_30d: number | null;
  avg_daily_sales: number | null;
  days_of_stock: number | null;
  status: string | null;
  suggested_qty: number | null;
};

const STATUS_META: Record<string, { label: string; className: string; icon: typeof AlertTriangle }> = {
  ruptura: { label: "Ruptura", className: "bg-destructive/15 text-destructive border-destructive/40", icon: PackageX },
  critico: { label: "Crítico", className: "bg-destructive/10 text-destructive border-destructive/30", icon: AlertTriangle },
  atencao: { label: "Atenção", className: "bg-warning/15 text-warning border-warning/40", icon: TrendingDown },
  ok:      { label: "OK",       className: "bg-primary/10 text-primary border-primary/30",       icon: PackageCheck },
};

function ReposicaoPage() {
  const { store, storeId } = useCurrentStore();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data: rows, isLoading } = useQuery({
    queryKey: ["reorder", storeId],
    enabled: Boolean(storeId),
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await supabase
        .from("v_reorder")
        .select("*")
        .eq("store_id", storeId!)
        .order("status", { ascending: true })
        .order("days_of_stock", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!search.trim()) return true;
      const s = search.toLowerCase();
      return (
        r.name.toLowerCase().includes(s) ||
        (r.barcode?.toLowerCase().includes(s) ?? false) ||
        (r.sku?.toLowerCase().includes(s) ?? false)
      );
    });
  }, [rows, search, statusFilter]);

  const counts = useMemo(() => {
    const c = { ruptura: 0, critico: 0, atencao: 0, ok: 0, suggested_total: 0 };
    for (const r of rows ?? []) {
      if (r.status && r.status in c) c[r.status as keyof typeof c] = (c[r.status as keyof typeof c] as number) + 1;
      if (r.status !== "ok" && (r.suggested_qty ?? 0) > 0) c.suggested_total += Number(r.suggested_qty);
    }
    return c;
  }, [rows]);

  const exportCsv = () => {
    const header = ["Produto", "EAN", "SKU", "Estoque", "Vendas 30d", "Média/dia", "Dias cobertura", "Status", "Sugestão compra"];
    const lines = filtered.map((r) => [
      r.name,
      r.barcode ?? "",
      r.sku ?? "",
      Number(r.current_stock ?? 0).toFixed(3),
      Number(r.sold_30d ?? 0).toFixed(3),
      Number(r.avg_daily_sales ?? 0).toFixed(3),
      r.days_of_stock == null ? "" : String(r.days_of_stock),
      r.status ?? "",
      Math.max(0, Math.ceil(Number(r.suggested_qty ?? 0))),
    ].join(";"));
    const blob = new Blob([header.join(";") + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `reposicao_${new Date().toISOString().slice(0,10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  if (!store) return <StoreRequired />;

  return (
    <div>
      <PageHeader
        title="Reposição de estoque"
        description="Previsão baseada na venda média dos últimos 30 dias e no tempo de reposição de cada produto."
        actions={
          <>
            <div className="relative">
              <Search className="size-4 absolute left-2 top-2.5 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar produto, EAN, SKU" className="pl-8 w-64" />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="ruptura">Ruptura</SelectItem>
                <SelectItem value="critico">Crítico</SelectItem>
                <SelectItem value="atencao">Atenção</SelectItem>
                <SelectItem value="ok">OK</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={exportCsv} className="gap-2"><Download className="size-4" /> CSV</Button>
          </>
        }
      />

      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Ruptura" value={counts.ruptura} tone="destructive" />
          <KpiCard label="Crítico" value={counts.critico} tone="destructive" />
          <KpiCard label="Atenção" value={counts.atencao} tone="warning" />
          <KpiCard label="Sugestão total (unid.)" value={Math.ceil(counts.suggested_total)} tone="primary" />
        </div>

        <div className="border border-border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Status</TableHead>
                <TableHead>Produto</TableHead>
                <TableHead className="w-28 font-mono text-xs">EAN</TableHead>
                <TableHead className="w-24 text-right">Estoque</TableHead>
                <TableHead className="w-24 text-right">Mín.</TableHead>
                <TableHead className="w-24 text-right">Vendas 30d</TableHead>
                <TableHead className="w-24 text-right">Média/dia</TableHead>
                <TableHead className="w-24 text-right">Cobertura</TableHead>
                <TableHead className="w-28 text-right">Sugestão</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={9} className="text-center py-10 text-muted-foreground text-sm">Calculando previsão…</TableCell></TableRow>
              )}
              {!isLoading && filtered.length === 0 && (
                <TableRow><TableCell colSpan={9} className="p-0">
                  <EmptyState title="Nada a repor" description="Todos os produtos ativos estão dentro do estoque desejado." />
                </TableCell></TableRow>
              )}
              {filtered.map((r) => {
                const meta = STATUS_META[r.status ?? "ok"] ?? STATUS_META.ok;
                const Icon = meta.icon;
                const suggest = Math.max(0, Math.ceil(Number(r.suggested_qty ?? 0)));
                return (
                  <TableRow key={r.product_id}>
                    <TableCell>
                      <Badge variant="outline" className={`gap-1 ${meta.className}`}>
                        <Icon className="size-3" />{meta.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="font-mono text-xs">{r.barcode || "—"}</TableCell>
                    <TableCell className="text-right font-mono">{Number(r.current_stock ?? 0).toFixed(3)}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">{Number(r.min_stock ?? 0).toFixed(0)}</TableCell>
                    <TableCell className="text-right font-mono">{Number(r.sold_30d ?? 0).toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono">{Number(r.avg_daily_sales ?? 0).toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono">{r.days_of_stock == null ? "—" : `${r.days_of_stock}d`}</TableCell>
                    <TableCell className="text-right font-mono font-semibold">{suggest > 0 ? `${suggest} ${r.unit}` : "—"}</TableCell>
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

function KpiCard({ label, value, tone }: { label: string; value: number; tone: "destructive" | "warning" | "primary" }) {
  const cls =
    tone === "destructive" ? "border-destructive/30 text-destructive"
    : tone === "warning" ? "border-warning/30 text-warning"
    : "border-primary/30 text-primary";
  return (
    <div className={`border rounded-md bg-card px-4 py-3 ${cls}`}>
      <div className="text-[10px] font-mono uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div>
    </div>
  );
}
