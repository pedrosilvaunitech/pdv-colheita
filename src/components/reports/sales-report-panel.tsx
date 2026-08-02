/**
 * Painel "Relatório de vendas" — visões por dia/semana/mês/trimestre/ano e por
 * caixa, com visualização do PDF dentro do sistema e exportação para Excel.
 *
 * Decisões de UX que valem registro:
 *  - o PDF é gerado no navegador e exibido num `<iframe>` a partir de um blob
 *    URL. Nada sai do dispositivo, funciona offline e o lojista confere antes de
 *    baixar — era o pedido central: "ver o relatório dentro do sistema";
 *  - os atalhos de período (hoje, 7 dias, mês, ano…) evitam digitar datas no
 *    balcão, mas as datas continuam editáveis;
 *  - o blob URL é revogado ao fechar/regenerar para não vazar memória.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BarChart3,
  CalendarRange,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Loader2,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  GRANULARITY_LABEL,
  brl,
  dateBR,
  fetchSalesReport,
  pct,
  qty,
  reportFileName,
  type Granularity,
  type SalesReport,
} from "@/lib/sales-report";
import { buildSalesReportPdf } from "@/lib/sales-report-pdf";
import { buildSalesReportXlsx } from "@/lib/sales-report-xlsx";

export interface SalesReportPanelProps {
  storeId: string;
  store: { name: string; fantasy_name?: string | null; cnpj?: string | null } | null;
}

type Shortcut = "today" | "yesterday" | "last7" | "month" | "lastMonth" | "year" | "custom";

const SHORTCUT_LABEL: Record<Exclude<Shortcut, "custom">, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  last7: "Últimos 7 dias",
  month: "Mês atual",
  lastMonth: "Mês passado",
  year: "Ano atual",
};

function toInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseInput(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Datas de cada atalho, sempre em horário local. */
function shortcutRange(shortcut: Exclude<Shortcut, "custom">): { from: string; to: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (shortcut) {
    case "today":
      return { from: toInput(today), to: toInput(today) };
    case "yesterday": {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      return { from: toInput(y), to: toInput(y) };
    }
    case "last7": {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      return { from: toInput(start), to: toInput(today) };
    }
    case "month":
      return { from: toInput(new Date(today.getFullYear(), today.getMonth(), 1)), to: toInput(today) };
    case "lastMonth": {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: toInput(start), to: toInput(end) };
    }
    case "year":
    default:
      return { from: toInput(new Date(today.getFullYear(), 0, 1)), to: toInput(today) };
  }
}

/** Sugere a granularidade que faz sentido para o tamanho da janela escolhida. */
function suggestGranularity(from: Date, to: Date): Granularity {
  const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  if (days <= 62) return "day";
  if (days <= 180) return "week";
  if (days <= 730) return "month";
  return "quarter";
}

