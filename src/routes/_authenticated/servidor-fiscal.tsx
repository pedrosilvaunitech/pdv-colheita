/**
 * Configuração do Servidor Fiscal Node (IP ou domínio).
 *
 * Esta é a tela onde o lojista informa ONDE roda o Node que assina e
 * transmite a NFC-e (pasta `vps-fiscal/`). Aceita tanto um IP da rede local
 * (`192.168.0.50:3737`) quanto um domínio público
 * (`https://fiscal.suaempresa.com.br`) — o esquema é completado quando
 * ausente, porque o operador quase sempre digita só o IP.
 *
 * O token Bearer NÃO é digitado aqui: só o NOME do segredo. O valor vive no
 * backend e nunca trafega para o navegador.
 */
import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { useStorePermissions } from "@/hooks/use-store-permissions";
import { buildBackup, downloadBackup, parseBackup } from "@/lib/config-backup";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { FiscalCheckList } from "@/components/fiscal/fiscal-check-list";
import {
  pingFiscalServer,
  validateFiscalServer,
  testFiscalServerToken,
  type FiscalServerCheck,
} from "@/lib/fiscal.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Loader2,
  ServerCog,
  Save,
  Activity,
  ListChecks,
  Network,
  ShieldAlert,
  KeyRound,
  Download,
  Upload,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/servidor-fiscal")({
  head: () => ({
    meta: [
      { title: "Servidor fiscal — IP ou domínio do Node NFC-e | Bastion PDV" },
      {
        name: "description",
        content:
          "Configure o endereço (IP ou domínio) do servidor Node que emite a NFC-e para todos os caixas, defina um servidor reserva e teste a conexão com a SEFAZ.",
      },
      { property: "og:title", content: "Servidor fiscal — IP ou domínio do Node NFC-e" },
      {
        property: "og:description",
        content: "Aponte o PDV para o servidor Node de emissão de NFC-e e valide a conexão ponta a ponta.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: FiscalServerPage,
});

type Engine = "agent_local" | "vps";

interface FiscalServerConfig {
  direct_engine: Engine;
  vps_url: string;
  vps_fallback_url: string;
  vps_auth_secret_name: string;
  fallback_enabled: boolean;
}

/**
 * Normaliza o que o operador digitou para uma URL absoluta.
 * "192.168.0.50:3737" → "http://192.168.0.50:3737"
 * "fiscal.loja.com.br" → "https://fiscal.loja.com.br"
 * Endereços privados assumem http (raramente têm TLS na LAN).
 */
export function normalizeServerUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const host = value.split("/")[0]?.split(":")[0] ?? "";
  const isPrivate =
    host === "localhost" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return `${isPrivate ? "http" : "https"}://${value}`;
}

/** Valida sem lançar: devolve a mensagem de erro ou null. */
function urlProblem(value: string): string | null {
  if (!value) return null;
  try {
    const u = new URL(normalizeServerUrl(value));
    if (!u.hostname) return "Endereço sem host.";
    return null;
  } catch {
    return "Endereço inválido. Use IP:porta ou https://dominio.com.br";
  }
}

function FiscalServerPage() {
  const { storeId } = useCurrentStore();
  if (!storeId) {
    return (
      <>
        <PageHeader title="Servidor fiscal" description="Endereço do Node que emite a NFC-e." />
        <div className="p-6">
          <StoreRequired />
        </div>
      </>
    );
  }
  return <FiscalServerForm storeId={storeId} />;
}

function FiscalServerForm({ storeId }: { storeId: string }) {
  // Configuração fiscal é ação de gestão: caixa/estoquista só visualiza.
  const { permissions } = useStorePermissions(storeId);
  const canManage = permissions.canManageSettings;
  const qc = useQueryClient();
  const [draft, setDraft] = useState<FiscalServerConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [validating, setValidating] = useState(false);
  const [ping, setPing] = useState<{ ok: boolean; message: string; at: string } | null>(null);
  const [checks, setChecks] = useState<{ summary: string; checks: FiscalServerCheck[] } | null>(null);
  const [authTesting, setAuthTesting] = useState(false);
  const [auth, setAuth] = useState<{ ok: boolean; unprotected: boolean; message: string; at: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const config = useQuery({
    queryKey: ["fiscal-server-config", storeId],
    queryFn: async (): Promise<FiscalServerConfig> => {
      const { data, error } = await supabase
        .from("fiscal_configs")
        .select("direct_engine, vps_url, vps_fallback_url, vps_auth_secret_name, fallback_enabled")
        .eq("store_id", storeId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return {
        direct_engine: (data?.direct_engine as Engine) ?? "agent_local",
        vps_url: data?.vps_url ?? "",
        vps_fallback_url: data?.vps_fallback_url ?? "",
        vps_auth_secret_name: data?.vps_auth_secret_name ?? "FISCAL_VPS_TOKEN",
        fallback_enabled: data?.fallback_enabled ?? true,
      };
    },
  });

  const form = draft ?? config.data ?? null;
  const patch = (p: Partial<FiscalServerConfig>) => form && setDraft({ ...form, ...p });

  async function save() {
    if (!form) return;
    const primaryProblem = urlProblem(form.vps_url);
    const fallbackProblem = urlProblem(form.vps_fallback_url);
    if (primaryProblem || fallbackProblem) {
      toast.error(primaryProblem ?? fallbackProblem ?? "Endereço inválido.");
      return;
    }
    if (form.direct_engine === "vps" && !form.vps_url.trim()) {
      toast.error("Informe o endereço do servidor fiscal para usar o motor central.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        store_id: storeId,
        direct_engine: form.direct_engine,
        vps_url: normalizeServerUrl(form.vps_url) || null,
        vps_fallback_url: normalizeServerUrl(form.vps_fallback_url) || null,
        vps_auth_secret_name: form.vps_auth_secret_name.trim() || "FISCAL_VPS_TOKEN",
        fallback_enabled: form.fallback_enabled,
      };
      const { error } = await supabase.from("fiscal_configs").upsert(payload, { onConflict: "store_id" });
      if (error) throw new Error(error.message);
      toast.success("Servidor fiscal salvo.");
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["fiscal-server-config", storeId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setPinging(true);
    try {
      const r = (await pingFiscalServer({ data: { storeId } })) as { ok: boolean; message: string };
      setPing({ ...r, at: new Date().toLocaleString("pt-BR") });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPing({ ok: false, message, at: new Date().toLocaleString("pt-BR") });
      toast.error(message);
    } finally {
      setPinging(false);
    }
  }

  async function runValidation() {
    setValidating(true);
    try {
      const r = (await validateFiscalServer({ data: { storeId } })) as {
        ok: boolean;
        summary: string;
        checks: FiscalServerCheck[];
      };
      setChecks({ summary: r.summary, checks: r.checks });
      if (r.ok) toast.success(r.summary);
      else toast.error(r.summary);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  }

  /**
   * Prova o token Bearer contra um endpoint autenticado do servidor.
   * Roda no backend — o valor do segredo nunca chega ao navegador.
   */
  async function testToken() {
    setAuthTesting(true);
    try {
      const r = (await testFiscalServerToken({ data: { storeId } })) as {
        ok: boolean;
        unprotected: boolean;
        message: string;
      };
      setAuth({ ...r, at: new Date().toLocaleString("pt-BR") });
      if (r.ok && !r.unprotected) toast.success(r.message);
      else if (r.ok) toast.warning(r.message);
      else toast.error(r.message);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setAuth({ ok: false, unprotected: false, message, at: new Date().toLocaleString("pt-BR") });
      toast.error(message);
    } finally {
      setAuthTesting(false);
    }
  }

  /**
   * Exporta a configuração (sem segredos — só o NOME do segredo) para replicar
   * o mesmo servidor em outra loja/instalação sem redigitar nada.
   */
  /**
   * Exporta a configuração (sem segredos — só o NOME do segredo) em envelope
   * versionado e com hash SHA-256, para detectar arquivo corrompido/editado.
   */
  async function exportConfig() {
    if (!form) return;
    const envelope = await buildBackup("bastion-pos.fiscal-server", {
      direct_engine: form.direct_engine,
      vps_url: normalizeServerUrl(form.vps_url),
      vps_fallback_url: normalizeServerUrl(form.vps_fallback_url),
      vps_auth_secret_name: form.vps_auth_secret_name,
      fallback_enabled: form.fallback_enabled,
    });
    downloadBackup(envelope, "servidor-fiscal");
    toast.success(`Backup v${envelope.version} exportado (hash ${envelope.hash.slice(0, 8)}).`);
  }

  /** Importa o backup. Só preenche o formulário — salvar continua manual. */
  async function importConfig(file: File) {
    try {
      const result = await parseBackup<Partial<FiscalServerConfig>>(
        await file.text(),
        "bastion-pos.fiscal-server",
      );
      const c = result.payload;
      const engine: Engine = c.direct_engine === "vps" ? "vps" : "agent_local";
      setDraft({
        direct_engine: engine,
        vps_url: typeof c.vps_url === "string" ? c.vps_url : "",
        vps_fallback_url: typeof c.vps_fallback_url === "string" ? c.vps_fallback_url : "",
        vps_auth_secret_name:
          typeof c.vps_auth_secret_name === "string" && c.vps_auth_secret_name.trim()
            ? c.vps_auth_secret_name.trim()
            : "FISCAL_VPS_TOKEN",
        fallback_enabled: c.fallback_enabled !== false,
      });
      if (result.legacy) {
        toast.warning("Backup antigo (sem hash). Confira cada campo antes de salvar.");
      } else if (!result.hashValid) {
        toast.error("Hash não confere: o arquivo foi alterado ou corrompeu. Revise tudo antes de salvar.");
      } else {
        toast.success(`Backup v${result.version} íntegro. Confira os campos e clique em Salvar.`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Arquivo inválido.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (config.isLoading || !form) {
    return (
      <>
        <PageHeader title="Servidor fiscal" description="Endereço do Node que emite a NFC-e." />
        <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando configuração…
        </div>
      </>
    );
  }

  const dirty = draft !== null;
  const preview = normalizeServerUrl(form.vps_url);
  const previewFallback = normalizeServerUrl(form.vps_fallback_url);

  return (
    <>
      <PageHeader
        title="Servidor fiscal"
        description="Onde roda o Node que assina e transmite a NFC-e de todos os caixas."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!canManage && (
              <span className="text-xs text-muted-foreground">
                Somente administrador ou gerente pode alterar esta configuração.
              </span>
            )}
            <Button onClick={save} disabled={saving || !dirty || !canManage}>
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Salvar
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6 max-w-4xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ServerCog className="h-5 w-5" /> Quem emite a nota
            </CardTitle>
            <CardDescription>
              Com um caixa só, o próprio Agente Local pode emitir. Com dois ou mais, use um servidor central: o
              certificado A1 fica em um lugar só e um caixa desligado não trava os outros.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup value={form.direct_engine} onValueChange={(v) => patch({ direct_engine: v as Engine })}>
              <div className="flex items-start gap-3 rounded-md border p-3">
                <RadioGroupItem value="agent_local" id="srv-agent" className="mt-1" />
                <div>
                  <Label htmlFor="srv-agent" className="font-medium">
                    Agente Local (1 caixa)
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    O executável instalado no PC do caixa assina e envia direto à SEFAZ.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-md border p-3">
                <RadioGroupItem value="vps" id="srv-vps" className="mt-1" />
                <div>
                  <Label htmlFor="srv-vps" className="font-medium">
                    Servidor fiscal central (2+ caixas)
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Um Node único (pasta <code className="font-mono text-xs">vps-fiscal/</code>) recebe as notas de
                    todos os caixas.
                  </p>
                </div>
              </div>
            </RadioGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Network className="h-5 w-5" /> Endereço do servidor
            </CardTitle>
            <CardDescription>
              Aceita IP com porta (rede da loja) ou domínio com HTTPS (acesso externo). Se você digitar só o IP,
              completamos o <code className="font-mono text-xs">http://</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="vps-url">Servidor principal</Label>
              <Input
                id="vps-url"
                placeholder="192.168.0.50:3737  ou  https://fiscal.suaempresa.com.br"
                value={form.vps_url}
                onChange={(e) => patch({ vps_url: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
              {urlProblem(form.vps_url) ? (
                <p className="text-xs text-destructive">{urlProblem(form.vps_url)}</p>
              ) : preview ? (
                <p className="text-xs text-muted-foreground">
                  Será salvo como <span className="font-mono">{preview}</span>
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="vps-fallback">Servidor reserva (opcional)</Label>
              <Input
                id="vps-fallback"
                placeholder="https://fiscal-backup.suaempresa.com.br"
                value={form.vps_fallback_url}
                onChange={(e) => patch({ vps_fallback_url: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
              {urlProblem(form.vps_fallback_url) ? (
                <p className="text-xs text-destructive">{urlProblem(form.vps_fallback_url)}</p>
              ) : previewFallback ? (
                <p className="text-xs text-muted-foreground">
                  Será salvo como <span className="font-mono">{previewFallback}</span>
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="fallback-toggle" className="font-medium">
                  Tentar o outro motor quando o principal falhar
                </Label>
                <p className="text-xs text-muted-foreground">
                  Se o servidor central cair, a nota tenta sair pelo Agente Local do caixa (e vice-versa).
                </p>
              </div>
              <Switch
                id="fallback-toggle"
                checked={form.fallback_enabled}
                onCheckedChange={(v) => patch({ fallback_enabled: v })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="secret-name">Nome do segredo com o token Bearer</Label>
              <Input
                id="secret-name"
                placeholder="FISCAL_VPS_TOKEN"
                value={form.vps_auth_secret_name}
                onChange={(e) => patch({ vps_auth_secret_name: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Digite apenas o <strong>nome</strong> do segredo. O valor precisa ser idêntico ao{" "}
                <code className="font-mono">FISCAL_VPS_TOKEN</code> do arquivo <code className="font-mono">.env</code>{" "}
                do servidor e fica guardado no backend — nunca no navegador.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" /> Conexão e prontidão
            </CardTitle>
            <CardDescription>
              O teste rápido confere se o servidor responde. A validação completa confere token, motor node-dfe,
              certificado A1 e a conexão com a SEFAZ.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {dirty && (
              <p className="text-xs text-warning">
                Você alterou o endereço — salve antes de testar, o teste roda com o valor gravado.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={testConnection} disabled={pinging}>
                {pinging ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Activity className="h-4 w-4 mr-2" />}
                Testar conexão
              </Button>
              <Button variant="outline" onClick={testToken} disabled={authTesting}>
                {authTesting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <KeyRound className="h-4 w-4 mr-2" />}
                Testar token
              </Button>
              <Button variant="outline" onClick={runValidation} disabled={validating}>
                {validating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ListChecks className="h-4 w-4 mr-2" />}
                Validar servidor
              </Button>
            </div>

            {ping && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                <Badge variant={ping.ok ? "default" : "destructive"} className={ping.ok ? "bg-emerald-600" : ""}>
                  {ping.ok ? "Online" : "Falhou"}
                </Badge>
                <span className="text-muted-foreground">{ping.message}</span>
                <span className="ml-auto text-xs text-muted-foreground font-mono">{ping.at}</span>
              </div>
            )}

            {auth && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                <Badge
                  variant={auth.ok && !auth.unprotected ? "default" : auth.ok ? "secondary" : "destructive"}
                  className={auth.ok && !auth.unprotected ? "bg-emerald-600" : ""}
                >
                  {auth.ok ? (auth.unprotected ? "Exposto" : "Token válido") : "Token recusado"}
                </Badge>
                <span className="text-muted-foreground">{auth.message}</span>
                <span className="ml-auto text-xs text-muted-foreground font-mono">{auth.at}</span>
              </div>
            )}

            {checks && <FiscalCheckList checks={checks.checks} summary={checks.summary} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="h-5 w-5" /> Importar / exportar configuração
            </CardTitle>
            <CardDescription>
              Leve o mesmo endereço, servidor reserva e nome do segredo para outra loja sem redigitar. O{" "}
              <strong>valor</strong> do token nunca é exportado — ele fica só no backend.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void exportConfig()} disabled={!canManage}>
              <Download className="h-4 w-4 mr-2" /> Exportar JSON
            </Button>
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={!canManage}>
              <Upload className="h-4 w-4 mr-2" /> Importar JSON
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importConfig(f);
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Como subir o servidor</CardTitle>
            <CardDescription>Resumo — o passo a passo completo está no README do projeto.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <pre className="rounded-md border bg-muted/40 p-3 font-mono text-[11px] overflow-auto">
{`cd vps-fiscal
npm install
cp .env.example .env      # certificado A1, CSC, UF, token
npm start                 # http://0.0.0.0:3737

curl http://localhost:3737/health`}
            </pre>
            <p>
              Para o servidor não cair ao fechar o terminal, rode com{" "}
              <code className="font-mono text-xs">pm2 start server.js --name bastion-fiscal</code> ou use o
              Dockerfile da mesma pasta. Em acesso externo, coloque Nginx/Caddy com HTTPS na frente.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
