import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DiagnosticRow, type DiagStatus } from "@/components/settings/diagnostic-row";
import {
  fetchAgentDiagnostics,
  getBrowserCapabilities,
  type AgentDiagnostics,
} from "@/lib/agent-diagnostics";

const MIN_AGENT_VERSION = "1.7.0";

/** Comparação semântica simples (major.minor.patch) para exigir versão mínima. */
function versionGte(current: string, min: string): boolean {
  const a = current.split(".").map((n) => Number(n) || 0);
  const b = min.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

function bool(v: boolean | undefined, whenTrue: DiagStatus = "ok", whenFalse: DiagStatus = "fail") {
  return v ? whenTrue : whenFalse;
}

/**
 * Painel único de diagnóstico do caixa: navegador + agente + hardware.
 * Serve como primeira parada em qualquer chamado de suporte.
 */
export function AgentDiagnosticsCard() {
  const [data, setData] = useState<AgentDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const caps = getBrowserCapabilities();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchAgentDiagnostics());
      setError(null);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copyReport = async () => {
    const report = JSON.stringify(
      { at: new Date().toISOString(), browser: caps, agent: data ?? { error } },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(report);
      toast.success("Relatório copiado — cole no chamado de suporte.");
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto manualmente.");
    }
  };

  const onWindows = data?.system.platform === "win32";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4" /> Diagnóstico do Agente Local
            </CardTitle>
            <CardDescription>
              Estado do navegador, do agente e do hardware conectado a este terminal.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void copyReport()}>
              <Copy className="size-4" /> Copiar relatório
            </Button>
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} /> Rodar diagnóstico
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {error && (
            <p className="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {error}
            </p>
          )}

          <section>
            <h3 className="mb-1 text-sm font-semibold text-foreground">Navegador / PWA</h3>
            <DiagnosticRow
              label="Contexto seguro (HTTPS ou localhost)"
              status={bool(caps.secureContext)}
              hint="Sem HTTPS o navegador bloqueia WebUSB, Web Serial e o acesso ao agente local."
            />
            <DiagnosticRow
              label="WebUSB disponível"
              status={bool(caps.webusb, "ok", "warn")}
              hint="Impressão direta sem agente. Indisponível em Firefox, Safari e iOS."
            />
            <DiagnosticRow
              label="Web Serial disponível"
              status={bool(caps.webserial, "ok", "warn")}
              hint="Balança sem agente. Só em Chrome/Edge desktop."
            />
            <DiagnosticRow
              label="Modo aplicativo (PWA instalado)"
              status={caps.standalone ? "ok" : "warn"}
              hint="Recomendado no caixa: evita barra de endereço e fecha acidental de aba."
            />
          </section>

          <section>
            <h3 className="mb-1 text-sm font-semibold text-foreground">Agente Local</h3>
            <DiagnosticRow
              label="Agente respondendo em 127.0.0.1:9100"
              status={bool(!!data)}
              value={data?.version ? `v${data.version}` : undefined}
              hint={
                data
                  ? "Comunicação HTTP local estabelecida."
                  : "Abra o Bastion POS Agent no PC do caixa (ícone na bandeja do sistema)."
              }
            />
            {data && (
              <>
                <DiagnosticRow
                  label={`Versão mínima suportada (${MIN_AGENT_VERSION})`}
                  status={versionGte(data.version, MIN_AGENT_VERSION) ? "ok" : "warn"}
                  value={`v${data.version}`}
                  hint="Versões antigas não têm autodetecção de porta nem diagnóstico."
                />
                <DiagnosticRow
                  label="Executando como administrador"
                  status={data.system.elevated ? "ok" : "warn"}
                  hint="Sem elevação o acesso USB bruto e a troca de driver podem falhar no Windows."
                />
                <DiagnosticRow
                  label="Pasta de configuração gravável"
                  status={bool(data.system.dataDirWritable)}
                  value={data.system.dataDir}
                  hint="Guarda config da balança, TEF e certificado. Perfis com GPO restritiva bloqueiam a escrita."
                />
                <DiagnosticRow
                  label="Sistema"
                  status="unknown"
                  value={`${data.system.platform} ${data.system.arch} · Node ${data.system.node}`}
                  hint={`${data.system.hostname} · no ar há ${Math.floor(data.system.uptime_s / 60)} min`}
                />
              </>
            )}
          </section>

          {data && (
            <section>
              <h3 className="mb-1 text-sm font-semibold text-foreground">Módulos do agente</h3>
              <DiagnosticRow
                label="Spooler de impressão do sistema"
                status={bool(data.modules.spooler, "ok", "warn")}
                hint="Canal preferido de impressão: usa o driver oficial da impressora."
              />
              <DiagnosticRow
                label="USB bruto (libusb)"
                status={bool(data.modules.usb, "ok", "warn")}
                hint={
                  onWindows
                    ? "Precisa de driver WinUSB (Zadig) na impressora quando o spooler não é usado."
                    : "No Linux exige regra udev para o dispositivo."
                }
              />
              <DiagnosticRow
                label="Driver serial (balança)"
                status={bool(data.modules.scale, "ok", "warn")}
                hint={data.scale.reason ?? "Módulo serialport carregado."}
              />
              <DiagnosticRow
                label="Motor NFC-e (node-dfe)"
                status={bool(data.modules.nfce, "ok", "warn")}
                hint="Necessário para emissão fiscal direta pelo agente."
              />
              <DiagnosticRow
                label="Módulo TEF (PIN Pad)"
                status={bool(data.modules.tef, "ok", "warn")}
                value={data.tef?.provider}
                hint={data.tef?.error ?? "Gerenciador de maquininhas carregado."}
              />
            </section>
          )}

          {data && (
            <section>
              <h3 className="mb-1 text-sm font-semibold text-foreground">Hardware detectado</h3>
              <DiagnosticRow
                label="Impressoras disponíveis"
                status={data.printers.length ? "ok" : "fail"}
                value={String(data.printers.length)}
                hint={
                  data.printers.length
                    ? data.printers.map((p) => `${p.name} (${p.source})`).join(" · ")
                    : "Nenhuma impressora no spooler nem no USB. Verifique cabo e driver."
                }
              />
              <DiagnosticRow
                label="Portas seriais encontradas"
                status={(data.scale.ports?.length ?? 0) > 0 ? "ok" : "warn"}
                value={String(data.scale.ports?.length ?? 0)}
                hint={
                  data.scale.ports?.length
                    ? data.scale.ports.map((p) => `${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ""}`).join(" · ")
                    : "Conecte o cabo USB-Serial e instale o driver (Prolific / FTDI / CH340)."
                }
              />
              <DiagnosticRow
                label="Balança conectada"
                status={data.scale.connected ? "ok" : "warn"}
                value={data.scale.config?.path || undefined}
                hint={
                  data.scale.lastError ??
                  (data.scale.connected
                    ? `${data.scale.config?.protocol} · ${data.scale.config?.baudRate} baud`
                    : "Use 'Detectar automaticamente' em Configurações → Hardware.")
                }
              />
            </section>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
