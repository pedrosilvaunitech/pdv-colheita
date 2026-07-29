/**
 * Auditoria de numeração NFC-e — duplicidades, lacunas e desvio de config.
 *
 * Leitura pura: nenhum número é corrigido automaticamente, porque a correção
 * correta (cancelar nota ou inutilizar faixa) depende de ação junto à SEFAZ.
 */
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, Hash, Loader2, RefreshCw } from "lucide-react";
import { auditNfceNumbering, numberingSummary } from "@/lib/fiscal-numbering-audit";

export interface NumberingAuditCardProps {
  storeId: string;
  className?: string;
}

export function NumberingAuditCard({ storeId, className }: NumberingAuditCardProps) {
  const audit = useQuery({
    queryKey: ["nfce-numbering-audit", storeId],
    queryFn: () => auditNfceNumbering(storeId),
    refetchInterval: 120_000,
  });

  const report = audit.data;

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Hash className="h-5 w-5" /> Auditoria de numeração NFC-e
          </CardTitle>
          <CardDescription>
            Verifica se dois caixas gravaram o mesmo número, se há faixas sem nota e se a numeração configurada
            está atrás da realidade.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => audit.refetch()} disabled={audit.isFetching}>
          {audit.isFetching ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          Auditar
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {audit.isLoading && <p className="text-sm text-muted-foreground">Analisando notas emitidas…</p>}
        {audit.error && (
          <p className="text-sm text-destructive">
            {audit.error instanceof Error ? audit.error.message : "Falha ao auditar numeração."}
          </p>
        )}

        {report && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={report.ok ? "default" : "destructive"} className={report.ok ? "bg-success" : ""}>
                {report.ok ? (
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                )}
                {report.ok ? "Numeração íntegra" : "Numeração com pendências"}
              </Badge>
              {report.nextSeries !== null && (
                <Badge variant="outline" className="font-mono">
                  próxima: série {report.nextSeries} nº {report.nextNumber}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{numberingSummary(report)}</span>
            </div>

            {report.duplicates.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <p className="text-xs font-medium text-destructive mb-2">
                  Números duplicados ({report.duplicates.length})
                </p>
                <ul className="space-y-1 text-xs font-mono">
                  {report.duplicates.slice(0, 10).map((d) => (
                    <li key={`${d.environment}-${d.series}-${d.number}`}>
                      {d.environment} · série {d.series} · nº {d.number} — {d.records.length} registros (caixas:{" "}
                      {d.terminals.join(", ")})
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.gaps.length > 0 && (
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium mb-2">Faixas sem nota ({report.gaps.length})</p>
                <ul className="space-y-1 text-xs font-mono text-muted-foreground">
                  {report.gaps.slice(0, 10).map((g) => (
                    <li key={`${g.environment}-${g.series}-${g.from}`}>
                      {g.environment} · série {g.series} · {g.from === g.to ? `nº ${g.from}` : `nº ${g.from}–${g.to}`}{" "}
                      ({g.count})
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Números reservados que não viraram nota devem ser inutilizados junto à SEFAZ.
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
