/**
 * Painel de limpeza de registros fiscais (homologação e produção).
 *
 * Existe porque a fase de implantação gera lixo inevitável: notas de teste em
 * homologação, rascunhos criados antes do certificado e jobs de fila de vendas
 * fictícias. Sem uma saída controlada, o lojista fica com um painel
 * permanentemente vermelho e perde a capacidade de ver o erro que importa.
 *
 * Restrições deliberadas:
 *  - só gerentes/administradores veem os controles (e a RLS confirma no banco);
 *  - nota AUTORIZADA ou CANCELADA em produção nunca é apagada;
 *  - confirmação explícita, com contagem prévia do que será removido;
 *  - toda limpeza fica na trilha de auditoria e pode ser exportada em CSV.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Download, Eraser, FileSpreadsheet, ListChecks, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useStorePermissions } from "@/hooks/use-store-permissions";
import {
  listPurgeAudit,
  previewFiscalPurge,
  purgeFiscalErrors,
  type PurgeEnvironment,
} from "@/lib/fiscal-purge";
import {
  getPurgeSchedule,
  nextPurgeAt,
  PURGE_FREQUENCY_LABEL,
  runScheduledPurge,
  setPurgeSchedule,
  type PurgeFrequency,
  type PurgeSchedule,
} from "@/lib/fiscal-purge-schedule";
import { buildAuditCsv, csvFilename, downloadCsv } from "@/lib/audit-csv";
import { buildAuditWorkbook, downloadWorkbook, xlsxFilename } from "@/lib/audit-xlsx";
import { supabase } from "@/integrations/supabase/client";
import { FiscalPurgeSelectDialog } from "@/components/fiscal/fiscal-purge-select-dialog";

export interface FiscalPurgeCardProps {
  storeId: string;
  className?: string;
}

/** Verificação do agendamento: na abertura e a cada 15 minutos. */
const SCHEDULE_TICK_MS = 15 * 60_000;

const ENV_LABEL: Record<PurgeEnvironment, string> = {
  homologacao: "homologação",
  producao: "produção",
  todos: "ambos os ambientes",
};

