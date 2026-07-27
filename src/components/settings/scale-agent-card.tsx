import { useCallback, useEffect, useState } from "react";
import { Scale, RefreshCw, Plug, PlugZap, FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  autodetectScale,
  connectScale,
  disconnectScale,
  listScalePorts,
  saveScaleConfig,
  testScale,
  type AgentScaleAutodetectResult,
  type AgentScaleConfig,
  type AgentScalePreset,
  type AgentSerialPort,
  type AgentScaleProtocol,
} from "@/lib/scale-agent";


/**
 * Configuração da balança serial pelo Agente Local.
 * Diferente do Web Serial (só Chrome desktop, com prompt), aqui o agente
 * abre a porta COM e o PDV funciona em qualquer navegador/PWA.
 */
export function ScaleAgentCard() {
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [ports, setPorts] = useState<AgentSerialPort[]>([]);
  const [presets, setPresets] = useState<AgentScalePreset[]>([]);
  const [cfg, setCfg] = useState<AgentScaleConfig | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<AgentScaleAutodetectResult | null>(null);


  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listScalePorts();
      setAvailable(r.available);
      setReason(r.reason);
      setPorts(r.ports);
      setPresets(r.presets);
      setCfg(r.config);
      setAgentError(null);
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patch = async (p: Partial<AgentScaleConfig>) => {
    try {
      const r = await saveScaleConfig(p);
      setCfg(r.config);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    void patch({
      protocol: p.protocol,
      baudRate: p.baudRate,
      dataBits: p.dataBits,
      stopBits: p.stopBits,
      parity: p.parity,
    });
  };

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Varre todas as portas COM procurando a balança. É a saída para o caso
   * mais comum de suporte: o operador não sabe em qual COM o conversor
   * USB-Serial foi montado nem qual protocolo o modelo usa.
   */
  const autodetect = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const r = await autodetectScale({ apply: true });
      setScanResult(r);
      if (r.ok && r.candidates[0]) {
        const best = r.candidates[0];
        toast.success(
          `Balança encontrada em ${best.path} (${best.protocol} · ${best.baudRate} baud) — ${best.reading.weightKg.toFixed(3)} kg`,
        );
      } else {
        toast.error(r.error ?? "Nenhuma balança encontrada nas portas seriais.");
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };


  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Scale className="size-4" /> Balança serial (Agente Local)
          </CardTitle>
          <CardDescription>
            Toledo Prix 3/4/5, Filizola, Urano, Elgin, Micheletti e Welmy — via porta COM /
            USB-Serial.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => void autodetect()}
            disabled={scanning || !available}
            className="gap-1"
          >
            <Radar className={scanning ? "size-4 animate-spin" : "size-4"} />
            {scanning ? "Varrendo portas…" : "Detectar automaticamente"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} /> Atualizar
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {agentError && (
          <p className="text-xs rounded border border-destructive/40 bg-destructive/10 p-3 text-destructive">
            {agentError}
          </p>
        )}
        {!agentError && !available && (
          <p className="text-xs rounded border border-border bg-muted/40 p-3 text-muted-foreground">
            {reason ?? "Driver serial indisponível no agente."} Rode <code>npm i serialport</code>{" "}
            na pasta do agente (ou reinstale o Bastion POS Agent 1.7.0+) e reinicie o agente.
          </p>
        )}

        {scanning && (
          <p className="text-xs rounded border border-border bg-muted/40 p-3 text-muted-foreground">
            Testando cada porta com os protocolos Toledo Prix, Filizola, Urano e genérico. Isso pode
            levar até 1 minuto — mantenha a balança ligada e com peso sobre o prato.
          </p>
        )}

        {scanResult && !scanning && (
          <div
            className={
              scanResult.ok
                ? "rounded border border-primary/40 bg-primary/5 p-3 text-xs space-y-2"
                : "rounded border border-destructive/40 bg-destructive/10 p-3 text-xs space-y-2"
            }
          >
            {scanResult.ok && scanResult.candidates[0] ? (
              <p className="font-medium text-foreground">
                Detectada em {scanResult.candidates[0].path} · {scanResult.candidates[0].protocol} ·{" "}
                {scanResult.candidates[0].baudRate} baud — leitura de{" "}
                {scanResult.candidates[0].reading.weightKg.toFixed(3)} kg
                {scanResult.applied ? " (configuração aplicada)" : ""}
              </p>
            ) : (
              <p className="font-medium text-destructive">{scanResult.error}</p>
            )}
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                Ver tentativas ({scanResult.attempts.length} em {scanResult.scannedPorts ?? 0} porta
                {(scanResult.scannedPorts ?? 0) === 1 ? "" : "s"})
              </summary>
              <ul className="mt-2 space-y-1 max-h-48 overflow-auto font-mono text-[11px]">
                {scanResult.attempts.map((a, i) => (
                  <li
                    key={`${a.label}-${i}`}
                    className={a.ok ? "text-foreground" : "text-muted-foreground"}
                  >
                    {a.ok ? "✓" : "×"} {a.label}
                    {a.ok ? ` → ${a.weightKg?.toFixed(3)} kg` : ` — ${a.error}`}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}


        {cfg && (
          <>
            <div className="flex items-center justify-between rounded border border-border p-3">
              <div>
                <Label className="text-sm">Usar balança pelo agente</Label>
                <p className="text-xs text-muted-foreground">
                  Prioriza o agente sobre o Web Serial no PDV.
                </p>
              </div>
              <Switch checked={cfg.enabled} onCheckedChange={(v) => void patch({ enabled: v })} />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label className="text-xs">Porta serial</Label>
                <Select
                  value={cfg.path || undefined}
                  onValueChange={(v) => void patch({ path: v })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue
                      placeholder={ports.length ? "Selecione a porta" : "Nenhuma porta detectada"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {ports.map((p) => (
                      <SelectItem key={p.path} value={p.path}>
                        {p.path} {p.manufacturer ? `· ${p.manufacturer}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Modelo (preset)</Label>
                <Select onValueChange={applyPreset}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Aplicar preset do fabricante" />
                  </SelectTrigger>
                  <SelectContent>
                    {presets.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Protocolo</Label>
                <Select
                  value={cfg.protocol}
                  onValueChange={(v) => void patch({ protocol: v as AgentScaleProtocol })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="prix4-p0">Prix 4/5 · Protocolo 0 (ENQ)</SelectItem>
                    <SelectItem value="prix4-p1">Prix 4/5 · Protocolo 1 (estendido)</SelectItem>
                    <SelectItem value="prix3">Prix 3 / contínuo</SelectItem>
                    <SelectItem value="generic">Genérico (detecção automática)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Baud rate</Label>
                <Select
                  value={String(cfg.baudRate)}
                  onValueChange={(v) => void patch({ baudRate: Number(v) })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[2400, 4800, 9600, 19200, 38400, 115200].map((b) => (
                      <SelectItem key={b} value={String(b)}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Paridade / bits</Label>
                <div className="mt-1 grid grid-cols-3 gap-2">
                  <Select
                    value={cfg.parity}
                    onValueChange={(v) => void patch({ parity: v as AgentScaleConfig["parity"] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">N</SelectItem>
                      <SelectItem value="even">Par</SelectItem>
                      <SelectItem value="odd">Ímpar</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={String(cfg.dataBits)}
                    onValueChange={(v) => void patch({ dataBits: Number(v) })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7">7</SelectItem>
                      <SelectItem value="8">8</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={String(cfg.stopBits)}
                    onValueChange={(v) => void patch({ stopBits: Number(v) })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1</SelectItem>
                      <SelectItem value="2">2</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs">Timeout de leitura (ms)</Label>
                <Input
                  type="number"
                  className="mt-1 font-mono"
                  value={cfg.requestTimeoutMs}
                  onChange={(e) =>
                    void patch({ requestTimeoutMs: Math.max(300, Number(e.target.value) || 2000) })
                  }
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || !cfg.path}
                onClick={() => void run(() => connectScale(), "Balança conectada.")}
              >
                <PlugZap className="size-4" /> Conectar
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => disconnectScale(), "Balança desconectada.")}
              >
                <Plug className="size-4" /> Desconectar
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !cfg.path}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await testScale();
                    if (r.ok && r.reading)
                      toast.success(
                        `Peso lido: ${r.reading.weightKg.toFixed(3)} kg (${r.reading.status})`,
                      );
                    else toast.error(r.error ?? "Falha no teste da balança.");
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <FlaskConical className="size-4" /> Testar pesagem
              </Button>
              {cfg.path && (
                <Badge variant="outline" className="self-center font-mono">
                  {cfg.path}
                </Badge>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
