/**
 * Trilha de auditoria FISCAL da loja.
 *
 * Diferente do log de RPC genérico (segurança/permissões), aqui interessa a
 * linha do tempo do documento fiscal: quem reservou numeração, quem mandou
 * emitir, o que a SEFAZ respondeu e o que ficou pendente. É a evidência que o
 * contador pede quando um número some ou uma nota é rejeitada.
 *
 * A tela é somente leitura e junta duas fontes:
 *  - `rpc_audit_log` filtrado nas funções fiscais (ação humana);
 *  - `invoices` (resultado na SEFAZ: autorizada, rejeitada, cancelada).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileClock, RefreshCw, Loader2, Download } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface FiscalAuditLogProps {
  storeId: string | null | undefined;
  className?: string;
  limit?: number;
}

/** Funções de banco consideradas "fiscais" para efeito de auditoria. */
const FISCAL_FUNCTIONS = [
  "reserve_nfce_number",
  "enqueue_fiscal_job",
  "claim_fiscal_jobs",
  "complete_fiscal_job",
  "retry_fiscal_job",
  "record_homologacao_test",
] as const;

const FUNCTION_LABEL: Record<string, string> = {
  reserve_nfce_number: "Reserva de numeração",
  enqueue_fiscal_job: "Nota enfileirada",
  claim_fiscal_jobs: "Caixa assumiu a fila",
  complete_fiscal_job: "Retorno da transmissão",
  retry_fiscal_job: "Reenvio manual",
  record_homologacao_test: "Teste de homologação",
};

const INVOICE_TONE: Record<string, string> = {
  autorizada: "bg-success/15 text-success border-success/30",
  rejeitada: "bg-destructive/15 text-destructive border-destructive/30",
  cancelada: "bg-muted text-muted-foreground border-border",
  inutilizada: "bg-muted text-muted-foreground border-border",
  processando: "bg-primary/15 text-primary border-primary/30",
  rascunho: "bg-warning/15 text-warning border-warning/30",
};

type Origin = "rpc" | "invoice";

interface TimelineEvent {
  id: string;
  at: string;
  origin: Origin;
  title: string;
  detail: string;
  status: string;
  ok: boolean;
}

type FilterMode = "all" | "rpc" | "invoice" | "problem";

function fmt(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString("pt-BR");
}

export function FiscalAuditLog({ storeId, className, limit = 200 }: FiscalAuditLogProps) {
  const [mode, setMode] = useState<FilterMode>("all");

  const query = useQuery({
    queryKey: ["fiscal-audit-log", storeId, limit],
    enabled: Boolean(storeId),
    staleTime: 30_000,
    queryFn: async (): Promise<TimelineEvent[]> => {
      const [rpcRes, invRes] = await Promise.all([
        supabase
          .from("rpc_audit_log")
          .select("id, function_name, allowed, detail, created_at")
          .eq("store_id", storeId!)
          .in("function_name", FISCAL_FUNCTIONS as unknown as string[])
          .order("created_at", { ascending: false })
          .limit(limit),
        supabase
          .from("invoices")
          .select("id, type, status, series, number, environment, terminal_key, rejection_reason, access_key, created_at, issued_at")
          .eq("store_id", storeId!)
          .order("created_at", { ascending: false })
          .limit(limit),
      ]);

      if (rpcRes.error) throw new Error(rpcRes.error.message);
      if (invRes.error) throw new Error(invRes.error.message);

      const events: TimelineEvent[] = [];

      for (const r of rpcRes.data ?? []) {
        events.push({
          id: `rpc:${r.id}`,
          at: r.created_at,
          origin: "rpc",
          title: FUNCTION_LABEL[r.function_name] ?? r.function_name,
          detail: r.detail ?? "—",
          status: r.allowed ? "permitido" : "negado",
          ok: Boolean(r.allowed),
        });
      }

      for (const i of invRes.data ?? []) {
        const doc = `${String(i.type).toUpperCase()} série ${i.series} nº ${i.number} (${i.environment})`;
        const extra = i.rejection_reason
          ? ` — ${i.rejection_reason}`
          : i.access_key
            ? ` — chave ${String(i.access_key).slice(0, 12)}…`
            : "";
        events.push({
          id: `inv:${i.id}`,
          at: i.issued_at ?? i.created_at,
          origin: "invoice",
          title: doc,
          detail: `${i.terminal_key ? `caixa ${i.terminal_key.slice(0, 10)}` : "caixa não identificado"}${extra}`,
          status: i.status,
          ok: i.status === "autorizada",
        });
      }

      return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, limit);
    },
  });

  const rows = useMemo(() => {
    const all = query.data ?? [];
    if (mode === "all") return all;
    if (mode === "problem") return all.filter((e) => !e.ok);
    return all.filter((e) => e.origin === mode);
  }, [query.data, mode]);

  /** Exportação simples em CSV para anexar ao fechamento contábil. */
  function exportCsv() {
    if (rows.length === 0) {
      toast.info("Nada para exportar com o filtro atual.");
      return;
    }
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = [
      "data;origem;evento;detalhe;situacao",
      ...rows.map((r) =>
        [fmt(r.at), r.origin === "rpc" ? "acao" : "documento", r.title, r.detail, r.status].map(esc).join(";"),
      ),
    ].join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `auditoria-fiscal-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${rows.length} evento(s) exportado(s).`);
  }

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileClock className="h-5 w-5" /> Auditoria fiscal
          </CardTitle>
          <CardDescription>
            Linha do tempo de numeração reservada, transmissões e respostas da SEFAZ. Somente leitura — nada aqui
            pode ser apagado pelo aplicativo.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={mode} onValueChange={(v) => setMode(v as FilterMode)}>
            <SelectTrigger className="w-[190px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os eventos</SelectItem>
              <SelectItem value="problem">Somente problemas</SelectItem>
              <SelectItem value="rpc">Ações no sistema</SelectItem>
              <SelectItem value="invoice">Documentos fiscais</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span className="ml-2">Atualizar</span>
          </Button>
          <Button size="sm" variant="outline" onClick={exportCsv}>
            <Download className="h-4 w-4 mr-2" /> CSV
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {query.error && (
          <p className="text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Falha ao carregar a auditoria fiscal."}
          </p>
        )}

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="p-2 text-left">Quando</th>
                <th className="p-2 text-left">Origem</th>
                <th className="p-2 text-left">Evento</th>
                <th className="p-2 text-left">Detalhe</th>
                <th className="p-2 text-left">Situação</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-t align-top">
                  <td className="p-2 whitespace-nowrap font-mono text-muted-foreground">{fmt(e.at)}</td>
                  <td className="p-2">
                    <Badge variant="outline" className="text-[10px]">
                      {e.origin === "rpc" ? "Ação" : "Documento"}
                    </Badge>
                  </td>
                  <td className="p-2 font-medium text-foreground">{e.title}</td>
                  <td className="p-2 text-muted-foreground">{e.detail}</td>
                  <td className="p-2">
                    <span
                      className={cn(
                        "inline-flex rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase",
                        INVOICE_TONE[e.status] ??
                          (e.ok
                            ? "bg-success/15 text-success border-success/30"
                            : "bg-destructive/15 text-destructive border-destructive/30"),
                      )}
                    >
                      {e.status}
                    </span>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !query.isLoading && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground">
                    Nenhum evento fiscal registrado com este filtro.
                  </td>
                </tr>
              )}
              {query.isLoading && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground">
                    Carregando eventos…
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
