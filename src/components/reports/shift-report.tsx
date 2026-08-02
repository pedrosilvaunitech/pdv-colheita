import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, Archive, ArrowDownCircle, ArrowUpCircle, Printer, Download, FileText } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  buildShiftReportPdf,
  shiftReportFileName,
  type ShiftPdfRegister,
} from "@/lib/shift-report-pdf";

export interface ShiftReportProps {
  storeId: string;
}


interface Register {
  id: string;
  terminal: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
  opening_amount: number;
  closing_amount: number | null;
  expected_amount: number | null;
  difference: number | null;
}

const DRAWER_REASON_LABEL: Record<string, string> = {
  manual: "Abertura manual",
  venda: "Venda",
  sangria: "Sangria",
  suprimento: "Suprimento",
  troca: "Troca / devolução",
  teste: "Teste",
  cancelamento: "Cancelamento",
};

/**
 * Relatório por turno (fechamento de caixa): consolida vendas, formas de
 * pagamento, sangrias/suprimentos e todas as aberturas de gaveta ocorridas
 * entre a abertura e o fechamento do caixa selecionado.
 */
export function ShiftReport({ storeId }: ShiftReportProps) {
  const [registerId, setRegisterId] = useState<string>("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // O blob URL vive até ser revogado; guardamos para limpar e não vazar memória.
  const previewRef = useRef<string | null>(null);

  // Dados do emitente para o cabeçalho do documento impresso.
  const store = useQuery({
    queryKey: ["shift-report-store", storeId],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stores")
        .select("name,fantasy_name,cnpj,city,state")
        .eq("id", storeId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });



  const registers = useQuery({
    queryKey: ["shift-registers", storeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cash_registers")
        .select("id,terminal,status,opened_at,closed_at,opening_amount,closing_amount,expected_amount,difference")
        .eq("store_id", storeId)
        .order("opened_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data ?? []) as Register[];
    },
  });

  const selected = useMemo<Register | null>(() => {
    const list = registers.data ?? [];
    if (list.length === 0) return null;
    return list.find((r) => r.id === registerId) ?? list[0];
  }, [registers.data, registerId]);

  const detail = useQuery({
    queryKey: ["shift-detail", selected?.id],
    enabled: !!selected,
    queryFn: async () => {
      const reg = selected!;
      const fromIso = reg.opened_at;
      const toIso = reg.closed_at ?? new Date().toISOString();

      const [salesRes, movRes, drawerRes] = await Promise.all([
        supabase
          .from("sales")
          .select("id,total,status,created_at")
          .eq("store_id", storeId)
          .eq("cash_register_id", reg.id),
        supabase
          .from("cash_movements")
          .select("id,type,amount,reason,created_at")
          .eq("cash_register_id", reg.id)
          .order("created_at", { ascending: true }),
        supabase
          .from("drawer_events")
          .select("id,reason,automatic,channel,success,created_at,terminal_id")
          .eq("store_id", storeId)
          .gte("created_at", fromIso)
          .lte("created_at", toIso)
          .order("created_at", { ascending: false })
          .limit(200),
      ]);
      if (salesRes.error) throw salesRes.error;
      if (movRes.error) throw movRes.error;
      if (drawerRes.error) throw drawerRes.error;

      const sales = (salesRes.data ?? []).filter((s) => s.status === "finalizada");
      const saleIds = sales.map((s) => s.id);
      let payments: { method: string; amount: number }[] = [];
      if (saleIds.length > 0) {
        const payRes = await supabase
          .from("sale_payments")
          .select("method,amount")
          .eq("store_id", storeId)
          .in("sale_id", saleIds);
        if (payRes.error) throw payRes.error;
        payments = payRes.data ?? [];
      }

      const byMethod = new Map<string, { amount: number; count: number }>();
      for (const p of payments) {
        const cur = byMethod.get(p.method) ?? { amount: 0, count: 0 };
        cur.amount += Number(p.amount);
        cur.count += 1;
        byMethod.set(p.method, cur);
      }

      const movements = movRes.data ?? [];
      const sangrias = movements.filter((m) => m.type === "sangria").reduce((s, m) => s + Number(m.amount), 0);
      const suprimentos = movements.filter((m) => m.type !== "sangria").reduce((s, m) => s + Number(m.amount), 0);
      const cash = byMethod.get("dinheiro")?.amount ?? 0;

      const drawer = drawerRes.data ?? [];
      const drawerByReason = new Map<string, number>();
      for (const d of drawer) drawerByReason.set(d.reason, (drawerByReason.get(d.reason) ?? 0) + 1);

      return {
        salesCount: sales.length,
        salesTotal: sales.reduce((s, x) => s + Number(x.total), 0),
        methods: Array.from(byMethod.entries())
          .map(([method, v]) => ({ method, ...v }))
          .sort((a, b) => b.amount - a.amount),
        sangrias,
        suprimentos,
        expectedCash: Number(reg.opening_amount) + cash + suprimentos - sangrias,
        drawer,
        drawerByReason: Array.from(drawerByReason.entries()).sort((a, b) => b[1] - a[1]),
        drawerFailures: drawer.filter((d) => !d.success).length,
      };
    },
  });

  const d = detail.data;
  const canExport = !!selected && !!d;

  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  function releasePreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreviewUrl(null);
  }

  /**
   * Monta o PDF do turno. Trocamos o `window.print()` por um documento próprio
   * porque o Ctrl+P levava a interface inteira (menu, tema escuro, tabelas com
   * scroll cortado) para o papel.
   */
  function buildPdf(): Blob | null {
    if (!selected || !d) return null;
    const register: ShiftPdfRegister = {
      terminal: selected.terminal,
      status: selected.status,
      openedAt: selected.opened_at,
      closedAt: selected.closed_at,
      openingAmount: Number(selected.opening_amount),
      closingAmount: selected.closing_amount == null ? null : Number(selected.closing_amount),
      expectedAmount: selected.expected_amount == null ? null : Number(selected.expected_amount),
      difference: selected.difference == null ? null : Number(selected.difference),
    };
    return buildShiftReportPdf({
      register,
      detail: d,
      reasonLabel: DRAWER_REASON_LABEL,
      store: {
        name: store.data?.name ?? null,
        fantasyName: store.data?.fantasy_name ?? null,
        cnpj: store.data?.cnpj ?? null,
        city: store.data?.city ?? null,
        state: store.data?.state ?? null,
      },
    });
  }

  function handlePreview() {
    try {
      const blob = buildPdf();
      if (!blob) return;
      releasePreview();
      const url = URL.createObjectURL(blob);
      previewRef.current = url;
      setPreviewUrl(url);
      setPreviewOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível gerar o relatório do turno.");
    }
  }

  function handleDownload() {
    try {
      const blob = buildPdf();
      if (!blob || !selected) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = shiftReportFileName({
        terminal: selected.terminal,
        status: selected.status,
        openedAt: selected.opened_at,
        closedAt: selected.closed_at,
        openingAmount: Number(selected.opening_amount),
        closingAmount: null,
        expectedAmount: null,
        difference: null,
      });
      a.click();
      // Revogar imediatamente cancelaria o download em alguns navegadores.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível baixar o relatório do turno.");
    }
  }



  return (
    <section className="border border-border rounded-md bg-card p-4 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Clock className="size-4" /> Relatório por turno
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Fechamento do caixa com formas de pagamento, sangrias e auditoria da gaveta.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-72">
            <Label>Turno (caixa)</Label>
            <Select value={selected?.id ?? ""} onValueChange={setRegisterId}>
              <SelectTrigger><SelectValue placeholder="Selecione um turno" /></SelectTrigger>
              <SelectContent>
                {(registers.data ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {fmtDateTime(r.opened_at)} · {r.terminal} {r.status === "aberto" ? "· ABERTO" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" variant="outline" className="gap-2" onClick={() => window.print()} disabled={!selected}>
            <Printer className="size-4" /> Imprimir
          </Button>
        </div>
      </div>

      {!selected && (
        <p className="text-sm text-muted-foreground py-6 text-center">Nenhum turno de caixa registrado nesta loja.</p>
      )}

      {selected && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="Vendas do turno" value={brl(d?.salesTotal ?? 0)} sub={`${d?.salesCount ?? 0} venda(s)`} />
            <Kpi label="Abertura" value={brl(Number(selected.opening_amount))} sub={fmtDateTime(selected.opened_at)} />
            <Kpi
              label="Dinheiro esperado"
              value={brl(d?.expectedCash ?? Number(selected.opening_amount))}
              sub={`sangria ${brl(d?.sangrias ?? 0)} · suprimento ${brl(d?.suprimentos ?? 0)}`}
            />
            <Kpi
              label={selected.closed_at ? "Diferença no fechamento" : "Turno em andamento"}
              value={selected.closed_at ? brl(Number(selected.difference ?? 0)) : "—"}
              sub={selected.closed_at ? `fechado ${fmtDateTime(selected.closed_at)} · contado ${brl(Number(selected.closing_amount ?? 0))}` : "caixa aberto"}
              tone={selected.closed_at && Number(selected.difference ?? 0) !== 0 ? "warning" : "default"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="border border-border rounded-md p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Formas de pagamento
              </h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Forma</TableHead>
                    <TableHead className="text-right">Recebimentos</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(d?.methods.length ?? 0) === 0 && (
                    <TableRow><TableCell colSpan={3} className="text-center py-6 text-sm text-muted-foreground">Sem recebimentos neste turno.</TableCell></TableRow>
                  )}
                  {d?.methods.map((m) => (
                    <TableRow key={m.method}>
                      <TableCell className="capitalize">{m.method}</TableCell>
                      <TableCell className="text-right font-mono">{m.count}</TableCell>
                      <TableCell className="text-right font-mono font-semibold">{brl(m.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="flex items-center gap-2 border border-border rounded p-2">
                  <ArrowDownCircle className="size-4 text-destructive" />
                  <span className="text-muted-foreground">Sangrias</span>
                  <span className="ml-auto font-mono font-semibold">{brl(d?.sangrias ?? 0)}</span>
                </div>
                <div className="flex items-center gap-2 border border-border rounded p-2">
                  <ArrowUpCircle className="size-4 text-primary" />
                  <span className="text-muted-foreground">Suprimentos</span>
                  <span className="ml-auto font-mono font-semibold">{brl(d?.suprimentos ?? 0)}</span>
                </div>
              </div>
            </div>

            <div className="border border-border rounded-md p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
                <Archive className="size-3.5" /> Aberturas de gaveta
                {(d?.drawerFailures ?? 0) > 0 && (
                  <Badge variant="outline" className="border-destructive/40 text-destructive">
                    {d?.drawerFailures} falha(s)
                  </Badge>
                )}
              </h3>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {(d?.drawerByReason ?? []).map(([reason, count]) => (
                  <Badge key={reason} variant="outline" className="font-mono text-[10px]">
                    {DRAWER_REASON_LABEL[reason] ?? reason}: {count}
                  </Badge>
                ))}
                {(d?.drawer.length ?? 0) === 0 && (
                  <span className="text-sm text-muted-foreground">Nenhuma abertura registrada no período do turno.</span>
                )}
              </div>
              <div className="max-h-64 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Hora</TableHead>
                      <TableHead>Motivo</TableHead>
                      <TableHead>Canal</TableHead>
                      <TableHead className="text-right">Resultado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(d?.drawer ?? []).map((ev) => (
                      <TableRow key={ev.id}>
                        <TableCell className="font-mono text-xs">{fmtTime(ev.created_at)}</TableCell>
                        <TableCell className="text-xs">
                          {DRAWER_REASON_LABEL[ev.reason] ?? ev.reason}
                          {ev.automatic && <span className="ml-1 text-[10px] font-mono text-muted-foreground">auto</span>}
                        </TableCell>
                        <TableCell className="font-mono text-xs uppercase">{ev.channel ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          <Badge
                            variant="outline"
                            className={ev.success ? "border-primary/40 text-primary" : "border-destructive/40 text-destructive"}
                          >
                            {ev.success ? "ok" : "falha"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Kpi({ label, value, sub, tone = "default" }: { label: string; value: string; sub?: string; tone?: "default" | "warning" }) {
  return (
    <div className={`border rounded-md p-3 ${tone === "warning" ? "border-warning/50 bg-warning/5" : "border-border"}`}>
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-xl font-mono font-bold ${tone === "warning" ? "text-warning" : "text-foreground"}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function brl(v: number) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
