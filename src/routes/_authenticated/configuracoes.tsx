import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { buildReceiptHTML, printReceipt } from "@/lib/receipt";
import { toast } from "sonner";
import { Save, Printer } from "lucide-react";

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
}

function SettingsPage() {
  const { store, storeId } = useCurrentStore();
  const [form, setForm] = useState<ReceiptSettings | null>(null);

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
      };
    },
  });

  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form) return;
      const { error } = await supabase.from("receipt_settings").upsert(form, { onConflict: "store_id" });
      if (error) throw error;
    },
    onSuccess: () => toast.success("Configurações salvas"),
    onError: (e: Error) => toast.error(e.message),
  });

  if (!store) return <StoreRequired />;
  if (!form) return <div className="p-6 text-sm text-muted-foreground">Carregando...</div>;

  const preview = () => {
    const html = buildReceiptHTML({
      store: { name: store.fantasy_name || store.name, cnpj: store.cnpj, address: [store.city, store.state].filter(Boolean).join(" · ") || null, phone: null },
      header: form.header_text, footer: form.footer_text, paper_width: form.paper_width,
      items: [
        { name: "REFRIGERANTE COLA 2L", quantity: 2, unit_price: 8.5, total: 17, barcode: "7891234567890" },
        { name: "PAO FRANCES KG", quantity: 0.42, unit_price: 15.9, total: 6.68 },
      ],
      subtotal: 23.68, discount: 0, total: 23.68, payment_method: "dinheiro",
      received: 30, change: 6.32, operator: "Operador exemplo", sale_id: "PREVIEW00",
      document_type: form.default_document, issued_at: new Date(),
    });
    printReceipt(html);
  };

  return (
    <div>
      <PageHeader
        title="Configurações · PDV e recibos"
        description="Padrões de impressão, papel, cabeçalho e rodapé"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" className="gap-2" onClick={preview}><Printer className="size-4" />Prévia</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending} className="gap-2"><Save className="size-4" />Salvar</Button>
          </div>
        }
      />
      <div className="p-6 grid md:grid-cols-2 gap-4 max-w-4xl">
        <div className="border border-border rounded-md bg-card p-4 space-y-3 md:col-span-2">
          <h3 className="text-sm font-semibold">Documento padrão emitido pelo PDV</h3>
          <Select value={form.default_document} onValueChange={(v) => setForm({ ...form, default_document: v as ReceiptSettings["default_document"] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="nao_fiscal">Recibo não-fiscal (rápido)</SelectItem>
              <SelectItem value="fiscal">NFC-e (fiscal — requer configuração do módulo fiscal)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">O operador poderá trocar caso-a-caso no PDV.</p>
        </div>

        <div className="border border-border rounded-md bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold">Papel térmico</h3>
          <Select value={String(form.paper_width)} onValueChange={(v) => setForm({ ...form, paper_width: Number(v) as 58 | 80 })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="80">80mm (padrão maioria)</SelectItem>
              <SelectItem value="58">58mm (portátil / bobina pequena)</SelectItem>
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
          <h3 className="text-sm font-semibold">Textos personalizados</h3>
          <div><Label>Cabeçalho (opcional)</Label><Textarea rows={2} value={form.header_text ?? ""} onChange={(e) => setForm({ ...form, header_text: e.target.value || null })} placeholder="Ex: promoção da semana" /></div>
          <div><Label>Rodapé</Label><Textarea rows={2} value={form.footer_text ?? ""} onChange={(e) => setForm({ ...form, footer_text: e.target.value || null })} /></div>
          <div><Label>Logo URL (opcional)</Label><Input value={form.logo_url ?? ""} onChange={(e) => setForm({ ...form, logo_url: e.target.value || null })} placeholder="https://..." /></div>
        </div>
      </div>
    </div>
  );
}
