import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { createPixCharge, checkPixCharge, confirmPixManually } from "@/lib/pix.functions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Copy, CheckCircle2, Loader2, QrCode, RefreshCw, Settings2, AlertTriangle } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  onPaid: () => void;
  storeId: string;
  amount: number;
  description: string;
}

export function PixChargeModal({ open, onClose, onPaid, storeId, amount, description }: Props) {
  const createFn = useServerFn(createPixCharge);
  const checkFn = useServerFn(checkPixCharge);
  const confirmFn = useServerFn(confirmPixManually);

  const [charge, setCharge] = useState<{ id: string; brcode: string; qr_image: string | null; provider: string; status: string } | null>(null);

  const [configMissing, setConfigMissing] = useState(false);

  const create = useMutation({
    mutationFn: async () => createFn({ data: { storeId, amount, description } }),
    onSuccess: (data) => { setCharge(data as never); setConfigMissing(false); },
    onError: (e: Error) => {
      const msg = e.message || "";
      if (/PIX não configurado|Configure chave PIX/i.test(msg)) { setConfigMissing(true); return; }
      toast.error(msg);
    },
  });

  useEffect(() => {
    if (open && !charge && !create.isPending && !configMissing) create.mutate();
    if (!open) { setCharge(null); setConfigMissing(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Polling automático a cada 4s enquanto pendente
  useQuery({
    queryKey: ["pix_poll", charge?.id],
    enabled: !!charge && charge.status === "pendente" && open,
    refetchInterval: 4000,
    queryFn: async () => {
      const r = await checkFn({ data: { chargeId: charge!.id } });
      if (r.status === "pago") {
        toast.success("PIX confirmado!");
        onPaid();
      }
      setCharge((c) => (c ? { ...c, status: r.status } : c));
      return r;
    },
  });

  const confirmManual = useMutation({
    mutationFn: async () => confirmFn({ data: { chargeId: charge!.id } }),
    onSuccess: () => { toast.success("Pagamento confirmado manualmente"); onPaid(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="size-5" /> Cobrança PIX · {brl(amount)}
          </DialogTitle>
        </DialogHeader>

        {create.isPending && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loader2 className="size-6 animate-spin mx-auto mb-2" /> Gerando QR...
          </div>
        )}

        {configMissing && (
          <div className="border border-warning/40 bg-warning/5 rounded-md p-4 space-y-3">
            <div className="flex items-center gap-2 text-warning font-semibold text-sm">
              <AlertTriangle className="size-4" /> PIX ainda não configurado
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Configure em <strong>Configurações → PIX</strong>. O modo padrão <strong>Estático (chave local)</strong>
              funciona imediatamente — basta informar sua <strong>chave PIX</strong>, <strong>nome</strong> e
              <strong> cidade</strong>. O QR é gerado no PDV com o valor da venda, sem depender de provedor externo.
              Você pode conectar um PSP (Mercado Pago, Asaas) depois para confirmação automática.
            </p>
            <Button asChild size="sm" className="gap-2 w-full">
              <Link to="/configuracoes" search={{ tab: "pix" }} onClick={onClose}>
                <Settings2 className="size-4" /> Abrir configurações do PIX
              </Link>
            </Button>
          </div>
        )}



        {charge && (
          <div className="space-y-3">
            <div className="flex justify-center">
              {charge.qr_image ? (
                <img src={charge.qr_image} alt="QR PIX" className="border border-border rounded bg-white p-2 w-64 h-64" />
              ) : (
                <div className="w-64 h-64 border border-dashed rounded flex items-center justify-center text-xs text-muted-foreground">
                  QR indisponível — use o copia-e-cola abaixo
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-mono uppercase text-muted-foreground">Copia-e-cola</span>
                <button
                  onClick={() => { navigator.clipboard.writeText(charge.brcode); toast.success("Copiado"); }}
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  <Copy className="size-3" /> Copiar
                </button>
              </div>
              <Textarea readOnly rows={3} value={charge.brcode} className="font-mono text-[10px]" />
            </div>

            <div className="flex items-center justify-between border-t pt-3">
              <div className="text-xs">
                <span className="text-muted-foreground">Provedor:</span> <span className="font-mono">{charge.provider}</span>
              </div>
              {charge.status === "pago" ? (
                <Badge className="bg-primary/20 text-primary border-primary/40 gap-1"><CheckCircle2 className="size-3" /> PAGO</Badge>
              ) : (
                <Badge variant="outline" className="border-warning/40 text-warning gap-1">
                  <Loader2 className="size-3 animate-spin" /> aguardando pagamento
                </Badge>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={onClose} className="w-full sm:w-auto">Cancelar</Button>
          {charge && charge.provider === "estatico" && charge.status === "pendente" && (
            <Button onClick={() => confirmManual.mutate()} disabled={confirmManual.isPending} className="w-full sm:w-auto gap-2">
              <CheckCircle2 className="size-4" /> Marcar como pago
            </Button>
          )}
          {charge && charge.status === "pendente" && charge.provider !== "estatico" && (
            <Button variant="outline" onClick={() => checkFn({ data: { chargeId: charge.id } })} className="w-full sm:w-auto gap-2">
              <RefreshCw className="size-4" /> Verificar agora
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function brl(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
