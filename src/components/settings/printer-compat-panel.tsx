/**
 * Painel de compatibilidade de impressão.
 *
 * Traduz o relatório técnico de `printer-compat.ts` em uma lista acionável:
 * cada linha diz o que foi verificado, o que se observou e — quando há
 * problema — exatamente o que fazer. Não imprime nada, então pode ser rodado à
 * vontade sem gastar papel.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ShieldCheck, AlertTriangle, XCircle, MinusCircle, Loader2, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { runPrinterCompatCheck, type CompatReport, type CompatStatus } from "@/lib/printer-compat";
import { logSensitiveChange } from "@/lib/sensitive-audit";

export interface PrinterCompatPanelProps {
  storeId: string | null;
  className?: string;
}

const STATUS_ICON: Record<CompatStatus, typeof ShieldCheck> = {
  ok: ShieldCheck,
  aviso: AlertTriangle,
  falha: XCircle,
  na: MinusCircle,
};

const STATUS_STYLE: Record<CompatStatus, string> = {
  ok: "text-emerald-500",
  aviso: "text-amber-500",
  falha: "text-destructive",
  na: "text-muted-foreground",
};

export function PrinterCompatPanel({ storeId, className }: PrinterCompatPanelProps) {
  const [report, setReport] = useState<CompatReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      const result = await runPrinterCompatCheck(storeId);
      setReport(result);
      const failures = result.checks.filter((c) => c.status === "falha").length;
      if (failures > 0) toast.error("Impressão bloqueada", { description: result.summary });
      else toast.success("Verificação concluída", { description: result.summary });
      if (storeId) {
        void logSensitiveChange({
          storeId,
          area: "impressora",
          action: "compatibilidade_verificada",
          detail: result.summary,
        });
      }
    } catch (e) {
      toast.error("Não foi possível verificar", {
        description: e instanceof Error ? e.message : "Erro inesperado.",
      });
    } finally {
      setRunning(false);
    }
  }, [storeId]);

  return (
    <div className={cn("rounded-lg border border-border bg-muted/30 p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Stethoscope className="h-4 w-4 text-primary" aria-hidden="true" />
            Compatibilidade de impressão
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Confere canal, permissões, papel e acentos sem imprimir nada.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void run()} disabled={running}>
          {running ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Stethoscope className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {running ? "Verificando…" : "Verificar agora"}
        </Button>
      </div>

      {report && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={report.canPrint ? "default" : "destructive"}>
              {report.canPrint ? "Pronta para imprimir" : "Sem canal de impressão"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {report.summary} · {report.ranAt}
            </span>
          </div>

          <ul className="space-y-2">
            {report.checks.map((check) => {
              const Icon = STATUS_ICON[check.status];
              return (
                <li
                  key={check.id}
                  className="flex gap-3 rounded-md border border-border/60 bg-card p-3 text-sm"
                >
                  <Icon
                    className={cn("mt-0.5 h-4 w-4 shrink-0", STATUS_STYLE[check.status])}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium text-foreground">{check.label}</p>
                    <p className="text-xs text-muted-foreground">{check.message}</p>
                    {check.fix && (
                      <p className="text-xs text-foreground">
                        <span className="font-medium">Como resolver: </span>
                        {check.fix}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
