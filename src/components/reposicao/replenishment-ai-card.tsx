import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Brain, Loader2, AlertTriangle, Truck, Sparkles, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import {
  analyzeReplenishment,
  type ReplenishmentAiReport,
} from "@/lib/replenishment-ai.functions";
import { URGENCY_META, type ForecastResult } from "@/lib/replenishment-forecast";

const PRIORITY_CLASS: Record<string, string> = {
  critica: "bg-destructive/15 text-destructive border-destructive/40",
  alta: "bg-destructive/10 text-destructive border-destructive/30",
  media: "bg-warning/15 text-warning border-warning/40",
  baixa: "bg-muted text-muted-foreground border-border",
};

const PRIORITY_LABEL: Record<string, string> = {
  critica: "Crítica", alta: "Alta", media: "Média", baixa: "Baixa",
};

export interface ReplenishmentAiCardProps {
  /** Projeções já calculadas (ordenadas por urgência). */
  forecasts: ForecastResult[];
  storeName: string | null;
}

/**
 * Painel de análise por IA da reposição.
 *
 * Envia apenas as métricas dos itens de maior risco (máx. 40) para manter a
 * chamada rápida e barata. A IA interpreta; os números continuam vindo do
 * motor determinístico.
 */
export function ReplenishmentAiCard({ forecasts, storeName }: ReplenishmentAiCardProps) {
  const analyze = useServerFn(analyzeReplenishment);
  const [report, setReport] = useState<ReplenishmentAiReport | null>(null);

  /** Itens com risco real de ruptura — sem histórico de venda não entra. */
  const candidates = useMemo(
    () => forecasts.filter((f) => f.urgency !== "tranquilo" || f.currentStock <= 0).slice(0, 40),
    [forecasts],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      return analyze({
        data: {
          storeName,
          items: candidates.map((f) => ({
            name: f.name,
            unit: f.unit,
            currentStock: f.currentStock,
            avgDaily: f.avgDailyWeighted,
            sold7d: f.sold7d,
            sold30d: f.sold30d,
            trendPercent: f.trendPercent,
            daysUntilStockout: f.daysUntilStockout,
            daysToOrder: f.daysToOrder,
            leadTimeDays: f.leadTimeDays,
            recommendedQty: f.recommendedQty,
            estimatedCost: f.estimatedCost,
            supplierName: f.supplierName,
          })),
        },
      });
    },
    onSuccess: (data) => {
      setReport(data);
      toast.success("Análise concluída");
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Não foi possível concluir a análise");
    },
  });

  const criticalCount = forecasts.filter((f) => f.urgency === "vencido" || f.urgency === "urgente").length;

  return (
    <div className="border border-border rounded-md bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Brain className="size-4 text-primary" />
          <div>
            <div className="text-sm font-semibold">Análise inteligente de reposição</div>
            <div className="text-xs text-muted-foreground">
              Projeta quanto tempo cada item dura e até quando dá para pedir ao fornecedor.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {criticalCount > 0 && (
            <Badge variant="outline" className={URGENCY_META.urgente.className}>
              {criticalCount} item(ns) no limite
            </Badge>
          )}
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || candidates.length === 0}
            className="gap-2"
          >
            {mutation.isPending
              ? <><Loader2 className="size-4 animate-spin" /> Analisando…</>
              : report
                ? <><RefreshCw className="size-4" /> Reanalisar</>
                : <><Sparkles className="size-4" /> Analisar com IA</>}
          </Button>
        </div>
      </div>

      {candidates.length === 0 && (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          Nenhum item com risco de ruptura no momento — nada para analisar.
        </div>
      )}

      {report && (
        <div className="p-4 space-y-4">
          {report.resumo && (
            <p className="text-sm leading-relaxed text-foreground/90">{report.resumo}</p>
          )}

          {report.alertas.length > 0 && (
            <ul className="space-y-1.5">
              {report.alertas.map((alerta, i) => (
                <li key={i} className="flex gap-2 text-sm text-destructive">
                  <AlertTriangle className="size-4 mt-0.5 shrink-0" />
                  <span>{alerta}</span>
                </li>
              ))}
            </ul>
          )}

          {report.itens.length > 0 && (
            <div className="border border-border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Prioridade</TableHead>
                    <TableHead>Produto</TableHead>
                    <TableHead className="w-40">Duração do estoque</TableHead>
                    <TableHead className="w-40">Prazo do pedido</TableHead>
                    <TableHead className="w-40">Quantidade</TableHead>
                    <TableHead>Recomendação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.itens.map((item, i) => (
                    <TableRow key={`${item.produto}-${i}`}>
                      <TableCell>
                        <Badge variant="outline" className={PRIORITY_CLASS[item.prioridade]}>
                          {PRIORITY_LABEL[item.prioridade]}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{item.produto}</TableCell>
                      <TableCell className="text-sm">{item.duracao_estoque}</TableCell>
                      <TableCell className="text-sm font-mono">{item.prazo_pedido}</TableCell>
                      <TableCell className="text-sm font-mono">{item.quantidade_sugerida}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <div>{item.observacao}</div>
                        <div className="text-xs mt-0.5">{item.fornecedor}</div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {report.plano_fornecedores.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                Plano por fornecedor
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {report.plano_fornecedores.map((plan, i) => (
                  <div key={`${plan.fornecedor}-${i}`} className="border border-border rounded-md p-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Truck className="size-4 text-primary" />{plan.fornecedor}
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">{plan.acao}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Sugestão gerada por IA a partir do histórico de vendas. Confirme com o fornecedor antes de fechar o pedido.
          </p>
        </div>
      )}
    </div>
  );
}
