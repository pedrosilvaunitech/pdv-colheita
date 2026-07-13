import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { buildReceiptHTML, printReceipt } from "@/lib/receipt";
import { toast } from "sonner";
import { Save, Printer, Upload, ShieldCheck, ShieldAlert, Image as ImageIcon, Trash2, BookOpen, KeyRound, Clock, QrCode, Palette, RotateCcw, Sun, Moon, Monitor } from "lucide-react";
import { PixSettingsTab } from "@/components/pix-settings-tab";
import { DEFAULT_BRANDING, loadBranding, saveBranding, resetBranding, type Branding, type ThemeMode } from "@/lib/branding";
import { DENSITY_LABELS, getPrintDensity, setPrintDensity, buildDensityPrefix, type PrintDensity } from "@/lib/print-density";
import { buildEscPosPayload, tryPrintEscPos } from "@/lib/escpos";

export const Route = createFileRoute("/_authenticated/configuracoes")({ component: SettingsPage });

interface ReceiptSettings {
  store_id: string;
  default_document: "fiscal" | "nao_fiscal";
  paper_width: 58 | 80;
  header_text: string | null;
  footer_text: string | null;
  logo_url: string | null;
  print_auto: boolean;
  ask_customer: boolean;
  show_logo: boolean;
  show_cnpj: boolean;
  show_address: boolean;
  show_operator: boolean;
  show_customer: boolean;
  show_item_code: boolean;
  show_qrcode: boolean;
  font_size: "small" | "medium" | "large";
  thank_you_text: string | null;
  extra_info: string | null;
}

interface FiscalConfig {
  store_id: string;
  provider: string;
  environment: string;
  nfce_series: number;
  nfce_next_number: number;
  nfe_series: number;
  nfe_next_number: number;
  csc_id: string | null;
  csc_token: string | null;
  certificate_uploaded: boolean;
  certificate_expires_on: string | null;
  certificate_path: string | null;
  certificate_filename: string | null;
  certificate_password_set: boolean;
  certificate_subject: string | null;
  provider_api_key_set: boolean;
  provider_api_url: string | null;
  cnae: string | null;
  crt: string | null;
  defer_credentials: boolean;
  credentials_note: string | null;
}

const PROVIDER_INFO: Record<string, { label: string; secret: string; url: string; note: string }> = {
  focus_nfe:    { label: "Focus NFe",   secret: "FISCAL_FOCUS_NFE_TOKEN",   url: "https://focusnfe.com.br/doc/",           note: "Token em Empresas → Tokens de acesso." },
  plugnotas:    { label: "PlugNotas",   secret: "FISCAL_PLUGNOTAS_API_KEY", url: "https://plugnotas.com.br/docs",          note: "API Key em API → Chaves de acesso." },
  nfe_io:       { label: "NFe.io",      secret: "FISCAL_NFE_IO_API_KEY",    url: "https://nfe.io/docs",                    note: "Token da conta em Configurações → API." },
  webmania:     { label: "WebmaniaBR",  secret: "FISCAL_WEBMANIA_API_KEY",  url: "https://webmaniabr.com/docs/rest-api-nfe", note: "Concatene consumer_key:consumer_secret:token:token_secret." },
  tecnospeed:   { label: "TecnoSpeed",  secret: "FISCAL_TECNOSPEED_API_KEY", url: "https://tecnospeed.com.br",             note: "Token fornecido pelo comercial após contrato." },
  direto_sefaz: { label: "Direto SEFAZ", secret: "—",                       url: "https://www.nfe.fazenda.gov.br/portal/",  note: "Sem provedor — assina localmente com o .pfx (avançado)." },
};

function SettingsPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [form, setForm] = useState<ReceiptSettings | null>(null);
  const [fiscal, setFiscal] = useState<FiscalConfig | null>(null);
  const [certPassword, setCertPassword] = useState("");
  const logoInputRef = useRef<HTMLInputElement>(null);
  const certInputRef = useRef<HTMLInputElement>(null);

  const q = useQuery({
    queryKey: ["receipt_settings", storeId],
    enabled: !!storeId,
    queryFn: async (): Promise<ReceiptSettings> => {
      const { data, error } = await supabase.from("receipt_settings").select("*").eq("store_id", storeId!).maybeSingle();
      if (error) throw error;
      return (data as ReceiptSettings | null) ?? {
        store_id: storeId!, default_document: "nao_fiscal", paper_width: 80,
        header_text: null, footer_text: "Obrigado pela preferência!", logo_url: null,
        print_auto: true, ask_customer: false,
        show_logo: true, show_cnpj: true, show_address: true, show_operator: true,
        show_customer: true, show_item_code: true, show_qrcode: true,
        font_size: "medium", thank_you_text: "Volte sempre!", extra_info: null,
      };
    },
  });

  const qf = useQuery({
    queryKey: ["fiscal_configs", storeId],
    enabled: !!storeId,
    queryFn: async (): Promise<FiscalConfig> => {
      const { data, error } = await supabase.from("fiscal_configs").select("*").eq("store_id", storeId!).maybeSingle();
      if (error) throw error;
      return (data as FiscalConfig | null) ?? {
        store_id: storeId!, provider: "focus_nfe", environment: "homologacao",
        nfce_series: 1, nfce_next_number: 1, nfe_series: 1, nfe_next_number: 1,
        csc_id: null, csc_token: null,
        certificate_uploaded: false, certificate_expires_on: null,
        certificate_path: null, certificate_filename: null, certificate_password_set: false,
        certificate_subject: null, provider_api_key_set: false, provider_api_url: null,
        cnae: null, crt: null,
        defer_credentials: true, credentials_note: null,
      };
    },
  });

  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);
  useEffect(() => { if (qf.data) setFiscal(qf.data); }, [qf.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form) return;
      const { error } = await supabase.from("receipt_settings").upsert(form, { onConflict: "store_id" });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Configurações salvas"); qc.invalidateQueries({ queryKey: ["receipt_settings"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveFiscal = useMutation({
    mutationFn: async () => {
      if (!fiscal) return;
      const { error } = await supabase.from("fiscal_configs").upsert(fiscal as never, { onConflict: "store_id" });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Configuração fiscal salva"); qc.invalidateQueries({ queryKey: ["fiscal_configs"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      if (!storeId) throw new Error("Sem loja");
      const ext = file.name.split(".").pop() || "png";
      const path = `${storeId}/logo.${ext}`;
      const { error: upErr } = await supabase.storage.from("receipt-logos").upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data } = await supabase.storage.from("receipt-logos").createSignedUrl(path, 60 * 60 * 24 * 365);
      const url = data?.signedUrl ?? null;
      if (form) {
        const next = { ...form, logo_url: url };
        setForm(next);
        await supabase.from("receipt_settings").upsert(next as never, { onConflict: "store_id" });
      }
      return url;
    },
    onSuccess: () => toast.success("Logo enviado"),
    onError: (e: Error) => toast.error(e.message),
  });

  const uploadCert = useMutation({
    mutationFn: async (file: File) => {
      if (!storeId) throw new Error("Sem loja");
      if (!certPassword) throw new Error("Informe a senha do certificado");
      const path = `${storeId}/${file.name}`;
      const { error: upErr } = await supabase.storage.from("fiscal-certificates").upload(path, file, { upsert: true, contentType: "application/x-pkcs12" });
      if (upErr) throw upErr;
      const next: FiscalConfig = {
        ...(fiscal as FiscalConfig),
        certificate_uploaded: true,
        certificate_path: path,
        certificate_filename: file.name,
        certificate_password_set: true,
        certificate_subject: fiscal?.certificate_subject ?? null,
      };
      const { error } = await supabase.from("fiscal_configs").upsert(next as never, { onConflict: "store_id" });
      if (error) throw error;
      setFiscal(next);
      setCertPassword("");
    },
    onSuccess: () => toast.success("Certificado A1 armazenado com segurança"),
    onError: (e: Error) => toast.error(e.message),
  });

  const removeCert = useMutation({
    mutationFn: async () => {
      if (!fiscal?.certificate_path) return;
      await supabase.storage.from("fiscal-certificates").remove([fiscal.certificate_path]);
      const next: FiscalConfig = { ...fiscal, certificate_uploaded: false, certificate_path: null, certificate_filename: null, certificate_password_set: false, certificate_subject: null };
      const { error } = await supabase.from("fiscal_configs").upsert(next as never, { onConflict: "store_id" });
      if (error) throw error;
      setFiscal(next);
    },
    onSuccess: () => toast.success("Certificado removido"),
    onError: (e: Error) => toast.error(e.message),
  });

  if (!store) return <StoreRequired />;
  if (!form || !fiscal) return <div className="p-6 text-sm text-muted-foreground">Carregando...</div>;

  const preview = () => {
    const html = buildReceiptHTML({
      store: { name: store.fantasy_name || store.name, cnpj: form.show_cnpj ? store.cnpj : null, address: form.show_address ? ([store.city, store.state].filter(Boolean).join(" · ") || null) : null, phone: null },
      header: form.header_text, footer: [form.thank_you_text, form.footer_text, form.extra_info].filter(Boolean).join("\n"),
      paper_width: form.paper_width,
      items: [
        { name: "REFRIGERANTE COLA 2L", quantity: 2, unit_price: 8.5, total: 17, barcode: form.show_item_code ? "7891234567890" : undefined },
        { name: "PAO FRANCES KG", quantity: 0.42, unit_price: 15.9, total: 6.68 },
      ],
      subtotal: 23.68, discount: 0, total: 23.68, payment_method: "dinheiro",
      received: 30, change: 6.32,
      operator: form.show_operator ? "Operador exemplo" : undefined,
      customer: form.show_customer ? { name: "Cliente exemplo", doc: null } : undefined,
      sale_id: "PREVIEW00", document_type: form.default_document, issued_at: new Date(),
    });
    printReceipt(html);
  };

  return (
    <div>
      <PageHeader title="Configurações · Fiscal, PDV e recibos" description="Certificado digital, personalização de nota, papel, cabeçalho e rodapé" />

      <div className="p-6 max-w-5xl">
        <Tabs defaultValue="recibo">
          <TabsList>
            <TabsTrigger value="aparencia" className="gap-1"><Palette className="size-3" /> Aparência</TabsTrigger>
            <TabsTrigger value="recibo">Cupom / Nota</TabsTrigger>
            <TabsTrigger value="fiscal">Fiscal & Certificado A1</TabsTrigger>
            <TabsTrigger value="numeracao">Numeração NFC-e/NF-e</TabsTrigger>
            <TabsTrigger value="pix" className="gap-1"><QrCode className="size-3" /> PIX</TabsTrigger>
          </TabsList>

          <TabsContent value="aparencia" className="mt-4">
            <BrandingTab />
          </TabsContent>

          <TabsContent value="recibo" className="mt-4">
            <div className="flex justify-end gap-2 mb-4">
              <Button variant="outline" className="gap-2" onClick={preview}><Printer className="size-4" />Prévia</Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending} className="gap-2"><Save className="size-4" />Salvar</Button>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="border border-border rounded-md bg-card p-4 space-y-3 md:col-span-2">
                <h3 className="text-sm font-semibold">Documento padrão emitido pelo PDV</h3>
                <Select value={form.default_document} onValueChange={(v) => setForm({ ...form, default_document: v as ReceiptSettings["default_document"] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nao_fiscal">Recibo não-fiscal (rápido)</SelectItem>
                    <SelectItem value="fiscal">NFC-e (fiscal — requer certificado A1)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">O operador poderá trocar caso-a-caso no PDV.</p>
              </div>

              <div className="border border-border rounded-md bg-card p-4 space-y-3">
                <h3 className="text-sm font-semibold">Papel e comportamento</h3>
                <Select value={String(form.paper_width)} onValueChange={(v) => setForm({ ...form, paper_width: Number(v) as 58 | 80 })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="80">80mm (padrão)</SelectItem>
                    <SelectItem value="58">58mm (portátil)</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={form.font_size} onValueChange={(v) => setForm({ ...form, font_size: v as ReceiptSettings["font_size"] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">Fonte pequena</SelectItem>
                    <SelectItem value="medium">Fonte média</SelectItem>
                    <SelectItem value="large">Fonte grande</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <div><Label>Imprimir automaticamente</Label><p className="text-xs text-muted-foreground">Abre a impressão ao finalizar venda</p></div>
                  <Switch checked={form.print_auto} onCheckedChange={(c) => setForm({ ...form, print_auto: c })} />
                </div>
                <div className="flex items-center justify-between">
                  <div><Label>Perguntar CPF do cliente</Label><p className="text-xs text-muted-foreground">Antes de finalizar</p></div>
                  <Switch checked={form.ask_customer} onCheckedChange={(c) => setForm({ ...form, ask_customer: c })} />
                </div>
              </div>

              <div className="border border-border rounded-md bg-card p-4 space-y-3">
                <h3 className="text-sm font-semibold flex items-center gap-2"><ImageIcon className="size-4" /> Logo da empresa</h3>
                {form.logo_url ? (
                  <div className="border border-border rounded p-3 flex items-center gap-3">
                    <img src={form.logo_url} alt="Logo" className="h-12 w-auto bg-white rounded" />
                    <div className="flex-1 text-xs text-muted-foreground truncate">Logo enviado</div>
                    <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, logo_url: null })}><Trash2 className="size-4" /></Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Nenhum logo enviado.</p>
                )}
                <input ref={logoInputRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo.mutate(f); }} />
                <Button variant="outline" size="sm" className="gap-2 w-full" onClick={() => logoInputRef.current?.click()} disabled={uploadLogo.isPending}>
                  <Upload className="size-4" /> {uploadLogo.isPending ? "Enviando..." : "Enviar logo (PNG/JPG)"}
                </Button>
                <div><Label>Ou URL externa</Label><Input value={form.logo_url ?? ""} onChange={(e) => setForm({ ...form, logo_url: e.target.value || null })} placeholder="https://..." /></div>
              </div>

              <div className="border border-border rounded-md bg-card p-4 space-y-3 md:col-span-2">
                <h3 className="text-sm font-semibold">O que exibir no cupom</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {([
                    ["show_logo", "Logo"], ["show_cnpj", "CNPJ"], ["show_address", "Endereço"],
                    ["show_operator", "Operador"], ["show_customer", "Cliente"],
                    ["show_item_code", "Código do item"], ["show_qrcode", "QR Code"],
                  ] as const).map(([k, label]) => (
                    <label key={k} className="flex items-center justify-between border border-border rounded p-2 text-sm">
                      <span>{label}</span>
                      <Switch checked={form[k]} onCheckedChange={(c) => setForm({ ...form, [k]: c })} />
                    </label>
                  ))}
                </div>
              </div>

              <div className="border border-border rounded-md bg-card p-4 space-y-3 md:col-span-2">
                <h3 className="text-sm font-semibold">Textos personalizados</h3>
                <div><Label>Cabeçalho</Label><Textarea rows={2} value={form.header_text ?? ""} onChange={(e) => setForm({ ...form, header_text: e.target.value || null })} placeholder="Ex: promoção da semana" /></div>
                <div><Label>Agradecimento</Label><Input value={form.thank_you_text ?? ""} onChange={(e) => setForm({ ...form, thank_you_text: e.target.value || null })} placeholder="Volte sempre!" /></div>
                <div><Label>Rodapé</Label><Textarea rows={2} value={form.footer_text ?? ""} onChange={(e) => setForm({ ...form, footer_text: e.target.value || null })} /></div>
                <div><Label>Informações extras (redes sociais, política de troca...)</Label><Textarea rows={2} value={form.extra_info ?? ""} onChange={(e) => setForm({ ...form, extra_info: e.target.value || null })} /></div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="fiscal" className="mt-4">
            <div className="flex justify-end gap-2 mb-4">
              <Button onClick={() => saveFiscal.mutate()} disabled={saveFiscal.isPending} className="gap-2"><Save className="size-4" />Salvar</Button>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <div className="border border-border rounded-md bg-card p-4 space-y-3 md:col-span-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">Certificado Digital A1 (.pfx)</h3>
                  {fiscal.certificate_uploaded
                    ? <Badge variant="outline" className="border-primary/40 text-primary gap-1"><ShieldCheck className="size-3" /> Configurado</Badge>
                    : <Badge variant="outline" className="border-warning/40 text-warning gap-1"><ShieldAlert className="size-3" /> Não configurado</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">Armazenado com segurança em bucket privado. Necessário para transmitir NFC-e/NF-e para a SEFAZ.</p>
                {fiscal.certificate_uploaded && (
                  <div className="border border-border rounded p-3 text-xs space-y-1">
                    <div><b>Arquivo:</b> {fiscal.certificate_filename}</div>
                    {fiscal.certificate_subject && <div><b>Titular:</b> {fiscal.certificate_subject}</div>}
                    {fiscal.certificate_expires_on && <div><b>Válido até:</b> {new Date(fiscal.certificate_expires_on).toLocaleDateString("pt-BR")}</div>}
                    <Button size="sm" variant="ghost" className="text-destructive gap-1 mt-2" onClick={() => removeCert.mutate()}><Trash2 className="size-3" /> Remover</Button>
                  </div>
                )}
                <div className="grid md:grid-cols-2 gap-3">
                  <div><Label>Senha do certificado</Label><Input type="password" value={certPassword} onChange={(e) => setCertPassword(e.target.value)} placeholder="•••••••" /></div>
                  <div className="flex items-end">
                    <input ref={certInputRef} type="file" accept=".pfx,.p12" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCert.mutate(f); }} />
                    <Button variant="outline" className="gap-2 w-full" onClick={() => certInputRef.current?.click()} disabled={uploadCert.isPending || !certPassword}>
                      <Upload className="size-4" /> {uploadCert.isPending ? "Enviando..." : "Enviar .pfx / .p12"}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="border border-border rounded-md bg-card p-4 space-y-3">
                <h3 className="text-sm font-semibold">Provedor de emissão</h3>
                <Select value={fiscal.provider} onValueChange={(v) => setFiscal({ ...fiscal, provider: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="focus_nfe">Focus NFe</SelectItem>
                    <SelectItem value="plugnotas">PlugNotas</SelectItem>
                    <SelectItem value="nfe_io">NFe.io</SelectItem>
                    <SelectItem value="webmania">WebmaniaBR</SelectItem>
                    <SelectItem value="tecnospeed">TecnoSpeed</SelectItem>
                    <SelectItem value="direto_sefaz">Direto SEFAZ (avançado)</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={fiscal.environment} onValueChange={(v) => setFiscal({ ...fiscal, environment: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="homologacao">Homologação (testes)</SelectItem>
                    <SelectItem value="producao">Produção</SelectItem>
                  </SelectContent>
                </Select>
                <div><Label>URL da API (opcional)</Label><Input value={fiscal.provider_api_url ?? ""} onChange={(e) => setFiscal({ ...fiscal, provider_api_url: e.target.value || null })} placeholder="https://api.provedor.com/v2" /></div>
              </div>

              <div className="border border-border rounded-md bg-card p-4 space-y-3">
                <h3 className="text-sm font-semibold">Dados do emitente</h3>
                <div><Label>CNAE principal</Label><Input value={fiscal.cnae ?? ""} onChange={(e) => setFiscal({ ...fiscal, cnae: e.target.value || null })} placeholder="4711-3/02" /></div>
                <div><Label>CRT (Código de Regime Tributário)</Label>
                  <Select value={fiscal.crt ?? ""} onValueChange={(v) => setFiscal({ ...fiscal, crt: v })}>
                    <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 - Simples Nacional</SelectItem>
                      <SelectItem value="2">2 - Simples Nacional (excesso)</SelectItem>
                      <SelectItem value="3">3 - Regime Normal</SelectItem>
                      <SelectItem value="4">4 - MEI</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div><Label>CSC ID (Token NFC-e)</Label><Input value={fiscal.csc_id ?? ""} onChange={(e) => setFiscal({ ...fiscal, csc_id: e.target.value || null })} placeholder="000001" /></div>
                <div><Label>CSC Token</Label><Input type="password" value={fiscal.csc_token ?? ""} onChange={(e) => setFiscal({ ...fiscal, csc_token: e.target.value || null })} /></div>
              </div>

              <div className="border border-warning/40 rounded-md bg-warning/5 p-4 space-y-3 md:col-span-2">
                <div className="flex items-center gap-2">
                  <KeyRound className="size-4 text-warning" />
                  <h3 className="text-sm font-semibold">Credencial do provedor (API)</h3>
                  <Badge variant="outline" className={fiscal.defer_credentials ? "border-warning/40 text-warning gap-1" : "border-primary/40 text-primary gap-1"}>
                    {fiscal.defer_credentials ? <><Clock className="size-3" /> Registrar depois</> : <><ShieldCheck className="size-3" /> Ativa no backend</>}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Você pode continuar sem cadastrar agora. Enquanto esta opção estiver marcada, o PDV funciona em modo <b>recibo não-fiscal</b> e a emissão real fica bloqueada com uma mensagem explicando o que falta.
                </p>
                <div className="flex items-center justify-between border border-border rounded p-3 bg-card">
                  <div>
                    <Label className="text-sm">Configurar credencial depois</Label>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Segredo esperado: <span className="font-mono">{PROVIDER_INFO[fiscal.provider]?.secret ?? "—"}</span>
                      {PROVIDER_INFO[fiscal.provider] && ` · ${PROVIDER_INFO[fiscal.provider]!.note}`}
                    </p>
                  </div>
                  <Switch checked={fiscal.defer_credentials} onCheckedChange={(c) => setFiscal({ ...fiscal, defer_credentials: c })} />
                </div>
                <div><Label>Anotação para lembrar depois</Label>
                  <Textarea rows={2} value={fiscal.credentials_note ?? ""} onChange={(e) => setFiscal({ ...fiscal, credentials_note: e.target.value || null })} placeholder="Ex: aguardando contrato Focus NFe · responsável: contador João" />
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <a href="/docs/fiscal-setup.md" target="_blank" rel="noreferrer" className="text-xs text-info hover:underline inline-flex items-center gap-1">
                    <BookOpen className="size-3" /> Guia completo: como obter a API do provedor
                  </a>
                  {PROVIDER_INFO[fiscal.provider]?.url && (
                    <a href={PROVIDER_INFO[fiscal.provider]!.url} target="_blank" rel="noreferrer" className="text-xs text-info hover:underline inline-flex items-center gap-1">
                      Documentação {PROVIDER_INFO[fiscal.provider]!.label}
                    </a>
                  )}
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="numeracao" className="mt-4">
            <div className="flex justify-end gap-2 mb-4">
              <Button onClick={() => saveFiscal.mutate()} disabled={saveFiscal.isPending} className="gap-2"><Save className="size-4" />Salvar</Button>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <div className="border border-border rounded-md bg-card p-4 space-y-3">
                <h3 className="text-sm font-semibold">NFC-e</h3>
                <div><Label>Série</Label><Input type="number" value={fiscal.nfce_series} onChange={(e) => setFiscal({ ...fiscal, nfce_series: Number(e.target.value) })} /></div>
                <div><Label>Próximo número</Label><Input type="number" value={fiscal.nfce_next_number} onChange={(e) => setFiscal({ ...fiscal, nfce_next_number: Number(e.target.value) })} /></div>
              </div>
              <div className="border border-border rounded-md bg-card p-4 space-y-3">
                <h3 className="text-sm font-semibold">NF-e</h3>
                <div><Label>Série</Label><Input type="number" value={fiscal.nfe_series} onChange={(e) => setFiscal({ ...fiscal, nfe_series: Number(e.target.value) })} /></div>
                <div><Label>Próximo número</Label><Input type="number" value={fiscal.nfe_next_number} onChange={(e) => setFiscal({ ...fiscal, nfe_next_number: Number(e.target.value) })} /></div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="pix" className="mt-4">
            <PixSettingsTab storeId={storeId!} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

const COLOR_PRESETS: { name: string; primary: string; accent: string; background: string }[] = [
  { name: "Terminal (padrão)", primary: "oklch(0.78 0.18 155)", accent: "oklch(0.72 0.16 220)", background: "oklch(0.16 0.015 250)" },
  { name: "Cyber Blue",        primary: "oklch(0.72 0.18 240)", accent: "oklch(0.78 0.16 180)", background: "oklch(0.15 0.02 260)" },
  { name: "Sunset Orange",     primary: "oklch(0.75 0.19 55)",  accent: "oklch(0.72 0.16 30)",  background: "oklch(0.16 0.02 30)" },
  { name: "Royal Purple",      primary: "oklch(0.68 0.22 300)", accent: "oklch(0.75 0.16 340)", background: "oklch(0.15 0.02 290)" },
  { name: "Crimson Red",       primary: "oklch(0.65 0.24 25)",  accent: "oklch(0.72 0.16 55)",  background: "oklch(0.15 0.02 15)" },
  { name: "Golden Amber",      primary: "oklch(0.82 0.17 85)",  accent: "oklch(0.72 0.16 55)",  background: "oklch(0.16 0.02 60)" },
  { name: "Ocean Teal",        primary: "oklch(0.72 0.15 195)", accent: "oklch(0.68 0.14 220)", background: "oklch(0.15 0.02 220)" },
  { name: "Mono Light",        primary: "oklch(0.55 0 0)",      accent: "oklch(0.65 0 0)",      background: "oklch(0.97 0 0)" },
];

function BrandingTab() {
  const [b, setB] = useState<Branding>(() => loadBranding());
  const persist = (next: Branding) => { setB(next); saveBranding(next); };
  const reset = () => { setB(DEFAULT_BRANDING); resetBranding(); toast.success("Aparência restaurada ao padrão"); };

  return (
    <div className="space-y-4">
      <div className="border border-border rounded-md bg-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Palette className="size-4" /> Identidade do sistema</h3>
          <Button variant="ghost" size="sm" className="gap-2" onClick={reset}><RotateCcw className="size-3" /> Restaurar padrão</Button>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <Label>Nome do sistema</Label>
            <Input value={b.appName} onChange={(e) => persist({ ...b, appName: e.target.value })} placeholder="BASTION POS" />
          </div>
          <div>
            <Label>Sub-título / slogan</Label>
            <Input value={b.appTagline} onChange={(e) => persist({ ...b, appTagline: e.target.value })} placeholder="Operações fiscais" />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">Alterações aplicam-se imediatamente à barra lateral e ao cabeçalho.</p>
      </div>

      <div className="border border-border rounded-md bg-card p-4 space-y-3">
        <h3 className="text-sm font-semibold">Modo de exibição</h3>
        <p className="text-[11px] text-muted-foreground">Escolha entre tema claro, escuro ou seguir a preferência do sistema operacional.</p>
        <div className="grid grid-cols-3 gap-2">
          {([
            { key: "light",  label: "Claro",   icon: Sun },
            { key: "dark",   label: "Escuro",  icon: Moon },
            { key: "system", label: "Sistema", icon: Monitor },
          ] as { key: ThemeMode; label: string; icon: typeof Sun }[]).map(({ key, label, icon: Icon }) => {
            const active = b.mode === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => persist({ ...b, mode: key })}
                className={`border rounded-md p-3 flex flex-col items-center gap-2 transition-all hover:border-primary/60 ${active ? "border-primary ring-2 ring-primary/30 bg-primary/5" : "border-border"}`}
              >
                <Icon className="size-5" />
                <span className="text-xs font-medium">{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border border-border rounded-md bg-card p-4 space-y-4">
        <h3 className="text-sm font-semibold">Paletas predefinidas</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {COLOR_PRESETS.map((p) => {
            const active = p.primary === b.primary && p.accent === b.accent && p.background === b.background;
            return (
              <button
                key={p.name}
                type="button"
                onClick={() => persist({ ...b, primary: p.primary, accent: p.accent, background: p.background })}
                className={`border rounded-md p-3 text-left space-y-2 transition-all hover:border-primary/60 ${active ? "border-primary ring-2 ring-primary/30" : "border-border"}`}
              >
                <div className="flex gap-1">
                  <span className="size-6 rounded" style={{ background: p.primary }} />
                  <span className="size-6 rounded" style={{ background: p.accent }} />
                  <span className="size-6 rounded border border-border" style={{ background: p.background }} />
                </div>
                <div className="text-xs font-medium">{p.name}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border border-border rounded-md bg-card p-4 space-y-3">
        <h3 className="text-sm font-semibold">Cores personalizadas</h3>
        <p className="text-[11px] text-muted-foreground">Aceita qualquer formato CSS: <span className="font-mono">#rrggbb</span>, <span className="font-mono">rgb(...)</span>, <span className="font-mono">hsl(...)</span> ou <span className="font-mono">oklch(...)</span>.</p>
        <div className="grid md:grid-cols-3 gap-3">
          <ColorField label="Cor primária" value={b.primary} onChange={(v) => persist({ ...b, primary: v })} />
          <ColorField label="Cor de destaque" value={b.accent} onChange={(v) => persist({ ...b, accent: v })} />
          <ColorField label="Fundo do sistema" value={b.background} onChange={(v) => persist({ ...b, background: v })} />
        </div>
      </div>

      <div className="border border-border rounded-md bg-card p-4 space-y-3">
        <h3 className="text-sm font-semibold">Prévia</h3>
        <div className="flex flex-wrap gap-2">
          <Button>Botão primário</Button>
          <Button variant="outline">Botão secundário</Button>
          <Button variant="destructive">Destrutivo</Button>
          <Badge className="bg-primary text-primary-foreground">Badge primária</Badge>
          <Badge variant="outline" className="border-primary/40 text-primary">Badge outline</Badge>
        </div>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex gap-2 items-center">
        <span className="size-9 rounded border border-border shrink-0" style={{ background: value }} />
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs" />
      </div>
    </div>
  );
}
