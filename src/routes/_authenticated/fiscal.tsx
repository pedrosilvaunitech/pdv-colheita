import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle, AlertTriangle, FileText, ShieldCheck, ExternalLink, Send, Loader2, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { emitInvoice, testFiscalConnection } from "@/lib/fiscal.functions";

export const Route = createFileRoute("/_authenticated/fiscal")({
  component: FiscalPage,
});

interface Step {
  key: string;
  title: string;
  desc: string;
  legal?: string;
  hint?: string;
}

const STEPS: Step[] = [
  {
    key: "cnpj",
    title: "1. CNPJ ativo com CNAE de comércio varejista",
    desc: "Sua empresa precisa estar formalizada. MEI, ME ou LTDA. O CNAE principal deve permitir venda ao consumidor (ex.: 4712-1/00 mini-mercado, 4711-3/02 supermercado, 4761-0/03 papelaria).",
    legal: "Lei Complementar 123/2006 · Instrução Normativa RFB 1.863/2018",
    hint: "Consulte no gov.br/receitafederal.",
  },
  {
    key: "ie",
    title: "2. Inscrição Estadual (IE) habilitada",
    desc: "Solicitada na SEFAZ do seu estado. É obrigatória para emitir NF-e/NFC-e. MEI pode ser isento em alguns estados — verifique.",
    legal: "Convênio SINIEF s/n de 15/12/1970",
    hint: "Cadastro Sincronizado (REDESIM) já emite CNPJ + IE juntos em muitos estados.",
  },
  {
    key: "certificado",
    title: "3. Certificado digital A1 (e-CNPJ)",
    desc: "Arquivo .pfx com senha, válido por 12 meses. Necessário para assinar cada nota fiscal enviada à SEFAZ. Compre em uma AC (Autoridade Certificadora) credenciada.",
    legal: "MP 2.200-2/2001 · ICP-Brasil",
    hint: "Preço médio R$ 180-300/ano. Marcas: Serasa, Certisign, Valid, Soluti.",
  },
  {
    key: "credenciamento",
    title: "4. Credenciamento na SEFAZ para NFC-e / NF-e",
    desc: "Alguns estados exigem credenciamento formal para emitir NFC-e (nota do consumidor). Solicite no portal da SEFAZ do seu estado.",
    legal: "Ajuste SINIEF 07/2005 (NF-e) · Ajuste SINIEF 19/2016 (NFC-e)",
    hint: "Você recebe o CSC (Código de Segurança do Contribuinte) e o ID CSC — obrigatórios na NFC-e.",
  },
  {
    key: "homologacao",
    title: "5. Homologação: testes em ambiente de homologação",
    desc: "Antes de emitir em produção, envie notas de teste ao ambiente de homologação da SEFAZ. Valida certificado, XML, regras de tributação.",
    legal: "Manual de Orientação do Contribuinte (MOC) NF-e / NFC-e",
    hint: "O sistema começa em homologação (não gera nota válida). Vire produção quando validar.",
  },
  {
    key: "provider",
    title: "6. Provedor de emissão (Focus NFe, NFe.io ou PlugNotas)",
    desc: "Recomendado: use uma API de emissão em vez de implementar toda a comunicação SEFAZ. Suas notas ficam ~R$ 0,05 a R$ 0,15 cada.",
    legal: "Terceirização técnica permitida — a responsabilidade fiscal permanece com o emissor.",
    hint: "Focus NFe (focusnfe.com.br), NFe.io, PlugNotas, MigrateNotes.",
  },
  {
    key: "producao",
    title: "7. Virar produção e emitir",
    desc: "Configure certificado + CSC no provedor, ajuste série e próximo número, e mude o ambiente para 'produção'. A partir daqui cada venda gera NFC-e válida.",
    legal: "Cláusula 3ª do Ajuste SINIEF 19/2016",
    hint: "Faça backup periódico dos XMLs (guarda obrigatória de 5 anos).",
  },
];

type FiscalProvider =
  | "none"
  | "focus_nfe"
  | "nfe_io"
  | "plugnotas"
  | "webmania"
  | "tecnospeed"
  | "direto_sefaz";
