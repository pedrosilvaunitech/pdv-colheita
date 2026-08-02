import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired, EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Truck, Pencil, Trash2, Package, CalendarClock, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  SupplierPaymentFields,
  PAYMENT_METHODS,
  type SupplierPaymentValue,
} from "@/components/suppliers/supplier-payment-fields";
import { SupplierProductsDialog } from "@/components/suppliers/product-suppliers-dialog";
import { SupplierImportDialog } from "@/components/suppliers/supplier-import-dialog";
import { SupplierLinkAuditCard } from "@/components/suppliers/supplier-link-audit-card";
import { supplierInputSchema, firstIssue } from "@/lib/supplier-validation";

export const Route = createFileRoute("/_authenticated/fornecedores")({
  component: FornecedoresPage,
  head: () => ({
    meta: [
      { title: "Fornecedores e condições de pagamento | PDV" },
      {
        name: "description",
        content:
          "Cadastro de fornecedores com filtros por forma de pagamento, importação em lote e validação dos vínculos com produtos.",
      },
      { property: "og:title", content: "Fornecedores e condições de pagamento | PDV" },
      {
        property: "og:description",
        content: "Filtre por Pix, boleto ou prazo, importe fornecedores em lote e valide vínculos com produtos.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type SupplierForm = SupplierPaymentValue & {
  name: string; cnpj: string; phone: string; email: string;
  city: string; state: string; address_line: string; notes: string;
  contact_name: string;
};

const EMPTY: SupplierForm = {
  name: "", cnpj: "", phone: "", email: "", city: "", state: "",
  address_line: "", notes: "", contact_name: "",
  payment_methods: [], payment_day: "", payment_term_days: "",
  payment_condition: "", pix_key: "", pix_key_type: "", lead_time_days: "",
};

interface SupplierRow extends SupplierForm { id: string }

const METHOD_LABEL = new Map<string, string>(
  PAYMENT_METHODS.map((m) => [String(m.value), String(m.label)]),
);

/** Filtro financeiro: à vista, faturado, ou por dia fixo de vencimento. */
type TermFilter = "all" | "avista" | "prazo" | "dia_fixo" | "sem_condicao";

function FornecedoresPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [openNew, setOpenNew] = useState(false);
  const [openImport, setOpenImport] = useState(false);
  const [editing, setEditing] = useState<SupplierRow | null>(null);
  const [form, setForm] = useState<SupplierForm>(EMPTY);
  /** Fornecedor cujo catálogo de produtos está aberto. */
  const [productsFor, setProductsFor] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState("");
  const [methodFilter, setMethodFilter] = useState<string>("all");
  const [termFilter, setTermFilter] = useState<TermFilter>("all");

  const { data } = useQuery({
    queryKey: ["suppliers", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("*").eq("store_id", storeId!).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  /** Quantos produtos cada fornecedor atende — mostrado na listagem. */
  const { data: linkCounts } = useQuery({
    queryKey: ["product-suppliers", "counts", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_suppliers").select("supplier_id").eq("store_id", storeId!);
      if (error) throw new Error(error.message);
      const map = new Map<string, number>();
      for (const row of data ?? []) {
        map.set(row.supplier_id, (map.get(row.supplier_id) ?? 0) + 1);
      }
      return map;
    },
  });

  const toInt = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  };

  /**
   * Normaliza o formulário e aplica as regras de negócio (Zod) antes de tocar o
   * banco: CNPJ com dígito verificador, e-mail, telefone com DDD e chave Pix
   * obrigatória quando a forma Pix está marcada.
   */
  const toPayload = (f: SupplierForm) => {
    const parsed = supplierInputSchema.parse({
      name: f.name,
      cnpj: f.cnpj,
      phone: f.phone,
      email: f.email,
      contact_name: f.contact_name,
      city: f.city,
      state: f.state.toUpperCase(),
      address_line: f.address_line,
      notes: f.notes,
      payment_methods: f.payment_methods,
      payment_day: f.payment_day ? Math.min(31, Math.max(1, toInt(f.payment_day))) : null,
      payment_term_days: toInt(f.payment_term_days),
      payment_condition: f.payment_condition,
      pix_key: f.pix_key,
      pix_key_type: f.pix_key_type,
      lead_time_days: toInt(f.lead_time_days),
    });

    return {
      name: parsed.name,
      cnpj: parsed.cnpj || null, phone: parsed.phone || null, email: parsed.email || null,
      city: parsed.city || null, state: parsed.state ? parsed.state.toUpperCase() : null,
      address_line: parsed.address_line || null, notes: parsed.notes || null,
      contact_name: parsed.contact_name || null,
      payment_methods: parsed.payment_methods,
      payment_day: parsed.payment_day,
      payment_term_days: parsed.payment_term_days,
      payment_condition: parsed.payment_condition || null,
      pix_key: parsed.payment_methods.includes("pix") ? (parsed.pix_key || null) : null,
      pix_key_type: parsed.payment_methods.includes("pix") ? (parsed.pix_key_type || null) : null,
      lead_time_days: parsed.lead_time_days,
    };
  };

  const create = useMutation({
    mutationFn: async () => {
      const payload = toPayload(form);
      const { error } = await supabase.from("suppliers").insert({ store_id: storeId!, ...payload });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Fornecedor cadastrado");
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      setOpenNew(false); setForm(EMPTY);
    },
    onError: (e: unknown) => toast.error(firstIssue(e)),
  });

  const update = useMutation({
    mutationFn: async () => {
      if (!editing) throw new Error("Nada para editar");
      const payload = toPayload(form);
      const { error } = await supabase.from("suppliers").update(payload).eq("id", editing.id).eq("store_id", storeId!);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Fornecedor atualizado");
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      setEditing(null); setForm(EMPTY);
    },
    onError: (e: unknown) => toast.error(firstIssue(e)),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("suppliers").delete().eq("id", id).eq("store_id", storeId!);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Fornecedor removido");
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["product-suppliers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const startEdit = (raw: Record<string, unknown>) => {
    const str = (k: string) => (raw[k] as string | null) ?? "";
    const num = (k: string) => (raw[k] == null ? "" : String(raw[k]));
    const s: SupplierRow = {
      id: String(raw.id),
      name: str("name"), cnpj: str("cnpj"), phone: str("phone"), email: str("email"),
      city: str("city"), state: str("state"), address_line: str("address_line"),
      notes: str("notes"), contact_name: str("contact_name"),
      payment_methods: Array.isArray(raw.payment_methods) ? (raw.payment_methods as string[]) : [],
      payment_day: num("payment_day"),
      payment_term_days: num("payment_term_days"),
      payment_condition: str("payment_condition"),
      pix_key: str("pix_key"), pix_key_type: str("pix_key_type"),
      lead_time_days: num("lead_time_days"),
    };
    setEditing(s);
    const { id: _id, ...rest } = s;
    setForm(rest);
  };

  /** Lista filtrada por texto, forma de pagamento e condição financeira. */
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data ?? []).filter((s) => {
      const methods = Array.isArray(s.payment_methods) ? (s.payment_methods as string[]) : [];
      const day = s.payment_day == null ? 0 : Number(s.payment_day);
      const termDays = Number(s.payment_term_days ?? 0);

      if (methodFilter !== "all" && !methods.includes(methodFilter)) return false;

      if (termFilter === "avista" && termDays > 0) return false;
      if (termFilter === "prazo" && termDays <= 0) return false;
      if (termFilter === "dia_fixo" && !day) return false;
      if (termFilter === "sem_condicao" && (methods.length > 0 || termDays > 0 || day)) return false;

      if (!term) return true;
      return [s.name, s.cnpj, s.contact_name, s.phone, s.email, s.city, s.pix_key]
        .some((v) => (v ?? "").toString().toLowerCase().includes(term));
    });
  }, [data, search, methodFilter, termFilter]);

  if (!store) return <StoreRequired />;

  const editorOpen = openNew || !!editing;
  const closeEditor = () => { setOpenNew(false); setEditing(null); setForm(EMPTY); };

  return (
    <div>
      <PageHeader
        title="Fornecedores"
        description="Cadastro de fornecedores, produtos que cada um atende e condições de pagamento."
        actions={
          <>
            <Button size="sm" variant="outline" className="gap-2" onClick={() => setOpenImport(true)}>
              <Upload className="size-4" /> Importar em lote
            </Button>
            <Button size="sm" className="gap-2" onClick={() => { setForm(EMPTY); setOpenNew(true); }}>
              <Plus className="size-4" /> Novo fornecedor
            </Button>
          </>
        }
      />

      <Dialog open={editorOpen} onOpenChange={(o) => !o && closeEditor()}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing ? "Editar fornecedor" : "Novo fornecedor"}</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); editing ? update.mutate() : create.mutate(); }} className="grid grid-cols-2 gap-3">
            <FF label="Razão social / nome" cn="col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={140} /></FF>
            <FF label="CNPJ"><Input className="font-mono" value={form.cnpj} onChange={(e) => setForm({ ...form, cnpj: e.target.value })} maxLength={20} /></FF>
            <FF label="Telefone"><Input className="font-mono" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={30} /></FF>
            <FF label="Pessoa de contato"><Input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} maxLength={120} /></FF>
            <FF label="E-mail"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={200} /></FF>
            <FF label="Endereço" cn="col-span-2"><Input value={form.address_line} onChange={(e) => setForm({ ...form, address_line: e.target.value })} maxLength={200} /></FF>
            <FF label="Cidade"><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} maxLength={100} /></FF>
            <FF label="UF"><Input maxLength={2} className="uppercase" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} /></FF>

            <SupplierPaymentFields
              value={form}
              onChange={(next) => setForm({ ...form, ...next })}
            />

            <FF label="Observações" cn="col-span-2"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} maxLength={1000} /></FF>
            <DialogFooter className="col-span-2 gap-2">
              <Button type="button" variant="outline" onClick={closeEditor}>Cancelar</Button>
              <Button type="submit" disabled={create.isPending || update.isPending}>
                {editing ? (update.isPending ? "Salvando…" : "Salvar alterações") : (create.isPending ? "Salvando…" : "Cadastrar")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {storeId && (
        <>
          <SupplierProductsDialog
            storeId={storeId}
            supplier={productsFor}
            onOpenChange={(o) => !o && setProductsFor(null)}
          />
          <SupplierImportDialog
            storeId={storeId}
            open={openImport}
            onOpenChange={setOpenImport}
            existing={(data ?? []).map((s) => ({ name: s.name, cnpj: s.cnpj ?? null }))}
          />
        </>
      )}

      <div className="p-6 space-y-4">
        {storeId && (
          <SupplierLinkAuditCard
            storeId={storeId}
            onOpenSupplier={(supplierId) => {
              const s = (data ?? []).find((row) => row.id === supplierId);
              if (s) setProductsFor({ id: s.id, name: s.name });
            }}
          />
        )}

        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search className="size-4 absolute left-2 top-2.5 text-muted-foreground" />
            <Input
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome, CNPJ, contato, cidade ou chave Pix"
            />
          </div>
          <Select value={methodFilter} onValueChange={setMethodFilter}>
            <SelectTrigger className="w-full md:w-52"><SelectValue placeholder="Forma de pagamento" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as formas</SelectItem>
              {PAYMENT_METHODS.map((m) => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={termFilter} onValueChange={(v) => setTermFilter(v as TermFilter)}>
            <SelectTrigger className="w-full md:w-52"><SelectValue placeholder="Condição" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Qualquer condição</SelectItem>
              <SelectItem value="avista">À vista (sem prazo)</SelectItem>
              <SelectItem value="prazo">Faturado (com prazo)</SelectItem>
              <SelectItem value="dia_fixo">Com dia fixo de pagamento</SelectItem>
              <SelectItem value="sem_condicao">Sem condição definida</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="text-xs text-muted-foreground font-mono">
          {filtered.length} de {(data ?? []).length} fornecedor(es)
        </div>

        <div className="border border-border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fornecedor</TableHead>
                <TableHead className="w-36 font-mono text-xs">CNPJ</TableHead>
                <TableHead className="w-40">Contato</TableHead>
                <TableHead className="w-48">Pagamento</TableHead>
                <TableHead className="w-28 text-right">Produtos</TableHead>
                <TableHead className="w-32 text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow><TableCell colSpan={6} className="p-0">
                  <EmptyState
                    title={(data ?? []).length === 0 ? "Nenhum fornecedor" : "Nenhum resultado"}
                    description={
                      (data ?? []).length === 0
                        ? "Cadastre fornecedores, vincule os produtos que eles atendem e defina as condições de pagamento."
                        : "Nenhum fornecedor atende aos filtros de pagamento selecionados."
                    }
                  />
                </TableCell></TableRow>
              )}
              {filtered.map((s) => {
                const methods = Array.isArray(s.payment_methods) ? (s.payment_methods as string[]) : [];
                const count = linkCounts?.get(s.id) ?? 0;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2"><Truck className="size-4 text-muted-foreground" />{s.name}</div>
                      {s.contact_name && <div className="text-xs text-muted-foreground ml-6">{s.contact_name}</div>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.cnpj || "—"}</TableCell>
                    <TableCell className="text-xs">{[s.phone, s.email].filter(Boolean).join(" · ") || "—"}</TableCell>
                    <TableCell className="text-xs">
                      <div className="flex flex-wrap gap-1">
                        {methods.length === 0 && <span className="text-muted-foreground">—</span>}
                        {methods.map((m) => (
                          <Badge key={m} variant="outline" className="text-[10px]">{METHOD_LABEL.get(m) ?? m}</Badge>
                        ))}
                      </div>
                      {(s.payment_day || Number(s.payment_term_days) > 0) && (
                        <div className="mt-1 flex items-center gap-1 text-muted-foreground">
                          <CalendarClock className="size-3" />
                          {s.payment_day ? `dia ${s.payment_day}` : null}
                          {s.payment_day && Number(s.payment_term_days) > 0 ? " · " : null}
                          {Number(s.payment_term_days) > 0 ? `${s.payment_term_days}d` : null}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm" variant="outline" className="gap-1 font-mono"
                        onClick={() => setProductsFor({ id: s.id, name: s.name })}
                      >
                        <Package className="size-3.5" /> {count}
                      </Button>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => startEdit(s as unknown as Record<string, unknown>)} title="Editar">
                          <Pencil className="size-4" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => {
                          if (confirm(`Remover o fornecedor "${s.name}"?`)) remove.mutate(s.id);
                        }} title="Remover">
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function FF({ label, cn: c, children }: { label: string; cn?: string; children: React.ReactNode }) {
  return <div className={c}><Label className="text-xs">{label}</Label><div className="mt-1">{children}</div></div>;
}
