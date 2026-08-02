/**
 * Painel de limpeza de registros fiscais (homologação e produção).
 *
 * Existe porque a fase de implantação gera lixo inevitável: notas de teste em
 * homologação, rascunhos criados antes do certificado e jobs de fila de vendas
 * fictícias. Sem uma saída controlada, o lojista fica com um painel
 * permanentemente vermelho e perde a capacidade de ver o erro que importa.
 *
 * Restrições deliberadas:
 *  - só gerentes/administradores veem o botão (e a RLS confirma no banco);
 *  - nota AUTORIZADA ou CANCELADA em produção nunca é apagada;
 *  - confirmação explícita, com contagem prévia do que será removido.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eraser, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
import { previewFiscalPurge, purgeFiscalErrors, type PurgeEnvironment } from "@/lib/fiscal-purge";

export interface FiscalPurgeCardProps {
  storeId: string;
  className?: string;
}

export function FiscalPurgeCard({ storeId, className }: FiscalPurgeCardProps) {
  const qc = useQueryClient();
  const { permissions } = useStorePermissions(storeId);
  const [environment, setEnvironment] = useState<PurgeEnvironment>("homologacao");
  const [includeInvoices, setIncludeInvoices] = useState(true);
  const [includeQueue, setIncludeQueue] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const preview = useQuery({
    queryKey: ["fiscal-purge-preview", storeId],
    enabled: Boolean(storeId),
    staleTime: 15_000,
    queryFn: () => previewFiscalPurge(storeId),
  });

  const purge = useMutation({
    mutationFn: () =>
      purgeFiscalErrors(storeId, { environment, includeInvoices, includeQueue }),
    onSuccess: (r) => {
      if (r.total === 0) {
        toast.info("Nada elegível para remoção com os filtros atuais.");
      } else {
        toast.success(
          `${r.invoicesDeleted} nota(s) e ${r.queueDeleted} item(ns) de fila removidos.`,
        );
      }
      for (const key of [
        "fiscal-purge-preview",
        "fiscal-queue",
        "fiscal-errors",
        "fiscal-rejected",
        "fiscal-audit-log",
        "invoices",
        "numbering-audit",
      ]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao limpar registros fiscais"),
    onSettled: () => setConfirmOpen(false),
  });

  const canManage = permissions.canManageSettings || permissions.canAll;
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

      <CardContent className="space-y-4">
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

          <Button
            variant="destructive"
            size="sm"
            className="ml-auto"
            disabled={!canManage || purge.isPending || (!includeInvoices && !includeQueue)}
            onClick={() => setConfirmOpen(true)}
          >
            {purge.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 mr-1.5" />
            )}
            Limpar {eligible > 0 ? `(${eligible})` : ""}
          </Button>
        </div>

        {!canManage && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldAlert className="h-3.5 w-3.5" />
            Apenas administradores e gerentes da loja podem apagar registros fiscais.
          </p>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar registros fiscais?</AlertDialogTitle>
            <AlertDialogDescription>
              Serão removidos até <strong>{eligible}</strong> registro(s) em{" "}
              {environment === "todos" ? "ambos os ambientes" : environment === "producao" ? "produção" : "homologação"}.
              Notas autorizadas ou canceladas em produção permanecem intactas. Esta ação não pode ser desfeita e será
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
