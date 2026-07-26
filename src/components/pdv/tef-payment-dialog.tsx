import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CreditCard, Loader2, CheckCircle2, XCircle, Settings2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  startTefSale, cancelTefSale, subscribeTefEvents, listTefProviders, saveTefConfig,
  TEF_STATE_LABEL,
  type TefState, type TefResult, type TefPaymentType, type TefProviderInfo, type TefConfig,
} from "@/lib/tef-agent";

export interface TefPaymentDialogProps {
  open: boolean;
  amount: number;
  paymentType: TefPaymentType;
  installments: number;
  orderId: string;
  operator?: string | null;
  terminal?: string | null;
  onClose: () => void;
  onApproved: (result: TefResult) => void;
}

const TERMINAL_STATES: TefState[] = ["approved", "denied", "cancelled", "timeout", "error"];

/** Modal de pagamento via PIN Pad — reflete em tempo real o estado do TEF. */
export function TefPaymentDialog({
  open, amount, paymentType, installments, orderId, operator, terminal, onClose, onApproved,
}: TefPaymentDialogProps) {
  const [state, setState] = useState<TefState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<TefResult | null>(null);
  const [running, setRunning] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [providers, setProviders] = useState<TefProviderInfo[]>([]);
  const [config, setConfig] = useState<TefConfig | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedRef = useRef(false);

  const activeProvider = useMemo(() => providers.find((p) => p.active) ?? null, [providers]);

  // Carrega provedores toda vez que abre — o agente pode ter mudado.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listTefProviders()
      .then((r) => { if (!cancelled) { setProviders(r.providers ?? []); setConfig(r.config ?? null); } })
      .catch((e: unknown) => { if (!cancelled) setMessage(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [open]);

  // Stream de eventos do fluxo (SSE).
  useEffect(() => {
    if (!open) return;
    return subscribeTefEvents((ev) => {
      if (!ev.state) return;
      setState(ev.state);
      if (ev.message) setMessage(ev.message);
    });
  }, [open]);

  // Cronômetro da operação.
  useEffect(() => {
    if (!open || !running) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [open, running]);

  // Reset ao abrir.
  useEffect(() => {
    if (open) { setState("idle"); setMessage(null); setResult(null); setElapsed(0); startedRef.current = false; }
  }, [open]);

  const run = async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setRunning(true);
    setMessage(null);
    setResult(null);
    setElapsed(0);
    try {
      const r = await startTefSale({ amount, paymentType, installments, orderId, operator, terminal });
      setResult(r);
      setState(r.success ? "approved" : "denied");
      setMessage(r.message ?? null);
      if (r.success) {
        toast.success(`Cartão aprovado · NSU ${r.nsu ?? "—"}`);
        onApproved(r);
      } else {
        toast.error(r.message || "Transação recusada");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState("error");
      setMessage(msg);
      toast.error(msg);
    } finally {
      setRunning(false);
      startedRef.current = false;
    }
  };

  const abort = async () => {
    try { await cancelTefSale(result?.nsu); toast.info("Operação cancelada no PIN Pad"); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setRunning(false); setState("cancelled"); }
  };

  const changeProvider = async (id: string) => {
    try {
      const r = await saveTefConfig({ provider: id });
      setConfig(r.config);
      const list = await listTefProviders();
      setProviders(list.providers ?? []);
      toast.success(`Provedor TEF: ${id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const done = TERMINAL_STATES.includes(state) && !running;
  const blocked = activeProvider && !activeProvider.available;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !running) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="size-5" />
            Pagamento {paymentType === "credit" ? "Crédito" : "Débito"} · TEF
          </DialogTitle>
          <DialogDescription className="font-mono">
            {brl(amount)}{installments > 1 ? ` · ${installments}x de ${brl(amount / installments)}` : ""} · pedido {orderId}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground font-mono uppercase">Provedor</span>
              <Badge variant={blocked ? "destructive" : "secondary"}>{activeProvider?.name ?? config?.provider ?? "—"}</Badge>
              {config?.mode && <Badge variant="outline">{config.mode}</Badge>}
            </div>
            <Button type="button" size="sm" variant="ghost" className="h-7 gap-1" onClick={() => setShowConfig((v) => !v)}>
              <Settings2 className="size-3.5" /> Configurar
            </Button>
          </div>

          {showConfig && (
            <div className="rounded-md border border-border p-3 space-y-2">
              <div className="text-[10px] font-mono uppercase text-muted-foreground">Provedor TEF ativo</div>
              <Select value={config?.provider ?? ""} onValueChange={changeProvider}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}{p.available ? "" : " · SDK ausente"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={config?.mode ?? "homologacao"} onValueChange={(v) => saveTefConfig({ mode: v as TefConfig["mode"] }).then((r) => setConfig(r.config)).catch(() => undefined)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="homologacao">Homologação</SelectItem>
                  <SelectItem value="producao">Produção</SelectItem>
                </SelectContent>
              </Select>
              {blocked && (
                <p className="text-[11px] text-destructive leading-snug flex gap-1.5">
                  <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                  {activeProvider?.reason}
                </p>
              )}
            </div>
          )}

          <div className="rounded-md border border-border bg-muted/30 p-5 text-center space-y-2">
            <StateIcon state={state} running={running} />
            <div className="text-base font-semibold">{TEF_STATE_LABEL[state]}</div>
            {running && <div className="text-xs font-mono text-muted-foreground">{elapsed}s</div>}
            {message && <p className="text-xs text-muted-foreground break-words">{message}</p>}
            {result?.success && (
              <div className="text-[11px] font-mono text-muted-foreground">
                NSU {result.nsu} · AUT {result.authorizationCode} · {result.cardBrand}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {running ? (
            <Button variant="destructive" onClick={abort}>Cancelar no PIN Pad</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>{done && result?.success ? "Fechar" : "Desistir"}</Button>
              {!result?.success && (
                <Button onClick={run} disabled={!!blocked}>
                  {state === "idle" ? "Iniciar pagamento" : "Tentar novamente"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StateIcon({ state, running }: { state: TefState; running: boolean }) {
  if (state === "approved") return <CheckCircle2 className="size-10 mx-auto text-success" />;
  if (["denied", "error", "timeout"].includes(state)) return <XCircle className="size-10 mx-auto text-destructive" />;
  if (running) return <Loader2 className="size-10 mx-auto animate-spin text-primary" />;
  return <CreditCard className="size-10 mx-auto text-muted-foreground" />;
}

function brl(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
