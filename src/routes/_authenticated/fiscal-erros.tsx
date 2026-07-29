import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, RefreshCw, Printer, Loader2, FileText, CheckCircle2, Clock } from "lucide-react";
import { toast } from "sonner";
import { runFiscalRetryPass, syncPendingSalesToQueue } from "@/lib/fiscal-scheduler";
import { listFiscalJobs, retryFiscalJob, type FiscalJob } from "@/lib/fiscal-queue";
import { reprintAuthorizedReceipt } from "@/lib/fiscal-reprint";

export const Route = createFileRoute("/_authenticated/fiscal-erros")({
  head: () => ({
    meta: [
      { title: "Erros fiscais — reemissão de NFC-e | Bastion PDV" },
      { name: "description", content: "Acompanhe notas rejeitadas ou pendentes, veja o motivo da falha, reemita para a SEFAZ e reimprima o cupom com QR Code autorizado." },
      { property: "og:title", content: "Erros fiscais — reemissão de NFC-e" },
      { property: "og:description", content: "Fila de reemissão automática de NFC-e com histórico de erros por venda." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: FiscalErrorsPage,
});

const money = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pendente: { label: "Pendente", cls: "bg-warning/15 text-warning border-warning/30" },
    falha: { label: "Falha", cls: "bg-destructive/15 text-destructive border-destructive/30" },
    rejeitada: { label: "Rejeitada", cls: "bg-destructive/15 text-destructive border-destructive/30" },
    emitida: { label: "Autorizada", cls: "bg-success/15 text-success border-success/30" },
  };
  const s = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground border-border" };
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider ${s.cls}`}>{s.label}</span>;
}

/** Tradução do backoff da fila para linguagem de operador de caixa. */
function nextAttemptLabel(job?: FiscalJob): string {
  if (!job) return "Na próxima varredura";
  if (job.permanent) return "Requer correção manual";
  if (job.status === "processando") return "Emitindo agora";
  const diff = new Date(job.next_attempt_at).getTime() - Date.now();
  if (Number.isNaN(diff) || diff <= 0) return "Na próxima varredura";
  return `Em ~${Math.ceil(diff / 60_000)} min`;
}

function FiscalErrorsPage() {
  const { storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  // Fila persistida no banco: compartilhada entre todos os caixas da loja.
  const queue = useQuery({
    queryKey: ["fiscal-queue", storeId],
    enabled: !!storeId,
    refetchInterval: 20_000,
    queryFn: async () => {
      await syncPendingSalesToQueue(storeId!);
      return listFiscalJobs(storeId!, {
        status: ["pendente", "processando", "falha"],
        limit: 200,
      });
    },
  });

  const jobBySale = new Map((queue.data ?? []).map((j) => [j.sale_id, j]));

  const pending = useQuery({
    queryKey: ["fiscal-errors", storeId],
    enabled: !!storeId,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("id, total, fiscal_status, created_at, finalized_at")
        .eq("store_id", storeId!)
        .in("fiscal_status", ["pendente", "falha"])
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });

  const rejected = useQuery({
    queryKey: ["fiscal-rejected", storeId],
    enabled: !!storeId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("id, sale_id, series, number, status, rejection_reason, created_at, total")
        .eq("store_id", storeId!)
        .eq("status", "rejeitada")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["fiscal-queue"] });
    qc.invalidateQueries({ queryKey: ["fiscal-errors"] });
    qc.invalidateQueries({ queryKey: ["fiscal-rejected"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
  };

  const retryOne = async (saleId: string) => {
    if (!storeId) return;
    setBusy(saleId);
    try {
      const job = jobBySale.get(saleId);
      if (job) await retryFiscalJob(job.id);
      const r = await runFiscalRetryPass(storeId, { force: true, saleIds: [saleId] });
      if (r.authorized > 0) toast.success("NFC-e autorizada pela SEFAZ");
      else toast.error(jobBySale.get(saleId)?.last_error ?? "Reemissão falhou novamente");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao reemitir");
    } finally {
      setBusy(null);
      refreshAll();
    }
  };

  const retryAll = async () => {
    if (!storeId) return;
    setBusy("__all__");
    try {
      const r = await runFiscalRetryPass(storeId, { force: true });
      toast[r.authorized > 0 ? "success" : "info"](
        `${r.attempted} tentativa(s) · ${r.authorized} autorizada(s) · ${r.failed} com falha`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro na fila de reemissão");
    } finally {
      setBusy(null);
      refreshAll();
    }
  };

  const reprint = async (saleId: string) => {
    setBusy(`print:${saleId}`);
    const r = await reprintAuthorizedReceipt(saleId);
    setBusy(null);
    if (!r.ok) toast.error(r.error ?? "Falha ao reimprimir");
    else if (!r.authorized) toast.warning("Cupom reimpresso sem QR — nota ainda não autorizada");
    else toast.success("Cupom reimpresso com QR Code autorizado");
  };

  if (!storeId) return <StoreRequired />;

  const rows = pending.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Erros fiscais"
        description="Notas que não foram autorizadas pela SEFAZ. A reemissão automática roda a cada minuto; aqui você força a tentativa e reimprime o cupom autorizado."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={refreshAll}>
              <RefreshCw className="size-4 mr-1.5" /> Atualizar
            </Button>
            <Button size="sm" onClick={retryAll} disabled={busy !== null || rows.length === 0}>
              {busy === "__all__" ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : <RefreshCw className="size-4 mr-1.5" />}
              Reemitir todas ({rows.length})
            </Button>
          </div>
        }
      />

      <section className="border border-border rounded-md bg-card">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <AlertTriangle className="size-4 text-warning" />
          <h2 className="text-sm font-semibold">Fila de reemissão</h2>
          <Badge variant="outline" className="ml-auto font-mono text-[10px]">{rows.length}</Badge>
        </header>

        {pending.isLoading ? (
          <div className="p-8 text-center text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin mx-auto mb-2" /> Carregando…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <CheckCircle2 className="size-8 text-success mx-auto mb-3" />
            <p className="text-sm font-medium">Nenhuma nota pendente</p>
            <p className="text-xs text-muted-foreground mt-1">Todas as vendas fiscais foram autorizadas pela SEFAZ.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((s) => {
              const entry = jobBySale.get(s.id);
              return (
                <li key={s.id} className="px-4 py-3 flex flex-col md:flex-row md:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">#{s.id.slice(0, 8).toUpperCase()}</span>
                      <StatusPill status={s.fiscal_status ?? "pendente"} />
                      <span className="text-xs font-semibold">{money(Number(s.total ?? 0))}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-1">
                      {new Date(s.created_at).toLocaleString("pt-BR")}
                      {entry?.attempts ? ` · ${entry.attempts}/${entry.max_attempts} tentativa(s)` : ""}
                      {entry?.last_channel ? ` · via ${entry.last_channel}` : ""}
                      <span className="inline-flex items-center gap-1 ml-2">
                        <Clock className="size-3" /> {nextAttemptLabel(entry)}
                      </span>
                    </div>
                    {entry?.last_error && (
                      <p className="text-[11px] text-destructive mt-1 break-words font-mono">{entry.last_error}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => reprint(s.id)} disabled={busy !== null}>
                      {busy === `print:${s.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Printer className="size-3.5" />}
                      <span className="ml-1.5">Reimprimir</span>
                    </Button>
                    <Button size="sm" onClick={() => retryOne(s.id)} disabled={busy !== null}>
                      {busy === s.id ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                      <span className="ml-1.5">Reemitir</span>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="border border-border rounded-md bg-card">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <FileText className="size-4 text-destructive" />
          <h2 className="text-sm font-semibold">Rejeições registradas pela SEFAZ</h2>
        </header>
        {(rejected.data ?? []).length === 0 ? (
          <p className="p-6 text-xs text-muted-foreground text-center">Nenhuma rejeição registrada.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rejected.data!.map((inv) => (
              <li key={inv.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">NFC-e {inv.series}/{inv.number}</span>
                  <StatusPill status={inv.status} />
                  <span className="text-[11px] text-muted-foreground ml-auto">{new Date(inv.created_at).toLocaleString("pt-BR")}</span>
                </div>
                <p className="text-[11px] text-destructive mt-1 font-mono break-words">
                  {inv.rejection_reason ?? "Sem detalhe retornado pelo provedor."}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-[11px] text-muted-foreground">
        Configure certificado, CSC e motor de emissão em{" "}
        <Link to="/fiscal" className="underline underline-offset-2">Nota Fiscal</Link>.
      </p>
    </div>
  );
}
