/// <reference types="w3c-web-serial" />
import { useEffect, useState } from "react";
import { Scale, Plug, PlugZap, Settings2 } from "lucide-react";
import { getHardwareErrorMessage } from "@/lib/hardware-errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useToledoScale } from "@/hooks/use-toledo-scale";
import type { ToledoProtocol } from "@/lib/toledo-scale";
import { getBrowserDeviceFeatureState } from "@/lib/browser-device-permissions";

/**
 * Widget compacto para o cabeçalho do PDV.
 * - Mostra status da balança e último peso lido.
 * - Botão "Ler peso" solicita ENQ e devolve o peso via callback.
 * - Configuração (protocolo, baud) em dialog.
 */
export function ScaleWidget({ onWeight }: { onWeight?: (kg: number) => void }) {
  const { supported, connected, reading, config, error, connect, disconnect, requestWeight, updateConfig } = useToledoScale();
  const [busy, setBusy] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false);
  const serialState = getBrowserDeviceFeatureState("serial");

  useEffect(() => { if (error) toast.error(error); }, [error]);

  const doRead = async () => {
    setBusy(true);
    try {
      const r = await requestWeight();
      if (r.status === "overload") { toast.error("Balança em sobrecarga"); return; }
      if (r.status === "unstable") { toast.warning("Peso instável — aguarde estabilizar"); return; }
      if (r.weightKg <= 0) { toast.error("Peso zero na balança"); return; }
      onWeight?.(r.weightKg);
      toast.success(`Peso: ${r.weightKg.toFixed(3)} kg`);
    } catch (e) {
      toast.error(getHardwareErrorMessage(e, "serial"));
    } finally { setBusy(false); }
  };

  if (!supported) {
    return (
      <Button variant="outline" size="sm" disabled title={serialState.message}>
        <Scale className="size-4" /> Balança
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {connected ? (
        <>
          <Button variant="outline" size="sm" onClick={doRead} disabled={busy} title="Ler peso da balança (ENQ)">
            <PlugZap className="size-4 text-primary" />
            {reading ? (
              <span className="font-mono">{reading.weightKg.toFixed(3)} kg</span>
            ) : (
              <span>Ler peso</span>
            )}
          </Button>
          <Button variant="ghost" size="icon" onClick={disconnect} title="Desconectar balança">
            <Plug className="size-4 text-muted-foreground" />
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" onClick={connect} title="Conectar à porta serial da balança Toledo">
          <Scale className="size-4" /> Conectar balança
        </Button>
      )}

      <Dialog open={cfgOpen} onOpenChange={setCfgOpen}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon" title="Configurar balança">
            <Settings2 className="size-4" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader><DialogTitle>Balança Toledo</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Protocolo</Label>
              <Select value={config.protocol} onValueChange={(v) => updateConfig({ protocol: v as ToledoProtocol })}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="prix4-p0">Toledo Prix 4/5 · Protocolo 0 (ENQ)</SelectItem>
                  <SelectItem value="prix4-p1">Toledo Prix 4/5 · Protocolo 1 (estendido)</SelectItem>
                  <SelectItem value="prix3">Toledo Prix 3 (contínuo)</SelectItem>
                  <SelectItem value="generic">Genérico (detecção automática)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Baud rate</Label>
                <Select value={String(config.baudRate)} onValueChange={(v) => updateConfig({ baudRate: Number(v) })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[2400, 4800, 9600, 19200, 38400].map((b) => (
                      <SelectItem key={b} value={String(b)}>{b}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Paridade</Label>
                <Select value={config.parity} onValueChange={(v) => updateConfig({ parity: v as ParityType })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nenhuma</SelectItem>
                    <SelectItem value="even">Par</SelectItem>
                    <SelectItem value="odd">Ímpar</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Data bits</Label>
                <Select value={String(config.dataBits)} onValueChange={(v) => updateConfig({ dataBits: Number(v) as 7 | 8 })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">7</SelectItem>
                    <SelectItem value="8">8</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Stop bits</Label>
                <Select value={String(config.stopBits)} onValueChange={(v) => updateConfig({ stopBits: Number(v) as 1 | 2 })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="2">2</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs">Timeout de leitura (ms)</Label>
              <Input type="number" className="mt-1 font-mono" value={config.requestTimeoutMs}
                onChange={(e) => updateConfig({ requestTimeoutMs: Math.max(200, Number(e.target.value) || 1500) })} />
            </div>
            <div className="text-[11px] text-muted-foreground border border-border rounded p-3 leading-relaxed">
              <strong>Padrões Toledo:</strong> Prix 4/5 usa 9600 · 8N1 e responde a ENQ (0x05).
              Prix 3 transmite continuamente sem requisição — selecione "Prix 3" se sua balança
              enviar peso sem que você aperte nada. Suporta USB→Serial (FTDI/CH340) e serial RS-232
              nativo. É necessário Chrome/Edge desktop (não funciona em Firefox/Safari).
            </div>
            {reading && (
              <div className="text-xs font-mono border border-border rounded p-2 bg-muted/30">
                Última leitura: {reading.weightKg.toFixed(3)} kg · status {reading.status} · raw "{reading.raw}"
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
