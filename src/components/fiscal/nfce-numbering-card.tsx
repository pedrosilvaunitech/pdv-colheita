import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Hash, RefreshCw, ArrowUpCircle, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  storeId: string;
}

/**
 * Gestão da numeração NFC-e e NF-e.
 * - Mostra o último número emitido (dá segurança contra duplicidade).
 * - Permite ajustar série e próximo número.
 * - Sincroniza o próximo número com base na última nota autorizada da série.
 */
export function NfceNumberingCard({ storeId }: Props) {
  const qc = useQueryClient();
  const [nfceSeries, setNfceSeries] = useState(1);
  const [nfceNext, setNfceNext] = useState(1);
  const [nfeSeries, setNfeSeries] = useState(1);
  const [nfeNext, setNfeNext] = useState(1);

  const { data: config } = useQuery({
    queryKey: ["fiscal-config-numbering", storeId],
    queryFn: async () => {
      const { data } = await supabase
        .from("fiscal_configs")
        .select("nfce_series, nfce_next_number, nfe_series, nfe_next_number")
        .eq("store_id", storeId)
        .maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    if (config) {
      setNfceSeries(Number(config.nfce_series ?? 1));
      setNfceNext(Number(config.nfce_next_number ?? 1));
      setNfeSeries(Number(config.nfe_series ?? 1));
      setNfeNext(Number(config.nfe_next_number ?? 1));
    }
  }, [config]);

  const { data: lastInvoices } = useQuery({
    queryKey: ["fiscal-last-invoices", storeId],
    queryFn: async () => {
      const [nfce, nfe] = await Promise.all([
        supabase
          .from("invoices")
          .select("number, series, status, created_at")
          .eq("store_id", storeId)
          .eq("type", "nfce")
          .in("status", ["autorizada", "rejeitada", "cancelada"])
          .order("number", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("invoices")
          .select("number, series, status, created_at")
          .eq("store_id", storeId)
          .eq("type", "nfe")
          .in("status", ["autorizada", "rejeitada", "cancelada"])
          .order("number", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      return { nfce: nfce.data, nfe: nfe.data };
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (nfceSeries < 1 || nfceNext < 1 || nfeSeries < 1 || nfeNext < 1) {
        throw new Error("Série e próximo número precisam ser ≥ 1.");
      }
      const { error } = await supabase
        .from("fiscal_configs")
        .update({
          nfce_series: nfceSeries,
          nfce_next_number: nfceNext,
          nfe_series: nfeSeries,
          nfe_next_number: nfeNext,
        })
        .eq("store_id", storeId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Numeração salva");
      qc.invalidateQueries({ queryKey: ["fiscal-config-numbering"] });
      qc.invalidateQueries({ queryKey: ["fiscal-config"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function syncNfce() {
    const last = lastInvoices?.nfce;
    if (!last) {
      toast.info("Nenhuma NFC-e emitida ainda. Mantendo o próximo número atual.");
      return;
    }
    const suggested = Number(last.number) + 1;
    setNfceNext(suggested);
    setNfceSeries(Number(last.series));
    toast.success(`Próximo NFC-e ajustado para ${suggested} (série ${last.series}).`);
  }

  function syncNfe() {
    const last = lastInvoices?.nfe;
    if (!last) {
      toast.info("Nenhuma NF-e emitida ainda.");
      return;
    }
    const suggested = Number(last.number) + 1;
    setNfeNext(suggested);
    setNfeSeries(Number(last.series));
    toast.success(`Próximo NF-e ajustado para ${suggested} (série ${last.series}).`);
  }

  const nfceGap =
    lastInvoices?.nfce && Number(lastInvoices.nfce.number) + 1 !== nfceNext
      ? Number(lastInvoices.nfce.number) + 1 - nfceNext
      : 0;

  return (
    <div className="border border-border rounded-md bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Hash className="size-4" /> Numeração fiscal
        </h3>
        <Badge variant="outline" className="font-mono text-[10px]">
          NFC-e · NF-e
        </Badge>
      </div>

      {nfceGap !== 0 && (
        <div className="border border-warning/40 bg-warning/5 rounded-md p-2 text-[11px] text-warning flex items-start gap-2">
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
          <span>
            Divergência: última NFC-e é <b>#{lastInvoices?.nfce?.number}</b> — o próximo deveria ser{" "}
            <b>{Number(lastInvoices?.nfce?.number) + 1}</b>, mas está{" "}
            <b>{nfceNext}</b>. Clique em <b>Sincronizar</b> antes de emitir.
          </span>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold">NFC-e (consumidor)</Label>
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={syncNfce}>
            <RefreshCw className="size-3" /> Sincronizar
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[10px] text-muted-foreground">Série</Label>
            <Input
              type="number"
              min="1"
              value={nfceSeries}
              onChange={(e) => setNfceSeries(Number(e.target.value))}
              className="mt-0.5 font-mono h-8 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Próximo número</Label>
            <Input
              type="number"
              min="1"
              value={nfceNext}
              onChange={(e) => setNfceNext(Number(e.target.value))}
              className="mt-0.5 font-mono h-8 text-xs"
            />
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Última NFC-e emitida:{" "}
          {lastInvoices?.nfce ? (
            <span className="font-mono">
              #{lastInvoices.nfce.number} (série {lastInvoices.nfce.series}) ·{" "}
              {lastInvoices.nfce.status}
            </span>
          ) : (
            <span className="italic">nenhuma</span>
          )}
        </p>
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold">NF-e (empresarial)</Label>
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={syncNfe}>
            <RefreshCw className="size-3" /> Sincronizar
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[10px] text-muted-foreground">Série</Label>
            <Input
              type="number"
              min="1"
              value={nfeSeries}
              onChange={(e) => setNfeSeries(Number(e.target.value))}
              className="mt-0.5 font-mono h-8 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Próximo número</Label>
            <Input
              type="number"
              min="1"
              value={nfeNext}
              onChange={(e) => setNfeNext(Number(e.target.value))}
              className="mt-0.5 font-mono h-8 text-xs"
            />
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Última NF-e emitida:{" "}
          {lastInvoices?.nfe ? (
            <span className="font-mono">
              #{lastInvoices.nfe.number} (série {lastInvoices.nfe.series}) ·{" "}
              {lastInvoices.nfe.status}
            </span>
          ) : (
            <span className="italic">nenhuma</span>
          )}
        </p>
      </div>

      <Button
        size="sm"
        className="w-full gap-2"
        onClick={() => save.mutate()}
        disabled={save.isPending}
      >
        {save.isPending ? (
          <><Loader2 className="size-3 animate-spin" /> Salvando…</>
        ) : (
          <><ArrowUpCircle className="size-3" /> Salvar numeração</>
        )}
      </Button>

      <p className="text-[10px] text-muted-foreground leading-relaxed">
        ⚠️ Após emitir uma nota, o próximo número é <b>irreversível</b> — pular números exige emitir
        um pedido de <b>inutilização</b> na SEFAZ para manter a sequência auditável.
      </p>
    </div>
  );
}