export function SalesReportPanel({ storeId, store }: SalesReportPanelProps) {
  const initial = shortcutRange("month");
  const [shortcut, setShortcut] = useState<Shortcut>("month");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [registerKey, setRegisterKey] = useState<string>("__all__");

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState<"pdf" | "xlsx" | "preview" | null>(null);
  const urlRef = useRef<string | null>(null);

  // Um blob URL vive até ser revogado; guardamos a referência para limpar.
  const releasePreview = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setPreviewUrl(null);
  }, []);

  useEffect(() => releasePreview, [releasePreview]);

  function applyShortcut(next: Exclude<Shortcut, "custom">) {
    const range = shortcutRange(next);
    setShortcut(next);
    setFrom(range.from);
    setTo(range.to);
    setGranularity(suggestGranularity(parseInput(range.from), parseInput(range.to)));
  }

  const query = useQuery({
    queryKey: ["sales-report", storeId, from, to, granularity, registerKey],
    enabled: Boolean(storeId),
    queryFn: () =>
      fetchSalesReport({
        storeId,
        from: parseInput(from),
        to: parseInput(to),
        granularity,
        registerKey: registerKey === "__all__" ? null : registerKey,
      }),
  });

  const report = query.data ?? null;

  // Lista de caixas para o filtro: vem do próprio relatório sem filtro aplicado.
  const registerOptions = useMemo(() => {
    const names = report?.registers.map((r) => r.name) ?? [];
    if (registerKey !== "__all__" && !names.includes(registerKey)) names.push(registerKey);
    return names;
  }, [report, registerKey]);

  const storeInfo = {
    name: store?.name ?? null,
    fantasyName: store?.fantasy_name ?? null,
    cnpj: store?.cnpj ?? null,
  };

  function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revogar imediatamente cancelaria o download em alguns navegadores.
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function handlePreview() {
    if (!report) return;
    setBusy("preview");
    try {
      releasePreview();
      const blob = buildSalesReportPdf(report, storeInfo);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setPreviewUrl(url);
      setPreviewOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível gerar a visualização.");
    } finally {
      setBusy(null);
    }
  }

  async function handlePdf() {
    if (!report) return;
    setBusy("pdf");
    try {
      download(buildSalesReportPdf(report, storeInfo), reportFileName(report, "pdf"));
      toast.success("PDF gerado.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao gerar o PDF.");
    } finally {
      setBusy(null);
    }
  }

  async function handleXlsx() {
    if (!report) return;
    setBusy("xlsx");
    try {
      const blob = await buildSalesReportXlsx(report, storeInfo);
      download(blob, reportFileName(report, "xlsx"));
      toast.success("Planilha gerada com fórmulas e PROCV no Resumo.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao gerar a planilha.");
    } finally {
      setBusy(null);
    }
  }

  const totals = report?.totals;
  const empty = !query.isLoading && report && report.totals.sales === 0;

  return (
    <section className="border border-border rounded-md bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="size-4" /> Relatório de vendas
          </h2>
          <p className="text-xs text-muted-foreground">
            Por dia, semana, mês, trimestre, ano e por caixa — com visualização em PDF e planilha Excel.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="gap-2" onClick={() => query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Atualizar
          </Button>
          <Button size="sm" className="gap-2" onClick={handlePreview} disabled={!report || busy !== null}>
            {busy === "preview" ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
            Visualizar PDF
          </Button>
          <Button size="sm" variant="secondary" className="gap-2" onClick={handlePdf} disabled={!report || busy !== null}>
            {busy === "pdf" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Baixar PDF
          </Button>
          <Button size="sm" variant="secondary" className="gap-2" onClick={handleXlsx} disabled={!report || busy !== null}>
            {busy === "xlsx" ? <Loader2 className="size-4 animate-spin" /> : <FileSpreadsheet className="size-4" />}
            Baixar Excel
          </Button>
        </div>
      </header>

      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SHORTCUT_LABEL) as Exclude<Shortcut, "custom">[]).map((key) => (
            <Button
              key={key}
              size="sm"
              variant={shortcut === key ? "default" : "outline"}
              onClick={() => applyShortcut(key)}
            >
              {SHORTCUT_LABEL[key]}
            </Button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <Label htmlFor="report-from">De</Label>
            <Input
              id="report-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setShortcut("custom");
              }}
            />
          </div>
          <div>
            <Label htmlFor="report-to">Até</Label>
            <Input
              id="report-to"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setShortcut("custom");
              }}
            />
          </div>
          <div>
            <Label>Agrupar</Label>
            <Select value={granularity} onValueChange={(v) => setGranularity(v as Granularity)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(GRANULARITY_LABEL) as Granularity[]).map((g) => (
                  <SelectItem key={g} value={g}>
                    {GRANULARITY_LABEL[g]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Caixa</Label>
            <Select value={registerKey} onValueChange={setRegisterKey}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos os caixas</SelectItem>
                {registerOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {query.isError ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Não foi possível carregar o relatório:{" "}
            {query.error instanceof Error ? query.error.message : "erro desconhecido"}
          </p>
        ) : null}

        {query.isLoading ? (
          <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Consolidando as vendas do período…
          </p>
        ) : empty ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nenhuma venda finalizada entre {dateBR(parseInput(from))} e {dateBR(parseInput(to))}.
          </p>
        ) : report && totals ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Faturamento" value={brl(totals.total)} hint={`${totals.sales} venda(s)`} />
              <Kpi label="Ticket médio" value={brl(totals.avgTicket)} hint={`${qty(totals.avgItemsPerSale)} itens/venda`} />
              <Kpi label="Descontos" value={brl(totals.discount)} hint={totals.gross ? pct(totals.discount / totals.gross) : "—"} />
              <Kpi
                label="Melhor dia"
                value={totals.bestDay ? brl(totals.bestDay.total) : "—"}
                hint={totals.bestDay?.label ?? "sem vendas"}
              />
            </div>

            <Tabs defaultValue="period">
              <TabsList>
                <TabsTrigger value="period" className="gap-2">
                  <CalendarRange className="size-4" /> {GRANULARITY_LABEL[granularity]}
                </TabsTrigger>
                <TabsTrigger value="register" className="gap-2">
                  <Wallet className="size-4" /> Por caixa
                </TabsTrigger>
                <TabsTrigger value="mix" className="gap-2">
                  <BarChart3 className="size-4" /> Pagamentos e produtos
                </TabsTrigger>
              </TabsList>

              <TabsContent value="period" className="mt-3">
                <ReportTable
                  head={["Período", "Vendas", "Itens", "Descontos", "Ticket médio", "Total"]}
                  rows={report.periods.map((p) => [
                    p.detail,
                    String(p.sales),
                    qty(p.items),
                    brl(p.discount),
                    brl(p.avgTicket),
                    brl(p.total),
                  ])}
                  footer={[
                    "TOTAL",
                    String(totals.sales),
                    qty(totals.items),
                    brl(totals.discount),
                    brl(totals.avgTicket),
                    brl(totals.total),
                  ]}
                />
              </TabsContent>

              <TabsContent value="register" className="mt-3">
                <ReportTable
                  head={["Caixa", "Operador(es)", "Vendas", "Ticket médio", "Participação", "Total"]}
                  rows={report.registers.map((r) => [
                    r.name,
                    r.operators.join(", ") || "—",
                    String(r.sales),
                    brl(r.avgTicket),
                    pct(r.share),
                    brl(r.total),
                  ])}
                  footer={["TOTAL", "", String(totals.sales), brl(totals.avgTicket), "100,0%", brl(totals.total)]}
                />
              </TabsContent>

              <TabsContent value="mix" className="mt-3 grid gap-4 lg:grid-cols-2">
                <ReportTable
                  head={["Forma de pagamento", "Lançamentos", "Participação", "Total"]}
                  rows={report.payments.map((p) => [p.label, String(p.count), pct(p.share), brl(p.total)])}
                />
                <ReportTable
                  head={["Produto", "Qtd.", "Participação", "Total"]}
                  rows={report.products.slice(0, 15).map((p) => [
                    p.name,
                    qty(p.quantity),
                    pct(p.share),
                    brl(p.total),
                  ])}
                />
              </TabsContent>
            </Tabs>
          </>
        ) : null}
      </div>

      <Dialog
        open={previewOpen}
        onOpenChange={(open) => {
          setPreviewOpen(open);
          if (!open) releasePreview();
        }}
      >
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="size-4" /> Pré-visualização do relatório
            </DialogTitle>
            <DialogDescription>
              {report
                ? `${GRANULARITY_LABEL[report.granularity]} · ${dateBR(report.from)} a ${dateBR(report.to)}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {previewUrl ? (
            <iframe
              title="Pré-visualização do relatório de vendas"
              src={previewUrl}
              className="h-[70vh] w-full rounded-md border border-border bg-muted"
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">Gerando a pré-visualização…</p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" className="gap-2" onClick={handlePdf} disabled={!report}>
              <Download className="size-4" /> Baixar PDF
            </Button>
            <Button variant="secondary" className="gap-2" onClick={handleXlsx} disabled={!report}>
              <FileSpreadsheet className="size-4" /> Baixar Excel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ReportTable({
  head,
  rows,
  footer,
}: {
  head: string[];
  rows: string[][];
  footer?: string[];
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {head.map((h, i) => (
              <TableHead key={h} className={cn(i > 0 && "text-right")}>
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={head.length} className="text-center text-sm text-muted-foreground">
                Sem dados no período.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, index) => (
              <TableRow key={`${row[0]}-${index}`}>
                {row.map((cell, i) => (
                  <TableCell key={i} className={cn(i > 0 && "text-right", i === 0 && "font-medium")}>
                    {i === 0 ? cell : <span className="tabular-nums">{cell}</span>}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
          {footer ? (
            <TableRow className="bg-muted/60 font-semibold">
              {footer.map((cell, i) => (
                <TableCell key={i} className={cn(i > 0 && "text-right tabular-nums")}>
                  {i === 0 ? <Badge variant="outline">{cell}</Badge> : cell}
                </TableCell>
              ))}
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
