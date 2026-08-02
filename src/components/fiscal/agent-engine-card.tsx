/**
 * Validação do motor NFC-e no PC do caixa (node-dfe) + instalação assistida.
 *
 * Fala apenas com o Agente Local (127.0.0.1:9100). Nenhum dado sensível
 * (senha do A1, CSC completo) trafega — o agente devolve tudo mascarado.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  validateNfceEngine,
  startNfceEngineInstall,
  getNfceEngineInstallState,
  type EngineValidation,
  type EngineInstallState,
} from "@/lib/nfce-agent";
import { FiscalCheckList } from "@/components/fiscal/fiscal-check-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, Download, Cpu } from "lucide-react";

export function AgentEngineCard() {
  const [validation, setValidation] = useState<EngineValidation | null>(null);
  const [loading, setLoading] = useState(false);
  const [install, setInstall] = useState<EngineInstallState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const runValidation = useCallback(async (silent = false) => {
    setLoading(true);
    try {
      const r = await validateNfceEngine();
      setValidation(r);
      if (!silent) {
        if (r.ok) toast.success(r.summary);
        else toast.error(r.summary);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runValidation(true);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [runValidation]);

  async function handleInstall() {
    const started = await startNfceEngineInstall();
    if (!started.ok) {
      toast.error(started.error ?? "Não foi possível iniciar a instalação.");
      return;
    }
    toast.info("Instalando o motor fiscal no caixa… isso pode levar alguns minutos.");
    setInstall(started.state ?? { running: true, ok: null, error: null, log: [] });

    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const state = await getNfceEngineInstallState();
      if (!state) return;
      setInstall(state);
      if (!state.running) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        if (state.ok) toast.success("Motor fiscal instalado e carregado.");
        else toast.error(state.error ?? "Instalação falhou. Veja o log abaixo.");
        void runValidation(true);
      }
    }, 3000);
  }

  const engineMissing = validation?.checks.some((c) => c.key === "node_dfe" && c.status === "fail");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="h-5 w-5" /> Motor NFC-e no caixa (node-dfe)
        </CardTitle>
        <CardDescription>
          Validação profunda do motor fiscal instalado neste computador: biblioteca, certificado A1, configuração e UF.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {validation && (
            <Badge variant={validation.ready ? "default" : "destructive"} className={validation.ready ? "bg-emerald-600" : ""}>
              {validation.ready ? "Motor pronto" : "Motor com pendências"}
            </Badge>
          )}
          {validation?.versions?.node_dfe && (
            <Badge variant="outline">node-dfe v{validation.versions.node_dfe}</Badge>
          )}
          <Button size="sm" variant="outline" onClick={() => runValidation()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Validar motor
          </Button>
          <Button size="sm" onClick={handleInstall} disabled={!!install?.running}>
            {install?.running ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
            {engineMissing ? "Instalar motor no caixa" : "Reinstalar / atualizar motor"}
          </Button>
        </div>

        {validation?.engineDir && (
          <p className="text-[11px] text-muted-foreground">
            Motor instalado em{" "}
            <span className="font-mono text-foreground break-all">{validation.engineDir}</span>
            {validation.packaged ? " (fora do pacote do agente, pasta gravável)" : null}
            {validation.agentVersion ? ` · agente v${validation.agentVersion}` : null}
          </p>
        )}

        {validation && <FiscalCheckList checks={validation.checks} summary={validation.summary} />}

        {install && install.log.length > 0 && (
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-xs font-medium mb-1">
              Log da instalação {install.running ? "(em andamento…)" : install.ok ? "(concluída)" : "(falhou)"}
            </p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
              {install.log.slice(-40).join("\n")}
            </pre>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Equivale a rodar <code className="font-mono">npm run install:fiscal</code> na pasta do agente. Requer Node.js
          instalado no caixa e o Bastion POS Agent 1.8.1 ou superior aberto.
        </p>
      </CardContent>
    </Card>
  );
}
