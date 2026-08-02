/**
 * Backup de configuração: exportação seletiva + agendamento automático.
 *
 * Duas necessidades diferentes na mesma tela, de propósito: quem escolhe as
 * seções para exportar é a mesma pessoa que decide o que o backup automático
 * deve levar. Separar em telas faria o lojista configurar duas vezes.
 *
 * O agendamento não baixa arquivo sozinho (navegador bloqueia download sem
 * clique): ele GERA e guarda o backup, e aqui aparece o botão "Baixar".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Archive, Download, Loader2, CalendarClock, ShieldCheck, PlayCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { EXPORT_SECTIONS, exportSelectiveBackup, sectionLabel, type SectionId } from "@/lib/selective-export";
import {
  FREQUENCY_LABEL,
  clearPendingBackup,
  downloadPendingBackup,
  getBackupSchedule,
  getPendingBackup,
  nextRunAt,
  runScheduledBackup,
  setBackupSchedule,
  type BackupFrequency,
  type BackupSchedule,
  type PendingBackup,
} from "@/lib/backup-schedule";
import { logSensitiveChange } from "@/lib/sensitive-audit";

export interface BackupScheduleCardProps {
  storeId: string | null;
  /** Somente gerentes/administradores podem alterar (RBAC da tela). */
  canManage?: boolean;
}

function formatWhen(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("pt-BR");
}