type FiscalEnv = "homologacao" | "producao";
interface FiscalForm {
  provider: FiscalProvider;
  environment: FiscalEnv;
  nfce_series: number;
  nfce_next_number: number;
  nfe_series: number;
  nfe_next_number: number;
  csc_id: string;
  csc_token: string;
  certificate_uploaded: boolean;
  certificate_expires_on: string;
  cnae: string;
  crt: string;
  provider_api_url: string;
  defer_credentials: boolean;
  credentials_note: string;
}
const PROVIDER_LABELS: Record<FiscalProvider, string> = {
  none: "Nenhum (só checklist)",
  focus_nfe: "Focus NFe",
  nfe_io: "NFe.io",
  plugnotas: "PlugNotas",
  webmania: "WebmaniaBR",
  tecnospeed: "TecnoSpeed",
  direto_sefaz: "Direto SEFAZ (avançado)",
};
const PROVIDER_SECRET: Record<FiscalProvider, string | null> = {
  none: null,
  focus_nfe: "FISCAL_FOCUS_NFE_TOKEN",
  nfe_io: "FISCAL_NFE_IO_API_KEY",
  plugnotas: "FISCAL_PLUGNOTAS_API_KEY",
  webmania: "FISCAL_WEBMANIA_API_KEY",
  tecnospeed: "FISCAL_TECNOSPEED_API_KEY",
  direto_sefaz: null,
};
const DEFAULT_CONFIG: FiscalForm = {
  provider: "none",
  environment: "homologacao",
  nfce_series: 1,
  nfce_next_number: 1,
  nfe_series: 1,
  nfe_next_number: 1,
  csc_id: "",
  csc_token: "",
  certificate_uploaded: false,
  certificate_expires_on: "",
  cnae: "",
  crt: "",
  provider_api_url: "",
  defer_credentials: true,
  credentials_note: "",
};

function validateFiscalForm(f: FiscalForm): string | null {
  if (f.provider === "none" && f.environment === "producao") {
    return "Para operar em produção você precisa escolher um provedor de emissão.";
  }
  if (f.provider === "direto_sefaz") {
    return "'Direto SEFAZ' exige servidor Node externo — o backend Lovable (Cloudflare Workers) não suporta assinatura XML-DSig + mutual TLS. Escolha um provedor de API.";
  }
  if (f.environment === "producao") {
    if (!f.cnae.trim()) return "CNAE principal é obrigatório em produção.";
    if (!f.crt) return "CRT (Código de Regime Tributário) é obrigatório em produção.";
    if (!f.csc_id.trim() || !f.csc_token.trim()) return "CSC ID e CSC Token são obrigatórios para emitir NFC-e em produção.";
    if (!f.certificate_uploaded) return "Envie o certificado A1 (.pfx) antes de virar produção.";
    if (f.defer_credentials) return "Desmarque 'Configurar credencial depois' e cadastre a chave do provedor antes de virar produção.";
  }
  if (f.nfce_series < 1 || f.nfce_next_number < 1) return "Série e próximo número da NFC-e precisam ser ≥ 1.";
  if (f.cnae && !/^\d{4}-\d\/\d{2}$/.test(f.cnae.trim())) {
    return "CNAE deve seguir o formato 9999-9/99 (ex.: 4711-3/02).";
  }
  return null;
}

function friendlyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("row-level security") || m.includes("row level security")) {
    return "Você não tem permissão para alterar a configuração desta loja. Peça a um admin/gerente.";
  }
  if (m.includes("invalid input value for enum")) {
    const match = msg.match(/"([^"]+)"/);
    return `Valor "${match?.[1] ?? "?"}" ainda não é aceito no banco. Recarregue a página e tente de novo.`;
  }
  if (m.includes("duplicate key")) return "Já existe uma configuração fiscal para esta loja. Ela foi atualizada.";
  if (m.includes("not-null") || m.includes("null value")) return "Um campo obrigatório ficou vazio. Revise o formulário.";
  if (m.includes("permission denied")) return "Sem permissão do banco para essa operação. Confirme que você é admin/gerente da loja.";
  return msg;
}

function FiscalPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();

  const { data: config } = useQuery({
    queryKey: ["fiscal-config", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data } = await supabase.from("fiscal_configs").select("*").eq("store_id", storeId!).maybeSingle();
      return data;
    },
  });

  const { data: checklist } = useQuery({
    queryKey: ["fiscal-checklist", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data } = await supabase.from("fiscal_checklist").select("*").eq("store_id", storeId!);
      const map: Record<string, boolean> = {};
      (data ?? []).forEach((r) => { map[r.step_key] = r.done; });
      return map;
    },
  });

  const { data: invoices } = useQuery({
    queryKey: ["invoices", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data } = await supabase.from("invoices").select("*").eq("store_id", storeId!).order("created_at", { ascending: false }).limit(20);
      return data ?? [];
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ step, done }: { step: string; done: boolean }) => {
      const { error } = await supabase.from("fiscal_checklist").upsert({
        store_id: storeId!, step_key: step, done, done_at: done ? new Date().toISOString() : null,
      }, { onConflict: "store_id,step_key" });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fiscal-checklist"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  if (!store) return <StoreRequired />;

  const doneCount = STEPS.filter((s) => checklist?.[s.key]).length;
  const progress = Math.round((doneCount / STEPS.length) * 100);

  return (
    <div>
      <PageHeader
        title="Nota Fiscal · Passo a passo para andar na lei"
        description="Checklist fiscal, configuração de emissão e histórico de NFC-e/NF-e."
      />
      <div className="p-6 space-y-6">
        <div className="border border-border rounded-md bg-card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold flex items-center gap-2"><ShieldCheck className="size-4 text-primary" /> Progresso de regularização</h2>
            <span className="text-xs font-mono">{doneCount}/{STEPS.length} · {progress}%</span>
          </div>
          <div className="h-2 rounded-full bg-secondary overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Enquanto você não completar os 7 passos, o sistema permanece em <b>homologação</b> — cada "venda" no PDV é apenas para treinamento e não gera nota fiscal válida.
          </p>
        </div>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-3">
            {STEPS.map((step) => {
              const done = checklist?.[step.key] ?? false;
              return (
                <div key={step.key} className={`border rounded-md bg-card p-4 transition-colors ${done ? "border-primary/40" : "border-border"}`}>
                  <div className="flex items-start gap-3">
                    <button onClick={() => toggle.mutate({ step: step.key, done: !done })} className="mt-0.5">
                      {done ? <CheckCircle2 className="size-5 text-primary" /> : <Circle className="size-5 text-muted-foreground" />}
                    </button>
                    <div className="flex-1">
                      <div className="text-sm font-medium">{step.title}</div>
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{step.desc}</p>
                      {step.hint && <p className="text-[11px] text-info mt-2">💡 {step.hint}</p>}
                      {step.legal && <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mt-2">Base legal: {step.legal}</p>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="space-y-4">
            <FiscalConfigCard storeId={storeId!} config={config} />
            <PendingFiscalCard storeId={storeId!} />
            <div className="border border-border rounded-md bg-card p-5">
              <h3 className="text-sm font-semibold mb-3">Notas recentes</h3>
              {invoices?.length === 0 ? (
                <div className="text-xs text-muted-foreground py-6 text-center">
                  Nenhuma NFC-e/NF-e emitida ainda.<br />
                  <span className="text-[11px]">Complete o checklist e configure um provedor para começar.</span>
                </div>
              ) : (
                <ul className="space-y-2 text-xs">
                  {invoices?.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between border-b border-border pb-2 last:border-0">
                      <div>
                        <div className="font-mono">{inv.type.toUpperCase()} #{inv.series}/{inv.number}</div>
                        <div className="text-[10px] text-muted-foreground">{new Date(inv.created_at).toLocaleString("pt-BR")}</div>
                      </div>
                      <StatusBadge status={inv.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function FiscalConfigCard({ storeId, config }: { storeId: string; config: Record<string, unknown> | null | undefined }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FiscalForm>({ ...DEFAULT_CONFIG });

  useEffect(() => {
    if (config) {
      setForm({
        provider: (config.provider as typeof DEFAULT_CONFIG.provider) ?? "none",
        environment: (config.environment as typeof DEFAULT_CONFIG.environment) ?? "homologacao",
        nfce_series: Number(config.nfce_series ?? 1),
        nfce_next_number: Number(config.nfce_next_number ?? 1),
        nfe_series: Number(config.nfe_series ?? 1),
        nfe_next_number: Number(config.nfe_next_number ?? 1),
        csc_id: String(config.csc_id ?? ""),
        csc_token: String(config.csc_token ?? ""),
        certificate_uploaded: Boolean(config.certificate_uploaded),
        certificate_expires_on: String(config.certificate_expires_on ?? ""),
      });
    }
  }, [config]);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        store_id: storeId, ...form,
        certificate_expires_on: form.certificate_expires_on || null,
        csc_id: form.csc_id || null, csc_token: form.csc_token || null,
      };
      const { error } = await supabase.from("fiscal_configs").upsert(payload, { onConflict: "store_id" });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Configuração salva"); qc.invalidateQueries({ queryKey: ["fiscal-config"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const isProd = form.environment === "producao";

  return (
    <div className="border border-border rounded-md bg-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2"><FileText className="size-4" /> Configuração fiscal</h3>
        <Badge variant="outline" className={isProd ? "border-destructive/40 text-destructive" : "border-warning/40 text-warning"}>
          {isProd ? "PRODUÇÃO" : "HOMOLOGAÇÃO"}
        </Badge>
      </div>

      <div className="space-y-3 text-xs">
        <div><Label className="text-xs">Provedor de emissão</Label>
          <Select value={form.provider} onValueChange={(v) => setForm({ ...form, provider: v as typeof form.provider })}>
            <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nenhum (só checklist)</SelectItem>
              <SelectItem value="focus_nfe">Focus NFe</SelectItem>
              <SelectItem value="nfe_io">NFe.io</SelectItem>
              <SelectItem value="plugnotas">PlugNotas</SelectItem>
            </SelectContent>
          </Select>
          {form.provider !== "none" && (
            <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
              <AlertTriangle className="size-3 text-warning" />
              Adicione a API key do provedor em <b>Segurança → Segredos</b> como <span className="font-mono">FISCAL_PROVIDER_API_KEY</span>.
            </p>
          )}
        </div>

        <div><Label className="text-xs">Ambiente</Label>
          <Select value={form.environment} onValueChange={(v) => setForm({ ...form, environment: v as typeof form.environment })}>
            <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="homologacao">Homologação (testes)</SelectItem>
              <SelectItem value="producao">Produção (valor legal)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div><Label className="text-xs">Série NFC-e</Label><Input type="number" min="1" value={form.nfce_series} onChange={(e) => setForm({ ...form, nfce_series: Number(e.target.value) })} className="mt-1 font-mono" /></div>
          <div><Label className="text-xs">Próximo nº NFC-e</Label><Input type="number" min="1" value={form.nfce_next_number} onChange={(e) => setForm({ ...form, nfce_next_number: Number(e.target.value) })} className="mt-1 font-mono" /></div>
        </div>

        <div><Label className="text-xs">CSC ID (NFC-e)</Label><Input value={form.csc_id} onChange={(e) => setForm({ ...form, csc_id: e.target.value })} className="mt-1 font-mono" placeholder="000001" /></div>
        <div><Label className="text-xs">CSC Token (NFC-e)</Label><Input type="password" value={form.csc_token} onChange={(e) => setForm({ ...form, csc_token: e.target.value })} className="mt-1 font-mono" placeholder="fornecido pela SEFAZ" /></div>
        <div><Label className="text-xs">Validade do certificado A1</Label><Input type="date" value={form.certificate_expires_on} onChange={(e) => setForm({ ...form, certificate_expires_on: e.target.value })} className="mt-1 font-mono" /></div>

        <Button onClick={() => save.mutate()} disabled={save.isPending} size="sm" className="w-full">
          {save.isPending ? "Salvando..." : "Salvar configuração"}
        </Button>

        <a href="https://focusnfe.com.br" target="_blank" rel="noreferrer" className="text-[11px] text-info hover:underline flex items-center gap-1">
          Documentação do provedor <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  );
}

function PendingFiscalCard({ storeId }: { storeId: string }) {
  const qc = useQueryClient();
  const emit = useServerFn(emitInvoice);
  const [running, setRunning] = useState(false);

  const { data: pending } = useQuery({
    queryKey: ["fiscal-pending", storeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("id, total, finalized_at, customer_name")
        .eq("store_id", storeId)
        .eq("fiscal_status", "pendente")
        .order("finalized_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  async function reemitAll() {
    if (!pending || pending.length === 0) return;
    setRunning(true);
    let ok = 0;
    let fail = 0;
    let firstErr = "";
    for (const sale of pending) {
      try {
        await emit({ data: { storeId, saleId: sale.id, type: "nfce" } });
        await supabase.from("sales").update({ fiscal_status: "emitida" }).eq("id", sale.id);
        ok++;
      } catch (e) {
        fail++;
        if (!firstErr) firstErr = (e as Error).message;
        await supabase.from("sales").update({ fiscal_status: "falha" }).eq("id", sale.id);
      }
    }
    setRunning(false);
    qc.invalidateQueries({ queryKey: ["fiscal-pending"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    if (fail === 0) toast.success(`${ok} nota(s) emitida(s)`);
    else toast.error(`${ok} emitida(s), ${fail} com falha. ${firstErr}`);
  }

  const count = pending?.length ?? 0;
  const totalSum = (pending ?? []).reduce((s, p) => s + Number(p.total ?? 0), 0);

  return (
    <div className="border border-warning/40 rounded-md bg-warning/5 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2 text-warning">
          <AlertTriangle className="size-4" /> Vendas fiscais pendentes
        </h3>
        <Badge variant="outline" className="border-warning/40 text-warning font-mono">{count}</Badge>
      </div>
      {count === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nenhuma venda aguardando emissão. Vendas marcadas como NFC-e no PDV aparecem aqui até serem emitidas.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            Total pendente: <b className="font-mono text-foreground">R$ {totalSum.toFixed(2).replace(".", ",")}</b> em {count} venda(s). Configure o provedor fiscal antes de reemitir em lote.
          </p>
          <ul className="space-y-1 max-h-40 overflow-auto text-xs">
            {pending!.slice(0, 10).map((s) => (
              <li key={s.id} className="flex items-center justify-between font-mono py-1 border-b border-border last:border-0">
                <span className="text-muted-foreground truncate">
                  {s.finalized_at ? new Date(s.finalized_at).toLocaleString("pt-BR") : "—"}
                  {s.customer_name ? ` · ${s.customer_name}` : ""}
                </span>
                <span>R$ {Number(s.total ?? 0).toFixed(2).replace(".", ",")}</span>
              </li>
            ))}
            {count > 10 && <li className="text-[10px] text-muted-foreground py-1">+ {count - 10} outra(s)…</li>}
          </ul>
          <Button size="sm" onClick={reemitAll} disabled={running} className="w-full gap-2">
            {running ? <><Loader2 className="size-3 animate-spin" /> Emitindo…</> : <><Send className="size-3" /> Reemitir em lote</>}
          </Button>
        </>
      )}
    </div>
  );
}


function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    autorizada: { cls: "border-primary/40 text-primary", label: "autorizada" },
    processando: { cls: "border-info/40 text-info", label: "processando" },
    rejeitada: { cls: "border-destructive/40 text-destructive", label: "rejeitada" },
    cancelada: { cls: "border-muted-foreground/40 text-muted-foreground", label: "cancelada" },
    rascunho: { cls: "border-warning/40 text-warning", label: "rascunho" },
    inutilizada: { cls: "border-muted-foreground/40 text-muted-foreground", label: "inutilizada" },
  };
  const m = map[status] ?? map.rascunho;
  return <Badge variant="outline" className={m.cls}>{m.label}</Badge>;
}
