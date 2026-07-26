import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Loader2, History } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { openCashDrawer, type DrawerReason } from "@/lib/cash-drawer";

const REASONS: { value: DrawerReason; label: string }[] = [
  { value: "manual", label: "Abertura manual" },
  { value: "sangria", label: "Sangria" },
  { value: "suprimento", label: "Suprimento / troco inicial" },
  { value: "troca", label: "Troca / devolução" },
  { value: "teste", label: "Teste do equipamento" },
];

export interface CashDrawerButtonProps {
  storeId: string | null | undefined;
  /** Variação compacta para a barra do PDV. */
  compact?: boolean;
  className?: string;
}

/**
 * Abre a gaveta ligada à impressora térmica, exigindo um motivo — toda
 * abertura fica registrada com operador, terminal e horário para auditoria.
 */
export function CashDrawerButton({ storeId, compact = false, className }: CashDrawerButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<DrawerReason>("manual");
  const qc = useQueryClient();

  const history = useQuery({
    queryKey: ["drawer-events", storeId],
    enabled: !!storeId && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("drawer_events")
        .select("id, reason, automatic, channel, success, error_message, created_at")
        .eq("store_id", storeId!)
        .order("created_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      return data ?? [];
    },
  });

  const fire = useMutation({
    mutationFn: async () => openCashDrawer({ storeId, reason, automatic: false }),
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(`Gaveta aberta via ${r.channel === "agent" ? "Agente Local" : r.channel.toUpperCase()}`);
        setOpen(false);
      } else {
        toast.error(`Não foi possível abrir a gaveta: ${r.error ?? "sem canal disponível"}`);
      }
      qc.invalidateQueries({ queryKey: ["drawer-events"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao abrir gaveta"),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size={compact ? "sm" : "default"} className={className}>
          <Archive className="size-4" />
          <span className={compact ? "ml-1.5 hidden sm:inline" : "ml-2"}>Abrir gaveta</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Abrir gaveta de dinheiro</DialogTitle>
          <DialogDescription>
            O pulso é enviado à impressora térmica, que libera a gaveta pelo conector RJ11/RJ12. A abertura fica registrada com seu usuário e o terminal.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="drawer-reason">Motivo</Label>
          <Select value={reason} onValueChange={(v) => setReason(v as DrawerReason)}>
            <SelectTrigger id="drawer-reason"><SelectValue /></SelectTrigger>
            <SelectContent>
              {REASONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {(history.data?.length ?? 0) > 0 && (
          <div className="border border-border rounded-md">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs font-medium">
              <History className="size-3.5" /> Últimas aberturas
            </div>
            <ul className="max-h-40 overflow-auto divide-y divide-border text-[11px]">
              {history.data!.map((e) => (
                <li key={e.id} className="px-3 py-1.5 flex items-center justify-between gap-2">
                  <span className="truncate">
                    {REASONS.find((r) => r.value === e.reason)?.label ?? e.reason}
                    {e.automatic ? " · automática" : ""}
                  </span>
                  <span className={e.success ? "text-muted-foreground" : "text-destructive"}>
                    {new Date(e.created_at).toLocaleTimeString("pt-BR")}
                    {e.success ? "" : " · falhou"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={() => fire.mutate()} disabled={fire.isPending}>
            {fire.isPending ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Archive className="size-4 mr-2" />}
            Abrir gaveta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
