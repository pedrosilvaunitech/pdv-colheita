/**
 * Política de retenção dos dados fiscais + agendamento no servidor (pg_cron).
 *
 * Diferente do agendamento por navegador (que só roda com o PDV aberto), aqui
 * a regra fica no banco e o pg_cron aplica todos os dias às 03:20, mesmo com a
 * loja fechada. A tela mostra a PRÉVIA exata do que será removido antes de
 * qualquer confirmação — o lojista precisa ver o que vai perder.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, CalendarClock, Loader2, PlayCircle, RefreshCw, Save, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
  applyFiscalRetention,
  getFiscalRetention,
  previewFiscalRetention,
  saveFiscalRetention,
  type FiscalRetentionPatch,
  type FiscalRetentionSettings,
} from "@/lib/fiscal-retention";

export interface FiscalRetentionCardProps {
  storeId: string;
  className?: string;
}

export function FiscalRetentionCard({ storeId, className }: FiscalRetentionCardProps) {
  const qc = useQueryClient();
  const { permissions } = useStorePermissions(storeId);
  const canManage = permissions.canManageSettings || permissions.canAll;
  const [draft, setDraft] = useState<FiscalRetentionSettings | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const settings = useQuery({
    queryKey: ["fiscal-retention", storeId],
    enabled: Boolean(storeId),
    queryFn: () => getFiscalRetention(storeId),
  });

  const preview = useQuery({
    queryKey: ["fiscal-retention-preview", storeId],
    enabled: Boolean(storeId),
    staleTime: 15_000,
    queryFn: () => previewFiscalRetention(storeId),
  });

  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const patch = (p: FiscalRetentionPatch) => setDraft((d) => (d ? { ...d, ...p } : d));

  const invalidate = () => {
    for (const key of [
      "fiscal-retention",
      "fiscal-retention-preview",
      "fiscal-purge-preview",
      "fiscal-purge-audit",
      "fiscal-queue",
      "fiscal-errors",
      "invoices",
    ]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const save = useMutation({
    mutationFn: () => {
      if (!draft || !settings.data) throw new Error("Configuração não carregada.");
      return saveFiscalRetention(storeId, settings.data, draft);
    },
    onSuccess: (next) => {
      setDraft(next);
      toast.success("Política de retenção salva. O agendamento do servidor usará estes prazos.");
      invalidate();
    },
    onError: (e: Error) => toast.error("Não foi possível salvar", { description: e.message }),
  });

  const runNow = useMutation({
    mutationFn: () => applyFiscalRetention(storeId),
    onSuccess: (r) => {
      if (r.total === 0 && r.auditRows === 0) toast.info("Nada fora do prazo de retenção.");
      else
        toast.success("Retenção aplicada", {
          description: `${r.homologacaoInvoices + r.producaoInvoices} nota(s), ${r.queueItems} item(ns) de fila e ${r.auditRows} registro(s) de auditoria removidos.`,
        });
      invalidate();
    },
    onError: (e: Error) => toast.error("Falha ao aplicar retenção", { description: e.message }),
  });

  const p = preview.data;
  const d = draft;
  const dirty =
    !!d &&
    !!settings.data &&
    JSON.stringify({ ...d, lastRunAt: null, lastResult: null }) !==
      JSON.stringify({ ...settings.data, lastRunAt: null, lastResult: null });

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Archive className="h-4 w-4" /> Retenção dos dados fiscais
        </CardTitle>
        <CardDescription>
          Define por quantos dias cada tipo de registro é mantido. O servidor executa a limpeza
          automaticamente <strong>todos os dias às 03:20</strong> (pg_cron), sem depender de um caixa aberto.
          Notas <strong>autorizadas ou canceladas em produção nunca são apagadas</strong>.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Prévia do que será limpo */}
        <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Prévia com os prazos salvos</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2"
              onClick={() => void preview.refetch()}
              disabled={preview.isFetching}
            >
              {preview.isFetching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-4 text-xs">
            <Stat label="Notas homologação" value={p?.homologacaoInvoices} />
            <Stat label="Notas produção (não autorizadas)" value={p?.producaoInvoices} />
            <Stat label="Fila fiscal" value={p?.queueItems} />
            <Stat label="Auditoria antiga" value={p?.auditRows} />
          </div>
          {preview.error ? (
            <p className="text-[11px] text-destructive">{(preview.error as Error).message}</p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Total elegível agora: <strong>{p ? p.total + p.auditRows : 0}</strong> registro(s).
            </p>
          )}
        </div>

        {/* Prazos */}
        <div className="grid gap-3 sm:grid-cols-4">
          <DayField
            id="ret-homolog"
            label="Homologação (dias)"
            hint="Notas de teste"
            value={d?.homologRetentionDays}
            min={0}
            disabled={!canManage}
            onChange={(v) => patch({ homologRetentionDays: v })}
          />
          <DayField
            id="ret-prod"
            label="Produção (dias)"
            hint="Só rascunho/rejeitada"
            value={d?.producaoRetentionDays}
            min={1}
            disabled={!canManage || !d?.includeProducao}
            onChange={(v) => patch({ producaoRetentionDays: v })}
          />
          <DayField
            id="ret-queue"
            label="Fila fiscal (dias)"
            hint="Falha/travada"
            value={d?.queueRetentionDays}
            min={0}
            disabled={!canManage}
            onChange={(v) => patch({ queueRetentionDays: v })}
          />
          <DayField
            id="ret-audit"
            label="Auditoria (dias)"
            hint="Mínimo 30"
            value={d?.auditRetentionDays}
            min={30}
            disabled={!canManage}
            onChange={(v) => patch({ auditRetentionDays: v })}
          />
        </div>

        {/* Opções */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="ret-enabled"
              checked={Boolean(d?.enabled)}
              disabled={!canManage}
              onCheckedChange={(v) => patch({ enabled: v })}
            />
            <Label htmlFor="ret-enabled" className="text-xs font-normal">
              <CalendarClock className="mr-1 inline h-3.5 w-3.5" /> Limpeza automática no servidor
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="ret-invoices"
              checked={Boolean(d?.purgeInvoices)}
              disabled={!canManage}
              onCheckedChange={(v) => patch({ purgeInvoices: v === true })}
            />
            <Label htmlFor="ret-invoices" className="text-xs font-normal">Notas fiscais</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="ret-queue-opt"
              checked={Boolean(d?.purgeQueue)}
              disabled={!canManage}
              onCheckedChange={(v) => patch({ purgeQueue: v === true })}
            />
            <Label htmlFor="ret-queue-opt" className="text-xs font-normal">Fila fiscal</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="ret-prod-opt"
              checked={Boolean(d?.includeProducao)}
              disabled={!canManage}
              onCheckedChange={(v) => patch({ includeProducao: v === true })}
            />
            <Label htmlFor="ret-prod-opt" className="text-xs font-normal">
              Incluir produção não autorizada
            </Label>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canManage || runNow.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              {runNow.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <PlayCircle className="mr-1.5 h-4 w-4" />
              )}
              Aplicar agora
            </Button>
            <Button size="sm" disabled={!canManage || !dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
              Salvar
            </Button>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          {d?.enabled
            ? "Agendado no servidor: execução diária às 03:20 (horário do banco)."
            : "Agendamento desligado — a limpeza só acontece quando alguém clicar em “Aplicar agora”."}
          {settings.data?.lastRunAt
            ? ` Última execução: ${new Date(settings.data.lastRunAt).toLocaleString("pt-BR")}${
                settings.data.lastResult ? ` — ${settings.data.lastResult.total} registro(s).` : "."
              }`
            : ""}
        </p>

        {!canManage && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldAlert className="h-3.5 w-3.5" />
            Apenas administradores e gerentes da loja podem alterar a retenção.
          </p>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Aplicar a retenção agora?</AlertDialogTitle>
            <AlertDialogDescription>
              Serão removidos {p ? p.total + p.auditRows : 0} registro(s) fora do prazo configurado
              ({p?.homologacaoInvoices ?? 0} nota(s) de homologação, {p?.producaoInvoices ?? 0} de produção não
              autorizada, {p?.queueItems ?? 0} item(ns) de fila e {p?.auditRows ?? 0} registro(s) de auditoria).
              A ação é registrada na trilha de auditoria e não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => runNow.mutate()}>Aplicar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rounded-md border border-border bg-background px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <Badge variant="outline" className="mt-1 font-mono">{value ?? "—"}</Badge>
    </div>
  );
}

interface DayFieldProps {
  id: string;
  label: string;
  hint: string;
  value?: number;
  min: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

function DayField({ id, label, hint, value, min, disabled, onChange }: DayFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={3650}
        inputMode="numeric"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p className="text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}
