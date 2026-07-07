import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Save, ShieldAlert, ShieldCheck, ExternalLink, QrCode } from "lucide-react";
import { buildStaticPixBRCode, generatePixTxid } from "@/lib/pix-brcode";
import QRCode from "qrcode";

interface PixConfig {
  store_id: string;
  mode: "estatico" | "mercadopago" | "efi" | "asaas" | "inter";
  pix_key: string | null;
  pix_key_type: "cpf" | "cnpj" | "email" | "telefone" | "aleatoria" | null;
  merchant_name: string | null;
  merchant_city: string | null;
  environment: "sandbox" | "producao";
  mp_client_id: string | null;
  mp_access_token_set: boolean;
  efi_client_id: string | null;
  efi_client_secret_set: boolean;
  efi_certificate_uploaded: boolean;
  efi_certificate_path: string | null;
  asaas_api_key_set: boolean;
  bank_client_id: string | null;
  bank_client_secret_set: boolean;
  bank_certificate_uploaded: boolean;
  bank_certificate_path: string | null;
  webhook_secret: string | null;
  notes: string | null;
}

const PROVIDER_LABELS: Record<string, { label: string; url: string; secret: string; note: string; supported: boolean }> = {
  estatico: {
    label: "PIX Estático (chave local)",
    url: "https://www.bcb.gov.br/estabilidadefinanceira/pix",
    secret: "—",
    note: "Sem provedor. QR gerado localmente com sua chave. Sem confirmação automática — a venda é marcada como paga manualmente.",
    supported: true,
  },
  mercadopago: {
    label: "Mercado Pago",
    url: "https://www.mercadopago.com.br/developers/pt/docs/checkout-api/payment-methods/receiving-payment-by-pix",
    secret: "PIX_MERCADOPAGO_TOKEN",
    note: "Access token de produção. Menu Suas integrações → Credenciais → Access Token.",
    supported: true,
  },
  asaas: {
    label: "Asaas",
    url: "https://docs.asaas.com/reference/criar-chave-de-cobranca-estatica-qrcode",
    secret: "PIX_ASAAS_TOKEN",
    note: "API Key da conta. Menu Configurações → Integrações → API.",
    supported: true,
  },
  efi: {
    label: "Efí (Gerencianet)",
    url: "https://dev.efipay.com.br/docs/api-pix/credenciais",
    secret: "PIX_EFI_CLIENT_SECRET",
    note: "Requer mTLS com .p12 — não suportado no runtime edge atual. Exige agente Node.js dedicado.",
    supported: false,
  },
  inter: {
    label: "Banco Inter / Sicoob / Sicredi",
    url: "https://developers.bancointer.com.br/reference/pix-authorization",
    secret: "PIX_BANK_CLIENT_SECRET",
    note: "PIX direto pelo banco via Open Finance com mTLS — requer agente dedicado.",
    supported: false,
  },
};

