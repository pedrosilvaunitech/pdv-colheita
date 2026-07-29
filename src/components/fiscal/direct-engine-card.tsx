/**
 * Card: Motor de Emissão Direta SEFAZ.
 * Permite escolher entre "Agente Local" e "VPS externa" e testar em homologação.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { testHomologacaoViaAgent } from "@/lib/direct-fiscal";
import { pingFiscalServer, validateFiscalServer, type FiscalServerCheck } from "@/lib/fiscal.functions";
import { FiscalCheckList } from "@/components/fiscal/fiscal-check-list";
import { pingPrintAgent } from "@/lib/print-agent";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldCheck, ShieldAlert, Rocket, ServerCog, ListChecks } from "lucide-react";

interface Props {
  storeId: string;
  saleIdForTest?: string | null;
}

export function DirectEngineCard({ storeId, saleIdForTest }: Props) {
  const [engine, setEngine] = useState<"agent_local" | "vps">("agent_local");
  const [vpsUrl, setVpsUrl] = useState("");
  const [vpsSecret, setVpsSecret] = useState("FISCAL_VPS_TOKEN");
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null);
  const [agentVersion, setAgentVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [validating, setValidating] = useState(false);
  const [serverChecks, setServerChecks] = useState<{ summary: string; checks: FiscalServerCheck[] } | null>(null);
  const [lastTest, setLastTest] = useState<{ ok: boolean; msg: string; at: string } | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("fiscal_configs")
        .select("direct_engine, vps_url, vps_auth_secret_name")
        .eq("store_id", storeId)
        .maybeSingle();
      if (data) {
        setEngine((data.direct_engine as "agent_local" | "vps") ?? "agent_local");
        setVpsUrl(data.vps_url ?? "");
        setVpsSecret(data.vps_auth_secret_name ?? "FISCAL_VPS_TOKEN");
      }
    })();
    pingPrintAgent(3000).then((st) => {
      setAgentOnline(!!st.online);
      setAgentVersion(st.version ?? null);
    });
  }, [storeId]);

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("fiscal_configs")
        .update({
          direct_engine: engine,
          vps_url: engine === "vps" ? vpsUrl.trim() || null : null,
          vps_auth_secret_name: engine === "vps" ? (vpsSecret.trim() || "FISCAL_VPS_TOKEN") : null,
        })
        .eq("store_id", storeId);
      if (error) throw error;
      toast.success("Motor de emissão salvo.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao salvar motor.");
    } finally { setSaving(false); }
  }

  /** Health check do servidor fiscal central (executado no backend). */
  async function checkServer() {
    setChecking(true);
    try {
      const r = (await pingFiscalServer({ data: { storeId } })) as { ok: boolean; message: string };
      setLastTest({ ok: r.ok, at: new Date().toLocaleString("pt-BR"), msg: r.message });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastTest({ ok: false, at: new Date().toLocaleString("pt-BR"), msg });
      toast.error(msg);
    } finally {
      setChecking(false);
    }
  }

  /** Rotina completa de validação do servidor fiscal central. */
  async function runServerValidation() {
    setValidating(true);
    try {
      const r = (await validateFiscalServer({ data: { storeId } })) as {
        ok: boolean;
        summary: string;
        checks: FiscalServerCheck[];
      };
      setServerChecks({ summary: r.summary, checks: r.checks });
      if (r.ok) toast.success(r.summary);
      else toast.error(r.summary);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  }

  async function testHomologacao() {
    if (!saleIdForTest) {
      toast.error("Faça uma venda de teste primeiro (ambiente homologação) e clique aqui para reemitir.");
      return;
    }
    setTesting(true);
    try {
      const r = await testHomologacaoViaAgent({ storeId, saleId: saleIdForTest, environment: "homologacao" });
      const at = new Date().toLocaleString("pt-BR");
      if (r.ok) {
        setLastTest({ ok: true, at, msg: `Aprovado em homologação. Chave: ${r.chave ?? "—"} · Protocolo: ${r.protocolo ?? "—"}` });
        toast.success("NFC-e em homologação aprovada!");
      } else {
        setLastTest({ ok: false, at, msg: r.error ?? "Falhou." });
        toast.error(`Homologação recusada: ${r.error ?? "erro desconhecido"}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastTest({ ok: false, at: new Date().toLocaleString("pt-BR"), msg });
      toast.error(msg);
    } finally { setTesting(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="h-5 w-5" /> Motor de Emissão Direta SEFAZ
        </CardTitle>
        <CardDescription>
          Escolha onde a NFC-e será assinada e transmitida. Requer certificado A1, CSC ID e CSC Token cadastrados acima.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <RadioGroup value={engine} onValueChange={(v) => setEngine(v as "agent_local" | "vps")}>
          <div className="flex items-start gap-3 rounded-md border p-3">
            <RadioGroupItem value="agent_local" id="eng-agent" className="mt-1" />
            <div className="flex-1">
              <Label htmlFor="eng-agent" className="font-medium">Agente Local (recomendado para 1 PDV)</Label>
              <p className="text-sm text-muted-foreground">
                O executável do Agente (v1.4+) assina e envia XML direto à SEFAZ deste computador.
              </p>
              <div className="mt-2 flex items-center gap-2 text-xs">
                {agentOnline === null ? (
                  <Badge variant="outline">Verificando…</Badge>
                ) : agentOnline ? (
                  <Badge variant="default" className="bg-emerald-600">Agente online v{agentVersion ?? "?"}</Badge>
                ) : (
                  <Badge variant="destructive">Agente offline — instale/atualize</Badge>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-md border p-3">
            <RadioGroupItem value="vps" id="eng-vps" className="mt-1" />
            <div className="flex-1 space-y-2">
              <Label htmlFor="eng-vps" className="font-medium">
                Servidor fiscal central (recomendado para 2+ caixas)
              </Label>
              <p className="text-sm text-muted-foreground">
                Um único Node com o motor NFC-e (pasta <code className="font-mono text-xs">vps-fiscal/</code>, em
                Docker, Fly.io, Railway ou um PC servidor da loja) recebe as notas de <strong>todos os caixas</strong>.
                O certificado A1 fica só nesse servidor e a numeração continua atômica no banco — dois caixas
                emitindo ao mesmo tempo nunca repetem número.
              </p>
              {engine === "vps" && (
                <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
                  <p className="text-muted-foreground">
                    Endereço configurado:{" "}
                    <span className="font-mono text-foreground">{vpsUrl || "— nenhum —"}</span>
                  </p>
                  <p className="text-muted-foreground">
                    Segredo do token: <span className="font-mono text-foreground">{vpsSecret}</span>
                  </p>
                  <p className="text-muted-foreground">
                    O endereço, o servidor reserva e o token são editados em um lugar só, na tela{" "}
                    <Link to="/servidor-fiscal" className="text-primary underline underline-offset-2">
                      Servidor fiscal
                    </Link>
                    , para não existirem dois valores divergentes.
                  </p>
                </div>
              )}
            </div>
          </div>
        </RadioGroup>

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Salvar motor
          </Button>
          <Button variant="outline" onClick={testHomologacao} disabled={testing || engine !== "agent_local"}>
            {testing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-2" />}
            Testar em homologação
          </Button>
          <Button variant="outline" onClick={checkServer} disabled={checking || engine !== "vps"}>
            {checking ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ServerCog className="h-4 w-4 mr-2" />}
            Testar servidor central
          </Button>
          <Button variant="outline" onClick={runServerValidation} disabled={validating || engine !== "vps"}>
            {validating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ListChecks className="h-4 w-4 mr-2" />}
            Validar servidor central
          </Button>
        </div>

        {serverChecks && <FiscalCheckList checks={serverChecks.checks} summary={serverChecks.summary} />}

        {lastTest && (
          <div className={`rounded-md border p-3 text-sm flex items-start gap-2 ${lastTest.ok ? "border-emerald-500/40 bg-emerald-500/5" : "border-destructive/40 bg-destructive/5"}`}>
            {lastTest.ok ? <ShieldCheck className="h-4 w-4 text-emerald-600 mt-0.5" /> : <ShieldAlert className="h-4 w-4 text-destructive mt-0.5" />}
            <div>
              <div className="font-medium">{lastTest.ok ? "Homologação OK" : "Homologação falhou"}</div>
              <div className="text-muted-foreground text-xs">{lastTest.at}</div>
              <div className="mt-1">{lastTest.msg}</div>
            </div>
          </div>
        )}


        <p className="text-xs text-muted-foreground">
          Guia completo em <code className="font-mono">docs/fiscal-direto-sefaz.md</code>.
          Nunca ative "produção" sem ter uma NFC-e aprovada em homologação.
        </p>
      </CardContent>
    </Card>
  );
}