export function FiscalPurgeCard({ storeId, className }: FiscalPurgeCardProps) {
  const qc = useQueryClient();
  const { permissions } = useStorePermissions(storeId);
  const [environment, setEnvironment] = useState<PurgeEnvironment>("homologacao");
  const [includeInvoices, setIncludeInvoices] = useState(true);
  const [includeQueue, setIncludeQueue] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectOpen, setSelectOpen] = useState(false);
  const [schedule, setSchedule] = useState<PurgeSchedule>(() => getPurgeSchedule(storeId));

  const canManage = permissions.canManageSettings || permissions.canAll;

  useEffect(() => {
    setSchedule(getPurgeSchedule(storeId));
  }, [storeId]);

  const invalidateAll = () => {
    for (const key of [
      "fiscal-purge-preview",
      "fiscal-purge-audit",
      "fiscal-purgeable",
      "fiscal-queue",
      "fiscal-errors",
      "fiscal-rejected",
      "fiscal-audit-log",
      "invoices",
      "numbering-audit",
    ]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const preview = useQuery({
    queryKey: ["fiscal-purge-preview", storeId],
    enabled: Boolean(storeId),
    staleTime: 15_000,
    queryFn: () => previewFiscalPurge(storeId),
  });

  const audit = useQuery({
    queryKey: ["fiscal-purge-audit", storeId],
    enabled: Boolean(storeId),
    staleTime: 30_000,
    queryFn: () => listPurgeAudit(storeId),
  });

  /** Identidade da loja usada no cabeçalho da planilha (nome, CNPJ e logo). */
  const store = useQuery({
    queryKey: ["purge-audit-store", storeId],
    enabled: Boolean(storeId),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [{ data: s }, { data: r }] = await Promise.all([
        supabase.from("stores").select("name, fantasy_name, cnpj").eq("id", storeId).maybeSingle(),
        supabase.from("receipt_settings").select("logo_url").eq("store_id", storeId).maybeSingle(),
      ]);
      return {
        name: s?.fantasy_name || s?.name || null,
        cnpj: s?.cnpj ?? null,
        logoUrl: r?.logo_url ?? null,
      };
    },
  });

  // Agendamento: roda só para quem tem permissão, para não gerar erro em loop
  // no caixa comum, que veria a RLS recusar a cada verificação.
  useEffect(() => {
    if (!storeId || !canManage) return;
    let alive = true;

    const tick = async () => {
      const outcome = await runScheduledPurge(storeId);
      if (!alive) return;
      setSchedule(outcome.schedule);
      if (!outcome.ran) return;
      if (outcome.error) {
        toast.error("Limpeza fiscal automática falhou", { description: outcome.error });
        return;
      }
      if (outcome.result && outcome.result.total > 0) {
        toast.success("Limpeza fiscal automática concluída", {
          description: `${outcome.result.invoicesDeleted} nota(s) e ${outcome.result.queueDeleted} item(ns) de fila removidos.`,
        });
        invalidateAll();
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), SCHEDULE_TICK_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, canManage, schedule.enabled, schedule.frequency, schedule.environment]);

  const purge = useMutation({
    mutationFn: () => purgeFiscalErrors(storeId, { environment, includeInvoices, includeQueue }),
    onSuccess: (r) => {
      if (r.total === 0) {
        toast.info("Nada elegível para remoção com os filtros atuais.");
      } else {
        toast.success(`${r.invoicesDeleted} nota(s) e ${r.queueDeleted} item(ns) de fila removidos.`);
      }
      invalidateAll();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao limpar registros fiscais"),
    onSettled: () => setConfirmOpen(false),
  });

  const runNow = useMutation({
    mutationFn: () => runScheduledPurge(storeId, { force: true }),
    onSuccess: (outcome) => {
      setSchedule(outcome.schedule);
      if (outcome.error) toast.error(outcome.error);
      else
        toast.success(
          `Limpeza executada: ${outcome.result?.invoicesDeleted ?? 0} nota(s) e ${outcome.result?.queueDeleted ?? 0} item(ns).`,
        );
      invalidateAll();
    },
  });

  const patchSchedule = (patch: Partial<PurgeSchedule>) => setSchedule(setPurgeSchedule(storeId, patch));

  /** Normaliza os registros para o formato compartilhado de auditoria. */
  const auditRows = () =>
    (audit.data ?? []).map((r) => ({
      function_name: "purge_fiscal_errors",
      allowed: r.allowed,
      user_id: r.userId,
      store_id: storeId,
      detail: r.detail,
      created_at: r.createdAt,
    }));

  /** Exporta o histórico de limpezas no mesmo formato dos demais CSVs (pt-BR). */
  const exportAudit = () => {
    const rows = auditRows();
    if (rows.length === 0) {
      toast.info("Nenhuma limpeza registrada para exportar.");
      return;
    }
    const csv = buildAuditCsv(rows, () => "Limpeza de registros fiscais");
    downloadCsv(csvFilename("auditoria-limpeza-fiscal"), csv);
    toast.success(`${rows.length} registro(s) exportado(s).`);
  };

  /**
   * Excel formatado (cabeçalho com a loja, resumo e autofiltro) — é o formato
   * que a contabilidade pede quando precisa arquivar a justificativa da limpeza.
   */
  const exportAuditXlsx = useMutation({
    mutationFn: async () => {
      const rows = auditRows();
      if (rows.length === 0) throw new Error("Nenhuma limpeza registrada para exportar.");
      const workbook = await buildAuditWorkbook(rows, {
        store: {
          name: store.data?.name ?? null,
          cnpj: store.data?.cnpj ?? null,
          logoUrl: store.data?.logoUrl ?? null,
        },
        filterLabel: "Limpeza de registros fiscais",
        labelFor: () => "Limpeza de registros fiscais",
      });
      await downloadWorkbook(xlsxFilename("auditoria-limpeza-fiscal"), workbook);
      return rows.length;
    },
    onSuccess: (n) => toast.success(`${n} registro(s) exportado(s) em Excel.`),
    onError: (e: Error) => toast.info(e.message),
  });

  const p = preview.data;
  const eligible = (() => {
    if (!p) return 0;
    let n = 0;
    if (includeInvoices) {
      if (environment !== "producao") n += p.homologacaoInvoices;
      if (environment !== "homologacao") n += p.producaoDraftInvoices + p.rejectedInvoices;
    }
    if (includeQueue) n += p.failedJobs + p.stuckJobs;
    return n;
  })();

  const next = nextPurgeAt(schedule);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Eraser className="h-4 w-4" /> Limpar registros fiscais de teste
        </CardTitle>
        <CardDescription>
          Remove notas de <strong>homologação</strong> (sem valor fiscal), rascunhos criados sem certificado e itens
          de fila travados. Notas <strong>autorizadas ou canceladas em produção nunca são apagadas</strong> — a
          exclusão é bloqueada pelo próprio banco e toda limpeza fica registrada na auditoria.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid gap-2 sm:grid-cols-5 text-xs">
          <Stat label="Homologação" value={p?.homologacaoInvoices} />
          <Stat label="Rascunho (produção)" value={p?.producaoDraftInvoices} />
          <Stat label="Rejeitadas" value={p?.rejectedInvoices} />
          <Stat label="Fila em falha" value={p?.failedJobs} />
          <Stat label="Fila travada" value={p?.stuckJobs} />
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Ambiente</Label>
            <Select value={environment} onValueChange={(v) => setEnvironment(v as PurgeEnvironment)}>
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="homologacao">Somente homologação (teste)</SelectItem>
                <SelectItem value="producao">Somente produção (não autorizadas)</SelectItem>
                <SelectItem value="todos">Ambos os ambientes</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="purge-invoices"
              checked={includeInvoices}
              onCheckedChange={(v) => setIncludeInvoices(v === true)}
            />
            <Label htmlFor="purge-invoices" className="text-xs font-normal">Notas fiscais</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="purge-queue"
              checked={includeQueue}
              onCheckedChange={(v) => setIncludeQueue(v === true)}
            />
            <Label htmlFor="purge-queue" className="text-xs font-normal">Fila fiscal (falha/travada)</Label>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={exportAudit} disabled={audit.isLoading}>
              <Download className="mr-1.5 h-4 w-4" /> Auditoria CSV
              {audit.data?.length ? <Badge variant="outline" className="ml-1.5 font-mono">{audit.data.length}</Badge> : null}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportAuditXlsx.mutate()}
              disabled={audit.isLoading || exportAuditXlsx.isPending}
            >
              {exportAuditXlsx.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="mr-1.5 h-4 w-4" />
              )}
              Auditoria Excel
            </Button>
            <Button variant="outline" size="sm" disabled={!canManage} onClick={() => setSelectOpen(true)}>
              <ListChecks className="mr-1.5 h-4 w-4" /> Selecionar itens
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!canManage || purge.isPending || (!includeInvoices && !includeQueue)}
              onClick={() => setConfirmOpen(true)}
            >
              {purge.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1.5 h-4 w-4" />
              )}
              Limpar {eligible > 0 ? `(${eligible})` : ""}
            </Button>
          </div>
        </div>

        {/* ── Agendamento ────────────────────────────────────────────────── */}
        <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium">Limpeza automática</span>
            <Switch
              checked={schedule.enabled}
              disabled={!canManage}
              onCheckedChange={(v) => patchSchedule({ enabled: v })}
              aria-label="Ativar limpeza automática"
            />
            <Select
              value={schedule.frequency}
              disabled={!canManage}
              onValueChange={(v) => patchSchedule({ frequency: v as PurgeFrequency })}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PURGE_FREQUENCY_LABEL) as PurgeFrequency[]).map((f) => (
                  <SelectItem key={f} value={f}>{PURGE_FREQUENCY_LABEL[f]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={schedule.environment}
              disabled={!canManage}
              onValueChange={(v) => patchSchedule({ environment: v as PurgeEnvironment })}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="homologacao">Somente homologação</SelectItem>
                <SelectItem value="producao">Somente produção</SelectItem>
                <SelectItem value="todos">Ambos os ambientes</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={!canManage || runNow.isPending}
              onClick={() => runNow.mutate()}
            >
              {runNow.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Executar agora
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground">
            {schedule.enabled
              ? `Próxima verificação: ${next ? new Date(next).toLocaleString("pt-BR") : "—"} · alvo: ${ENV_LABEL[schedule.environment]}.`
              : "Desligada. Quando ativa, este caixa verifica a cada 15 minutos e limpa automaticamente o ambiente escolhido."}
            {schedule.lastRunAt
              ? ` Última execução: ${new Date(schedule.lastRunAt).toLocaleString("pt-BR")}${schedule.lastResult ? ` — ${schedule.lastResult}` : ""}.`
              : ""}
          </p>
          {schedule.lastError && (
            <p className="text-[11px] text-destructive">Última falha: {schedule.lastError}</p>
          )}
        </div>

        {!canManage && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldAlert className="h-3.5 w-3.5" />
            Apenas administradores e gerentes da loja podem apagar registros fiscais.
          </p>
        )}
      </CardContent>

      <FiscalPurgeSelectDialog
        storeId={storeId}
        environment={environment}
        open={selectOpen}
        onOpenChange={setSelectOpen}
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar registros fiscais?</AlertDialogTitle>
            <AlertDialogDescription>
              Serão removidos até <strong>{eligible}</strong> registro(s) em {ENV_LABEL[environment]}. Notas
              autorizadas ou canceladas em produção permanecem intactas. Esta ação não pode ser desfeita e será
              registrada na auditoria com seu usuário.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => purge.mutate()}>Apagar agora</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <Badge variant="outline" className="mt-1 font-mono">{value ?? "—"}</Badge>
    </div>
  );
}