export function BackupScheduleCard({ storeId, canManage = true }: BackupScheduleCardProps) {
  const [schedule, setSchedule] = useState<BackupSchedule>(() => getBackupSchedule(storeId));
  const [selected, setSelected] = useState<SectionId[]>(() => getBackupSchedule(storeId).sections);
  const [pending, setPending] = useState<PendingBackup | null>(null);
  const [exporting, setExporting] = useState(false);
  const [running, setRunning] = useState(false);

  // Recarrega ao trocar de loja e roda o agendamento vencido na abertura.
  useEffect(() => {
    const current = getBackupSchedule(storeId);
    setSchedule(current);
    setSelected(current.sections);
    setPending(getPendingBackup(storeId));
    if (!storeId || !current.enabled) return;
    void (async () => {
      const outcome = await runScheduledBackup(storeId);
      if (outcome.status === "generated") {
        setPending(outcome.pending);
        setSchedule(getBackupSchedule(storeId));
        toast.info("Backup automático gerado", {
          description: "O arquivo está pronto para download nesta tela.",
        });
      } else if (outcome.status === "unchanged") {
        setSchedule(getBackupSchedule(storeId));
      } else if (outcome.status === "error") {
        setSchedule(getBackupSchedule(storeId));
      }
    })();
  }, [storeId]);

  const toggleSection = useCallback(
    (id: SectionId, on: boolean) => {
      setSelected((prev) => {
        const next = on ? [...prev.filter((s) => s !== id), id] : prev.filter((s) => s !== id);
        // Mantém a ordem do catálogo para o arquivo ficar previsível.
        const ordered = EXPORT_SECTIONS.filter((s) => next.includes(s.id)).map((s) => s.id);
        setSchedule((cur) => setBackupSchedule(storeId, { ...cur, sections: ordered }));
        return ordered;
      });
    },
    [storeId],
  );

  const handleExport = useCallback(async () => {
    if (!storeId) return;
    setExporting(true);
    try {
      const { empty } = await exportSelectiveBackup(storeId, selected);
      if (empty.length > 0) {
        toast.warning("Backup gerado com seções vazias", {
          description: `Sem dados salvos em: ${empty.map(sectionLabel).join(", ")}.`,
        });
      } else {
        toast.success("Backup exportado", {
          description: `${selected.length} seção(ões) no arquivo, com hash de verificação.`,
        });
      }
      void logSensitiveChange({
        storeId,
        area: "backup",
        action: "exportou",
        detail: `Seções: ${selected.map(sectionLabel).join(", ")}`,
      });
    } catch (e) {
      toast.error("Falha ao exportar", {
        description: e instanceof Error ? e.message : "Erro inesperado.",
      });
    } finally {
      setExporting(false);
    }
  }, [storeId, selected]);

  const handleRunNow = useCallback(async () => {
    if (!storeId) return;
    setRunning(true);
    try {
      const outcome = await runScheduledBackup(storeId, { force: true });
      setSchedule(getBackupSchedule(storeId));
      if (outcome.status === "generated") {
        setPending(outcome.pending);
        toast.success("Backup gerado", { description: "Clique em Baixar para guardar o arquivo." });
      } else if (outcome.status === "unchanged") {
        toast.info("Nada mudou desde o último backup", {
          description: "Nenhum arquivo novo foi criado — o conteúdo é idêntico.",
        });
      } else if (outcome.status === "error") {
        toast.error("Falha no backup", { description: outcome.message });
      }
      void logSensitiveChange({ storeId, area: "backup", action: "executou_agora" });
    } finally {
      setRunning(false);
    }
  }, [storeId]);

  const handleToggleEnabled = useCallback(
    (on: boolean) => {
      const next = setBackupSchedule(storeId, { enabled: on });
      setSchedule(next);
      void logSensitiveChange({
        storeId,
        area: "backup",
        action: on ? "ativou_agendamento" : "desativou_agendamento",
        detail: `Frequência: ${FREQUENCY_LABEL[next.frequency]}`,
      });
    },
    [storeId],
  );

  const handleFrequency = useCallback(
    (value: string) => {
      const next = setBackupSchedule(storeId, { frequency: value as BackupFrequency });
      setSchedule(next);
      void logSensitiveChange({
        storeId,
        area: "backup",
        action: "alterou_frequencia",
        detail: FREQUENCY_LABEL[next.frequency],
      });
    },
    [storeId],
  );

  const due = useMemo(() => nextRunAt(schedule), [schedule]);
  const disabled = !storeId || !canManage;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Archive className="h-5 w-5 text-primary" aria-hidden="true" />
          Backup de configuração
        </CardTitle>
        <CardDescription>
          Escolha o que exportar e deixe o sistema gerar backups no intervalo definido. Segredos (tokens
          e senhas) nunca entram no arquivo.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Seleção de seções */}
        <div className="space-y-3">
          <Label className="text-sm font-medium">O que incluir</Label>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {EXPORT_SECTIONS.map((section) => {
              const checked = selected.includes(section.id);
              return (
                <label
                  key={section.id}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors",
                    checked ? "border-primary/60 bg-primary/5" : "border-border bg-card hover:bg-muted/40",
                    disabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <Checkbox
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(v) => toggleSection(section.id, v === true)}
                    aria-label={section.label}
                  />
                  <div className="min-w-0 space-y-1">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      {section.label}
                      <Badge variant="outline" className="text-[10px]">
                        {section.scope === "cloud" ? "Loja" : "Este caixa"}
                      </Badge>
                    </p>
                    <p className="text-xs text-muted-foreground">{section.description}</p>
                  </div>
                </label>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void handleExport()} disabled={disabled || exporting || selected.length === 0}>
              {exporting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              Exportar seleção
            </Button>
            <Button variant="outline" onClick={() => void handleRunNow()} disabled={disabled || running}>
              {running ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <PlayCircle className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              Executar backup agora
            </Button>
          </div>
        </div>

        {/* Agendamento */}
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <CalendarClock className="h-4 w-4 text-primary" aria-hidden="true" />
                Backup automático
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Verificado ao abrir o sistema. Se o conteúdo não mudou, nenhum arquivo novo é criado.
              </p>
            </div>
            <Switch
              checked={schedule.enabled}
              disabled={disabled}
              onCheckedChange={handleToggleEnabled}
              aria-label="Ativar backup automático"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Frequência</Label>
              <Select value={schedule.frequency} onValueChange={handleFrequency} disabled={disabled}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(FREQUENCY_LABEL) as BackupFrequency[]).map((f) => (
                    <SelectItem key={f} value={f}>
                      {FREQUENCY_LABEL[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <dl className="space-y-1 text-xs text-muted-foreground">
              <div className="flex justify-between gap-2">
                <dt>Último backup</dt>
                <dd className="text-foreground">{formatWhen(schedule.lastRunAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Próximo</dt>
                <dd className="text-foreground">{schedule.enabled ? formatWhen(due) : "desligado"}</dd>
              </div>
            </dl>
          </div>

          {schedule.lastError && (
            <p className="text-xs text-destructive">Última falha: {schedule.lastError}</p>
          )}

          {pending && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 p-3">
              <div className="min-w-0 text-xs">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                  Backup pronto de {formatWhen(pending.createdAt)}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {pending.sections.map(sectionLabel).join(", ")} · hash {pending.hash.slice(0, 12)}…
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    downloadPendingBackup(pending);
                    void logSensitiveChange({
                      storeId,
                      area: "backup",
                      action: "baixou_automatico",
                      detail: pending.fileName,
                    });
                  }}
                >
                  <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                  Baixar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    clearPendingBackup();
                    setPending(null);
                  }}
                >
                  Descartar
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
