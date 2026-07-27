import { useCallback, useEffect, useState } from "react";
import { CreditCard, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  getTefStatus, isTefEnabled, listTefProviders, saveTefConfig, setTefEnabled,
  type TefConfig, type TefProviderInfo,
} from "@/lib/tef-agent";

/**
 * Configuração da maquininha (PIN Pad TEF) atendida pelo Agente Local.
 * Todos os provedores instalados aparecem aqui; os que exigem SDK proprietário
 * mostram o motivo da indisponibilidade em vez de falhar silenciosamente.
 */
export function TefConfigCard() {
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<TefProviderInfo[]>([]);
  const [cfg, setCfg] = useState<TefConfig | null>(null);
  const [state, setState] = useState<string>("-");
  const [agentError, setAgentError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listTefProviders();
      setProviders(r.providers);
      setCfg(r.config);
      setAgentError(null);
      const st = await getTefStatus().catch(() => null);
      setState(st?.state ?? "-");
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { setEnabled(isTefEnabled()); void refresh(); }, [refresh]);

  const patch = async (p: Partial<TefConfig>) => {
    try {
      const r = await saveTefConfig(p);
      setCfg(r.config);
      toast.success("Configuração do TEF salva no agente.");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><CreditCard className="size-4" /> Maquininha / PIN Pad (TEF)</CardTitle>
          <CardDescription>
            Selecione a adquirente usada no caixa. O SDK oficial do provedor é instalado na pasta do agente.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} /> Atualizar
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {agentError && (
          <p className="text-xs rounded border border-destructive/40 bg-destructive/10 p-3 text-destructive">{agentError}</p>
        )}

        <div className="flex items-center justify-between rounded border border-border p-3">
          <div>
            <Label className="text-sm">Cobrar cartão pelo PIN Pad no PDV</Label>
            <p className="text-xs text-muted-foreground">Bloqueia a venda até a aprovação da transação.</p>
          </div>
          <Switch checked={enabled} onCheckedChange={(v) => { setTefEnabled(v); setEnabled(v); }} />
        </div>

        {cfg && (
          <div className="grid gap-3 md:grid-cols-3">
            <div className="md:col-span-1">
              <Label className="text-xs">Ambiente</Label>
              <Select value={cfg.mode} onValueChange={(v) => void patch({ mode: v as TefConfig["mode"] })}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="homologacao">Homologação</SelectItem>
                  <SelectItem value="producao">Produção</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Timeout da transação (ms)</Label>
              <Input type="number" className="mt-1 font-mono" value={cfg.timeout}
                onChange={(e) => void patch({ timeout: Math.max(15000, Number(e.target.value) || 120000) })} />
            </div>
            <div className="flex items-end">
              <Badge variant="outline" className="font-mono">estado: {state}</Badge>
            </div>
          </div>
        )}

        <div>
          <Label className="text-xs">Provedores disponíveis</Label>
          <div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => void patch({ provider: p.id })}
                className={cn(
                  "rounded border p-3 text-left transition-colors hover:bg-accent/50",
                  p.active ? "border-primary bg-primary/5" : "border-border",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{p.name}</span>
                  {p.available
                    ? <CheckCircle2 className="size-4 text-primary" />
                    : <AlertTriangle className="size-4 text-muted-foreground" />}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground line-clamp-3">
                  {p.available ? "SDK detectado — pronto para transacionar." : (p.reason ?? "SDK não instalado no agente.")}
                </p>
                {p.active && <Badge className="mt-2" variant="secondary">Ativo</Badge>}
              </button>
            ))}
            {!providers.length && !agentError && (
              <p className="text-xs text-muted-foreground">Nenhum provedor carregado pelo agente.</p>
            )}
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground leading-relaxed border border-border rounded p-3">
          Use <strong>Genérico (simulador)</strong> para homologar todo o fluxo do PDV sem hardware.
          Para produção, contrate a integração TEF com a adquirente, instale o SDK/DLL na pasta do
          agente e selecione o provedor acima — o PDV não muda.
        </p>
      </CardContent>
    </Card>
  );
}