export function PixSettingsTab({ storeId }: { storeId: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<PixConfig | null>(null);
  const [preview, setPreview] = useState<{ brcode: string; qr: string } | null>(null);

  const q = useQuery({
    queryKey: ["pix_configs", storeId],
    enabled: !!storeId,
    queryFn: async (): Promise<PixConfig> => {
      const { data, error } = await supabase.from("pix_configs").select("*").eq("store_id", storeId).maybeSingle();
      if (error) throw error;
      return (data as PixConfig | null) ?? {
        store_id: storeId, mode: "estatico",
        pix_key: null, pix_key_type: null, merchant_name: null, merchant_city: null,
        environment: "sandbox",
        mp_client_id: null, mp_access_token_set: false,
        efi_client_id: null, efi_client_secret_set: false, efi_certificate_uploaded: false, efi_certificate_path: null,
        asaas_api_key_set: false,
        bank_client_id: null, bank_client_secret_set: false, bank_certificate_uploaded: false, bank_certificate_path: null,
        webhook_secret: null, notes: null,
      };
    },
  });

  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form) return;
      const { error } = await supabase.from("pix_configs").upsert(form as never, { onConflict: "store_id" });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("PIX configurado"); qc.invalidateQueries({ queryKey: ["pix_configs"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const testStatic = async () => {
    if (!form?.pix_key || !form.merchant_name || !form.merchant_city) {
      toast.error("Preencha chave, nome e cidade primeiro");
      return;
    }
    try {
      const brcode = buildStaticPixBRCode({
        key: form.pix_key,
        merchantName: form.merchant_name,
        merchantCity: form.merchant_city,
        amount: 1.0,
        txid: generatePixTxid("TEST"),
        description: "Teste PDV",
      });
      const qr = await QRCode.toDataURL(brcode, { errorCorrectionLevel: "M", width: 280, margin: 1 });
      setPreview({ brcode, qr });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao gerar QR");
    }
  };

  if (!form) return <div className="text-sm text-muted-foreground p-4">Carregando...</div>;
  const info = PROVIDER_LABELS[form.mode];

  return (
    <div>
      <div className="flex justify-end gap-2 mb-4">
        <Button variant="outline" className="gap-2" onClick={testStatic}><QrCode className="size-4" /> Testar QR estático</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending} className="gap-2"><Save className="size-4" /> Salvar</Button>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Modo */}
        <div className="border border-border rounded-md bg-card p-4 space-y-3 md:col-span-2">
          <h3 className="text-sm font-semibold">Modo de operação PIX</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {(Object.keys(PROVIDER_LABELS) as Array<keyof typeof PROVIDER_LABELS>).map((mode) => {
              const p = PROVIDER_LABELS[mode];
              const active = form.mode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setForm({ ...form, mode: mode as PixConfig["mode"] })}
                  className={`text-left rounded-sm border p-3 text-xs transition-colors ${active ? "border-primary bg-primary/10" : "border-border hover:bg-accent/40"} ${!p.supported ? "opacity-70" : ""}`}
                >
                  <div className="font-semibold">{p.label}</div>
                  {!p.supported && <Badge variant="outline" className="mt-1 border-warning/40 text-warning text-[9px]">runtime limitado</Badge>}
                </button>
              );
            })}
          </div>
          <div className="border border-info/40 bg-info/5 rounded p-3 text-xs">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-info">{info.label}</div>
              <a href={info.url} target="_blank" rel="noreferrer" className="text-info hover:underline inline-flex items-center gap-1">
                Documentação <ExternalLink className="size-3" />
              </a>
            </div>
            <p className="text-muted-foreground mt-1">{info.note}</p>
            {info.secret !== "—" && (
              <div className="mt-2">Segredo esperado no backend: <span className="font-mono text-foreground">{info.secret}</span></div>
            )}
          </div>
        </div>

        {/* Dados do recebedor (sempre visíveis, usados também no estático) */}
        <div className="border border-border rounded-md bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">Chave PIX do recebedor</h3>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Tipo</Label>
              <Select value={form.pix_key_type ?? ""} onValueChange={(v) => setForm({ ...form, pix_key_type: v as PixConfig["pix_key_type"] })}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cpf">CPF</SelectItem>
                  <SelectItem value="cnpj">CNPJ</SelectItem>
                  <SelectItem value="email">E-mail</SelectItem>
                  <SelectItem value="telefone">Telefone (+55...)</SelectItem>
                  <SelectItem value="aleatoria">Chave aleatória</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Ambiente</Label>
              <Select value={form.environment} onValueChange={(v) => setForm({ ...form, environment: v as "sandbox" | "producao" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sandbox">Sandbox / Homologação</SelectItem>
                  <SelectItem value="producao">Produção</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div><Label>Chave PIX</Label><Input value={form.pix_key ?? ""} onChange={(e) => setForm({ ...form, pix_key: e.target.value || null })} placeholder="chave@dominio.com ou 12345678900" className="font-mono" /></div>
        </div>

        <div className="border border-border rounded-md bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">Recebedor exibido no QR</h3>
          <div><Label>Nome (até 25 letras)</Label><Input value={form.merchant_name ?? ""} onChange={(e) => setForm({ ...form, merchant_name: e.target.value.toUpperCase().slice(0, 25) || null })} placeholder="MINHA LOJA LTDA" /></div>
          <div><Label>Cidade (até 15 letras)</Label><Input value={form.merchant_city ?? ""} onChange={(e) => setForm({ ...form, merchant_city: e.target.value.toUpperCase().slice(0, 15) || null })} placeholder="SAO PAULO" /></div>
        </div>

        {/* Credenciais específicas por provedor */}
        {form.mode === "mercadopago" && (
          <div className="border border-border rounded-md bg-card p-4 space-y-3 md:col-span-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Mercado Pago</h3>
              <Badge variant="outline" className={form.mp_access_token_set ? "border-primary/40 text-primary gap-1" : "border-warning/40 text-warning gap-1"}>
                {form.mp_access_token_set ? <><ShieldCheck className="size-3" /> Backend OK</> : <><ShieldAlert className="size-3" /> Pendente</>}
              </Badge>
            </div>
            <div><Label>Client ID (opcional)</Label><Input value={form.mp_client_id ?? ""} onChange={(e) => setForm({ ...form, mp_client_id: e.target.value || null })} /></div>
            <p className="text-xs text-muted-foreground">O Access Token é um segredo do backend com nome <span className="font-mono">PIX_MERCADOPAGO_TOKEN</span>. Peça para o admin cadastrar via painel de segredos.</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.mp_access_token_set} onChange={(e) => setForm({ ...form, mp_access_token_set: e.target.checked })} /> Já configurei o segredo no backend</label>
          </div>
        )}

        {form.mode === "asaas" && (
          <div className="border border-border rounded-md bg-card p-4 space-y-3 md:col-span-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Asaas</h3>
              <Badge variant="outline" className={form.asaas_api_key_set ? "border-primary/40 text-primary gap-1" : "border-warning/40 text-warning gap-1"}>
                {form.asaas_api_key_set ? <><ShieldCheck className="size-3" /> Backend OK</> : <><ShieldAlert className="size-3" /> Pendente</>}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">API Key no backend como <span className="font-mono">PIX_ASAAS_TOKEN</span>.</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.asaas_api_key_set} onChange={(e) => setForm({ ...form, asaas_api_key_set: e.target.checked })} /> Já configurei o segredo no backend</label>
          </div>
        )}

        {(form.mode === "efi" || form.mode === "inter") && (
          <div className="border border-warning/40 bg-warning/5 rounded-md p-4 space-y-3 md:col-span-2">
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-warning" />
              <h3 className="text-sm font-semibold text-warning">Provedor com mTLS — requer agente dedicado</h3>
            </div>
            <p className="text-xs">
              {form.mode === "efi" ? "Efí" : "Bancos (Inter/Sicoob/Sicredi)"} exige autenticação mútua TLS com certificado .p12,
              recurso não disponível no runtime edge deste PDV. Você pode:
            </p>
            <ol className="text-xs list-decimal ml-5 space-y-1 text-muted-foreground">
              <li>Manter o modo <b>Estático</b> por agora (funciona sem provedor).</li>
              <li>Usar <b>Mercado Pago</b> ou <b>Asaas</b> para PIX dinâmico com confirmação automática.</li>
              <li>Rodar um agente Node.js próprio que exponha uma API compatível — a integração fica pronta pra apontar via variável PIX_{form.mode.toUpperCase()}_AGENT_URL.</li>
            </ol>
          </div>
        )}

        <div className="border border-border rounded-md bg-card p-4 space-y-3 md:col-span-2">
          <Label>Anotações / observações</Label>
          <Textarea rows={2} value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value || null })} placeholder="Ex: chave PIX do CNPJ · webhook validado em 07/2026" />
        </div>

        {preview && (
          <div className="border border-primary/40 bg-primary/5 rounded-md p-4 space-y-3 md:col-span-2">
            <h3 className="text-sm font-semibold">Prévia do QR (R$ 1,00)</h3>
            <div className="flex gap-4 items-start">
              <img src={preview.qr} alt="QR PIX teste" className="border border-border rounded bg-white p-2" />
              <div className="flex-1 min-w-0">
                <Label>Copia-e-cola</Label>
                <Textarea readOnly rows={5} value={preview.brcode} className="font-mono text-[10px]" />
                <p className="text-[10px] text-muted-foreground mt-1">Valide escaneando com o app do seu banco. Se o pagamento for aceito, sua chave está OK.</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
