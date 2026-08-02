/**
 * Modo Local do servidor fiscal — configuração e diagnóstico feitos NO caixa.
 *
 * Por quê um card separado do resto da tela: os outros testes saem do backend
 * publicado (nuvem), que não alcança `localhost` nem `192.168.x.x`. Quando o
 * motor fiscal roda dentro da loja — inclusive no próprio PC do caixa —, quem
 * precisa testar é este navegador, com a ajuda do Agente Local como ponte.
 *
 * O token do servidor fiscal é gravado no PC (arquivo do agente), não no banco:
 * cada caixa aponta para o motor da sua rede sem espalhar segredo.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  classifyAddress,
  diagnoseFiscalServer,
  getAgentFiscalServer,
  saveAgentFiscalServer,
  type AgentFiscalServer,
  type FiscalDiagnosis,
} from "@/lib/fiscal-server-client";
import {
  Loader2,
  MonitorSmartphone,
  Save,
  Stethoscope,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
} from "lucide-react";

const STATUS_ICON = {
  ok: CheckCircle2,
  aviso: AlertTriangle,
  falha: XCircle,
} as const;

const STATUS_CLASS = {
  ok: "text-primary",
  aviso: "text-muted-foreground",
  falha: "text-destructive",
} as const;

export function LocalFiscalServerCard() {
  const [agent, setAgent] = useState<AgentFiscalServer | null>(null);
  const [loadingAgent, setLoadingAgent] = useState(true);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<FiscalDiagnosis | null>(null);

  // Lê o que já está salvo neste computador. Nunca lança: se o agente estiver
  // fechado o card apenas explica o que fazer.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const info = await getAgentFiscalServer();
      if (!alive) return;
      setAgent(info);
      if (info.url) setUrl(info.url);
      setLoadingAgent(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const address = url.trim() ? classifyAddress(url) : null;

  async function handleSave() {
    if (!address?.url) {
      toast.error("Informe um endereço válido, por exemplo 192.168.0.50:3737.");
      return;
    }
    setSaving(true);
    try {
      // token vazio = manter o atual (não apagar por descuido).
      const next = await saveAgentFiscalServer(address.url, token.trim() ? token.trim() : undefined);
      setAgent(next);
      setToken("");
      toast.success("Servidor fiscal salvo neste computador.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao salvar no Agente Local.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDiagnose() {
    if (!address?.url) {
      toast.error("Informe o endereço do servidor fiscal antes de testar.");
      return;
    }
    setDiagnosing(true);
    setDiagnosis(null);
    try {
      const result = await diagnoseFiscalServer(address.url, token.trim() || undefined);
      setDiagnosis(result);
      if (result.ok) toast.success(result.summary);
      else toast.error(result.summary);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao executar o diagnóstico.");
    } finally {
      setDiagnosing(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphone className="h-4 w-4" /> Modo local (servidor na loja)
        </CardTitle>
        <CardDescription>
          Use quando o motor fiscal Node roda neste caixa ou em outro PC da mesma rede. O teste é feito
          por este navegador com a ponte do Agente Local — a nuvem não alcança endereços internos.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {loadingAgent ? (
            <Badge variant="outline" className="gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Procurando o agente
            </Badge>
          ) : agent?.agentOnline ? (
            <Badge variant="outline" className="gap-1">
              <CheckCircle2 className="h-3 w-3 text-primary" /> Agente ativo
              {agent.agentVersion ? ` · v${agent.agentVersion}` : ""}
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <XCircle className="h-3 w-3 text-destructive" /> Agente fechado
            </Badge>
          )}
          {agent?.url ? (
            <span className="text-muted-foreground">
              Salvo neste PC: <span className="font-mono">{agent.url}</span>
              {agent.tokenSet ? " · token guardado" : " · sem token"}
            </span>
          ) : null}
        </div>

        {!loadingAgent && !agent?.agentOnline ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            {agent?.error ?? "Agente Local indisponível."} Endereços da rede interna (192.168.x.x) só
            funcionam com o agente aberto, porque o navegador bloqueia páginas HTTPS chamando HTTP local.
          </p>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="local-fiscal-url">Endereço do motor fiscal</Label>
            <Input
              id="local-fiscal-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="192.168.0.50:3737"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              {address
                ? address.kind === "invalid"
                  ? "Endereço não reconhecido."
                  : `${address.url} — ${address.note}`
                : "No mesmo PC do caixa use 127.0.0.1:3737. A porta 3737 é o padrão."}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="local-fiscal-token">Token do servidor fiscal</Label>
            <Input
              id="local-fiscal-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={agent?.tokenSet ? "•••••• (mantém o atual)" : "cole o token do console"}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              O servidor imprime o token ao iniciar e o guarda em{" "}
              <span className="font-mono">~/.bastion-pos/fiscal-server-token.txt</span>. Fica salvo só
              neste computador.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={handleSave} disabled={saving || !agent?.agentOnline}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Salvar neste PC
          </Button>
          <Button variant="secondary" onClick={handleDiagnose} disabled={diagnosing}>
            {diagnosing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Stethoscope className="mr-2 h-4 w-4" />
            )}
            Diagnosticar conexão
          </Button>
        </div>

        {diagnosis ? (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={cn("text-sm font-medium", diagnosis.ok ? "text-primary" : "text-destructive")}>
                {diagnosis.summary}
              </p>
              <span className="text-xs text-muted-foreground">
                {diagnosis.transport === "agent"
                  ? "via Agente Local"
                  : diagnosis.transport === "direct"
                    ? "via navegador"
                    : "sem conexão"}{" "}
                · {diagnosis.ranAt}
              </span>
            </div>

            <ul className="space-y-2">
              {diagnosis.checks.map((check) => {
                const Icon = STATUS_ICON[check.status];
                return (
                  <li key={check.key} className="flex gap-2 text-sm">
                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", STATUS_CLASS[check.status])} />
                    <div className="min-w-0">
                      <p className="font-medium">{check.label}</p>
                      {check.detail ? (
                        <p className="break-words text-xs text-muted-foreground">{check.detail}</p>
                      ) : null}
                      {check.fix ? (
                        <p className="break-words text-xs text-muted-foreground">
                          <span className="font-medium">Como resolver:</span> {check.fix}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
