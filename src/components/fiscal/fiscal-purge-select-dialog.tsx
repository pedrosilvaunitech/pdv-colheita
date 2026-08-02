/**
 * Seleção item a item para limpeza fiscal.
 *
 * A limpeza em lote resolve o caso comum ("apagar tudo de homologação"), mas o
 * gerente às vezes quer preservar uma rejeição específica como evidência para o
 * contador e apagar só o resto. Aqui ele vê cada registro elegível, com motivo
 * e data, e escolhe o que remover.
 *
 * A lista só mostra o que o banco aceitaria apagar — nota autorizada em
 * produção nunca aparece, para não criar a expectativa de uma exclusão que a
 * RLS vai recusar.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { listPurgeableRecords, purgeFiscalErrors, type PurgeEnvironment } from "@/lib/fiscal-purge";

export interface FiscalPurgeSelectDialogProps {
  storeId: string;
  environment: PurgeEnvironment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("pt-BR");
};

export function FiscalPurgeSelectDialog({
  storeId,
  environment,
  open,
  onOpenChange,
}: FiscalPurgeSelectDialogProps) {
  const qc = useQueryClient();
  const [invoiceIds, setInvoiceIds] = useState<string[]>([]);
  const [jobIds, setJobIds] = useState<string[]>([]);

  const records = useQuery({
    queryKey: ["fiscal-purgeable", storeId, environment],
    enabled: open && Boolean(storeId),
    queryFn: () => listPurgeableRecords(storeId, environment),
  });

  // Trocar de ambiente ou reabrir o diálogo não deve manter seleção antiga.
  useEffect(() => {
    setInvoiceIds([]);
    setJobIds([]);
  }, [environment, open]);

  const invoices = records.data?.invoices ?? [];
  const jobs = records.data?.jobs ?? [];
  const selectedCount = invoiceIds.length + jobIds.length;

  const allSelected = useMemo(
    () =>
      invoices.length + jobs.length > 0 &&
      invoiceIds.length === invoices.length &&
      jobIds.length === jobs.length,
    [invoices, jobs, invoiceIds, jobIds],
  );

  const toggleAll = () => {
    if (allSelected) {
      setInvoiceIds([]);
      setJobIds([]);
      return;
    }
    setInvoiceIds(invoices.map((i) => i.id));
    setJobIds(jobs.map((j) => j.id));
  };

  const toggle = (list: string[], setList: (v: string[]) => void, id: string) => {
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  const purge = useMutation({
    mutationFn: () =>
      purgeFiscalErrors(storeId, {
        environment,
        includeInvoices: invoiceIds.length > 0,
        includeQueue: jobIds.length > 0,
        ...(invoiceIds.length > 0 ? { invoiceIds } : {}),
        ...(jobIds.length > 0 ? { queueIds: jobIds } : {}),
      }),
    onSuccess: (r) => {
      toast.success(`${r.invoicesDeleted} nota(s) e ${r.queueDeleted} item(ns) removidos.`);
      for (const key of [
        "fiscal-purgeable",
        "fiscal-purge-preview",
        "fiscal-purge-audit",
        "fiscal-queue",
        "fiscal-errors",
        "fiscal-rejected",
        "fiscal-audit-log",
        "invoices",
      ]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao apagar selecionados"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Selecionar registros fiscais para apagar</DialogTitle>
          <DialogDescription>
            Apenas registros que o banco permite remover aparecem aqui. Notas autorizadas ou canceladas em produção
            ficam de fora por obrigação fiscal.
          </DialogDescription>
        </DialogHeader>

        {records.isLoading ? (
          <div className="py-10 text-center text-xs text-muted-foreground">
            <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" /> Carregando registros…
          </div>
        ) : invoices.length + jobs.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Nenhum registro elegível neste ambiente.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs">
              <Checkbox id="purge-all" checked={allSelected} onCheckedChange={toggleAll} />
              <label htmlFor="purge-all" className="cursor-pointer">Selecionar tudo</label>
              <Badge variant="outline" className="ml-auto font-mono">{selectedCount} selecionado(s)</Badge>
            </div>

            <ScrollArea className="h-[380px] rounded-md border">
              <div className="divide-y divide-border">
                {invoices.map((inv) => (
                  <label key={inv.id} className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40">
                    <Checkbox
                      checked={invoiceIds.includes(inv.id)}
                      onCheckedChange={() => toggle(invoiceIds, setInvoiceIds, inv.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-medium">{inv.label}</span>
                        <Badge variant="outline" className="text-[10px] uppercase">{inv.environment}</Badge>
                        <Badge variant="outline" className="text-[10px] uppercase">{inv.status}</Badge>
                        <span className="ml-auto text-[11px] text-muted-foreground">{fmt(inv.createdAt)}</span>
                      </div>
                      {inv.reason && (
                        <p className="mt-1 break-words font-mono text-[11px] text-destructive">{inv.reason}</p>
                      )}
                    </div>
                  </label>
                ))}

                {jobs.map((job) => (
                  <label key={job.id} className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40">
                    <Checkbox
                      checked={jobIds.includes(job.id)}
                      onCheckedChange={() => toggle(jobIds, setJobIds, job.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-medium">
                          Fila · venda #{job.saleId.slice(0, 8).toUpperCase()}
                        </span>
                        <Badge variant="outline" className="text-[10px] uppercase">{job.status}</Badge>
                        <span className="text-[11px] text-muted-foreground">{job.attempts} tentativa(s)</span>
                        <span className="ml-auto text-[11px] text-muted-foreground">{fmt(job.createdAt)}</span>
                      </div>
                      {job.lastError && (
                        <p className="mt-1 break-words font-mono text-[11px] text-destructive">{job.lastError}</p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </ScrollArea>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button
            variant="destructive"
            disabled={selectedCount === 0 || purge.isPending}
            onClick={() => purge.mutate()}
          >
            {purge.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-1.5 h-4 w-4" />
            )}
            Apagar selecionados ({selectedCount})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
