/**
 * Painel NOC da fila de emissão fiscal.
 *
 * Mostra, em tempo quase real, o que cada caixa está fazendo com a SEFAZ:
 * quantos jobs estão na fila, quantos estão sendo transmitidos agora, quantas
 * conexões o caixa mantém abertas e qual a próxima janela de retentativa de
 * cada nota. É a tela que o operador/gerente olha quando "a nota não sai".
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Activity, PlayCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  JOB_STATUS_LABEL,
  getQueueSummary,
  listFiscalJobs,
  retryFiscalJob,
  type FiscalJob,
} from "@/lib/fiscal-queue";
import { runFiscalRetryPass } from "@/lib/fiscal-scheduler";
import { classifyFiscalError, ERROR_CLASS_LABEL } from "@/lib/fiscal-retry-policy";
import {
  MAX_SEFAZ_CONNECTIONS,
  currentSefazConnections,
  queuedSefazConnections,
} from "@/lib/sefaz-connection";

export interface FiscalQueuePanelProps {
  storeId: string;
  className?: string;
}

const STATUS_STYLE: Record<string, string> = {
  pendente: "bg-warning/15 text-warning border-warning/30",
  processando: "bg-primary/15 text-primary border-primary/30",
  falha: "bg-destructive/15 text-destructive border-destructive/30",
  concluida: "bg-success/15 text-success border-success/30",
  cancelada: "bg-muted text-muted-foreground border-border",
};

function eta(job: FiscalJob): string {
  if (job.permanent) return "manual";
  if (job.status === "processando") return "agora";
  const diff = new Date(job.next_attempt_at).getTime() - Date.now();
  if (Number.isNaN(diff) || diff <= 0) return "próxima varredura";
  return `~${Math.ceil(diff / 60_000)} min`;
}

/** Telemetria local de conexões — atualiza sozinha a cada 2s. */
function useConnectionGauge() {
  const [gauge, setGauge] = useState({ open: 0, waiting: 0 });
  useEffect(() => {
    const t = setInterval(
      () => setGauge({ open: currentSefazConnections(), waiting: queuedSefazConnections() }),
      2000,
    );
    return () => clearInterval(t);
  }, []);
  return gauge;
}

export function FiscalQueuePanel({ storeId, className }: FiscalQueuePanelProps) {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const gauge = useConnectionGauge();

  const summary = useQuery({
    queryKey: ["fiscal-queue-summary", storeId],
    queryFn: () => getQueueSummary(storeId),
    refetchInterval: 15_000,
  });

  const jobs = useQuery({
    queryKey: ["fiscal-queue-panel", storeId],
    queryFn: () => listFiscalJobs(storeId, { statuses: ["pendente", "processando", "falha"], limit: 50 }),
    refetchInterval: 15_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["fiscal-queue-summary"] });
    void qc.invalidateQueries({ queryKey: ["fiscal-queue-panel"] });
    void qc.invalidateQueries({ queryKey: ["fiscal-queue"] });
  };

  const runPass = async () => {
    setRunning(true);
    try {
      const r = await runFiscalRetryPass(storeId);
      toast.success(`Rodada concluída: ${r.authorized} autorizada(s), ${r.failed} com falha.`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao processar a fila.");
    } finally {
      setRunning(false);
    }
  };

  const counts = summary.data;

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" /> Fila de emissão fiscal
          </CardTitle>
          <CardDescription>
            Estado compartilhado entre todos os caixas da loja. Cada caixa reserva os próprios jobs, então a fila
            escoa em paralelo sem risco de nota duplicada.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={refresh} disabled={jobs.isFetching}>
            <RefreshCw className={cn("h-4 w-4 mr-2", jobs.isFetching && "animate-spin")} /> Atualizar
          </Button>
          <Button size="sm" onClick={runPass} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PlayCircle className="h-4 w-4 mr-2" />}
            Processar agora
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {(["pendente", "processando", "falha", "concluida", "cancelada"] as const).map((s) => (
            <div key={s} className="rounded-md border bg-muted/30 p-3">
              <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                {JOB_STATUS_LABEL[s]}
              </p>
              <p className="text-2xl font-semibold tabular-nums">{counts?.[s] ?? 0}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 p-3 text-xs">
          <span className="font-mono uppercase tracking-wider text-muted-foreground">Conexões deste caixa</span>
          <Badge variant="outline" className="tabular-nums">
            {gauge.open}/{MAX_SEFAZ_CONNECTIONS} em transmissão
          </Badge>
          <Badge variant="outline" className="tabular-nums">
            {gauge.waiting} aguardando slot
          </Badge>
          <span className="text-muted-foreground">
            O limite protege a SEFAZ contra excesso de conexões simultâneas (cStat 656).
          </span>
        </div>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="p-2 text-left">Venda</th>
                <th className="p-2 text-left">Caixa</th>
                <th className="p-2 text-left">Estado</th>
                <th className="p-2 text-left">Tentativas</th>
                <th className="p-2 text-left">Diagnóstico</th>
                <th className="p-2 text-left">Próxima</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {(jobs.data ?? []).map((job) => (
                <tr key={job.id} className="border-t">
                  <td className="p-2 font-mono">{job.sale_id.slice(0, 8)}</td>
                  <td className="p-2 font-mono">{job.terminal_key?.slice(0, 10) ?? "—"}</td>
                  <td className="p-2">
                    <span
                      className={cn(
                        "inline-flex rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase",
                        STATUS_STYLE[job.status],
                      )}
                    >
                      {JOB_STATUS_LABEL[job.status]}
                    </span>
                  </td>
                  <td className="p-2 tabular-nums">
                    {job.attempts}/{job.max_attempts}
                  </td>
                  <td className="p-2 text-muted-foreground">
                    {job.last_error ? ERROR_CLASS_LABEL[classifyFiscalError(job.last_error)] : "—"}
                  </td>
                  <td className="p-2 text-muted-foreground">{eta(job)}</td>
                  <td className="p-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await retryFiscalJob(job.id);
                        toast.info("Job reagendado para a próxima varredura.");
                        refresh();
                      }}
                    >
                      Reagendar
                    </Button>
                  </td>
                </tr>
              ))}
              {(jobs.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-muted-foreground">
                    Nenhuma nota na fila. Todas as vendas fiscais estão autorizadas.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
