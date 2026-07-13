import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Plus, Trash2, ScanBarcode, X, Utensils, ChevronRight, Ban, ReceiptText } from "lucide-react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/comandas")({
  component: ComandasPage,
});

interface ComandaRow {
  id: string;
  number: number;
  label: string | null;
  status: "aberta" | "fechada" | "cancelada";
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
}
interface ComandaItemRow {
  id: string;
  product_id: string | null;
  product_name: string;
  barcode: string | null;
  quantity: number;
  unit_price: number;
  note: string | null;
  created_at: string;
}

function brl(v: number) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

function ComandasPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const comandas = useQuery({
    queryKey: ["comandas", storeId],
    enabled: !!storeId,
    queryFn: async (): Promise<ComandaRow[]> => {
      const { data, error } = await supabase.from("comandas")
        .select("id,number,label,status,opened_at,closed_at,notes")
        .eq("store_id", storeId!)
        .order("status", { ascending: true })
        .order("number", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ComandaRow[];
    },
  });

  const abertas = useMemo(() => (comandas.data ?? []).filter(c => c.status === "aberta"), [comandas.data]);
  const outras = useMemo(() => (comandas.data ?? []).filter(c => c.status !== "aberta").slice(0, 30), [comandas.data]);

  if (!store) return <StoreRequired />;

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Comandas · Consumo no local"
        description="Abra comandas por mesa ou cliente, lance itens durante o consumo e feche direto no PDV."
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm"><Link to="/pdv">Ir para o PDV</Link></Button>
            <Button size="sm" onClick={() => setNewOpen(true)} className="gap-2"><Plus className="size-4" /> Nova comanda</Button>
          </div>
        }
      />

      <div className="flex-1 grid grid-cols-3 gap-4 p-6 overflow-hidden">
        <div className="col-span-1 flex flex-col gap-4 min-h-0">
          <section className="border border-border rounded-md bg-card flex-1 overflow-auto min-h-0">
            <header className="sticky top-0 bg-card border-b border-border px-4 py-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Abertas · {abertas.length}
            </header>
            {abertas.length === 0 && <div className="px-4 py-8 text-sm text-muted-foreground text-center">Nenhuma comanda aberta.</div>}
            <div className="divide-y divide-border">
              {abertas.map(c => (
                <button key={c.id} onClick={() => setOpenId(c.id)}
                  className={`w-full text-left px-4 py-3 hover:bg-accent/50 flex items-center gap-3 ${openId === c.id ? "bg-accent/50" : ""}`}>
                  <div className="size-10 rounded bg-primary/10 text-primary font-mono font-bold flex items-center justify-center">{c.number}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{c.label || `Comanda #${c.number}`}</div>
                    <div className="text-[11px] font-mono text-muted-foreground">Aberta {new Date(c.opened_at).toLocaleString("pt-BR")}</div>
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          </section>

          {outras.length > 0 && (
            <section className="border border-border rounded-md bg-card overflow-auto max-h-64">
              <header className="sticky top-0 bg-card border-b border-border px-4 py-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Histórico recente</header>
              <div className="divide-y divide-border">
                {outras.map(c => (
                  <div key={c.id} className="px-4 py-2 flex items-center gap-3 text-xs">
                    <div className={`size-6 rounded text-[10px] font-mono font-bold flex items-center justify-center ${c.status === "fechada" ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"}`}>{c.number}</div>
                    <div className="flex-1 min-w-0 truncate">{c.label || `#${c.number}`}</div>
                    <span className="text-[10px] font-mono uppercase text-muted-foreground">{c.status}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="col-span-2 min-h-0 overflow-auto">
          {openId ? <ComandaDetail comandaId={openId} storeId={storeId!} onClose={() => setOpenId(null)} onChanged={() => qc.invalidateQueries({ queryKey: ["comandas"] })} /> : (
            <div className="h-full flex items-center justify-center border border-dashed border-border rounded-md bg-card">
              <div className="text-center text-sm text-muted-foreground">
                <Utensils className="size-10 mx-auto mb-3 opacity-40" />
                Selecione uma comanda à esquerda ou crie uma nova.
              </div>
            </div>
          )}
        </div>
      </div>

      {storeId && <NewComandaDialog open={newOpen} onOpenChange={setNewOpen} storeId={storeId} onCreated={(id) => { setOpenId(id); qc.invalidateQueries({ queryKey: ["comandas"] }); }} />}
    </div>
  );
}

function NewComandaDialog({ open, onOpenChange, storeId, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; storeId: string; onCreated: (id: string) => void }) {
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const mut = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      const { data, error } = await supabase.from("comandas").insert({
        store_id: storeId, label: label.trim() || null, notes: notes.trim() || null,
        opened_by: u.user?.id ?? null,
      }).select("id,number").single();
      if (error) throw error;
      return data;
    },
    onSuccess: (row) => { toast.success(`Comanda #${row.number} aberta`); setLabel(""); setNotes(""); onOpenChange(false); onCreated(row.id); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Nova comanda</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Identificação (mesa, cliente…)</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex: Mesa 5, João, Balcão 2" autoFocus /></div>
          <div><Label>Observação (opcional)</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex: aniversário, sem serviço 10%" /></div>
          <div className="text-[11px] text-muted-foreground">O número é gerado automaticamente para esta loja.</div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>Abrir comanda</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ComandaDetail({ comandaId, storeId, onClose, onChanged }: { comandaId: string; storeId: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const [scan, setScan] = useState("");
  const [qtyOverride, setQtyOverride] = useState<string>("1");
  const [note, setNote] = useState("");
  const scanRef = useRef<HTMLInputElement>(null);

  const comanda = useQuery({
    queryKey: ["comanda", comandaId],
    queryFn: async () => {
      const { data, error } = await supabase.from("comandas").select("id,number,label,status,opened_at,closed_at,notes").eq("id", comandaId).single();
      if (error) throw error;
      return data as ComandaRow;
    },
  });
  const items = useQuery({
    queryKey: ["comanda_items", comandaId],
    queryFn: async () => {
      const { data, error } = await supabase.from("comanda_items")
        .select("id,product_id,product_name,barcode,quantity,unit_price,note,created_at")
        .eq("comanda_id", comandaId).order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ComandaItemRow[];
    },
  });

  useEffect(() => { scanRef.current?.focus(); }, [comandaId]);

  const total = useMemo(() => (items.data ?? []).reduce((s, i) => s + i.quantity * i.unit_price, 0), [items.data]);
  const readOnly = comanda.data?.status !== "aberta";

  const addItem = useMutation({
    mutationFn: async () => {
      const code = scan.trim();
      if (!code) throw new Error("Digite ou bipe o código");
      const { data: p, error } = await supabase.from("products")
        .select("id,name,barcode,price_sell").eq("store_id", storeId).eq("barcode", code).eq("active", true).maybeSingle();
      if (error) throw error;
      if (!p) throw new Error(`Código ${code} não encontrado`);
      const qty = Number(qtyOverride || "1"); if (!Number.isFinite(qty) || qty <= 0) throw new Error("Qtd inválida");
      const { data: u } = await supabase.auth.getUser();
      const { error: e2 } = await supabase.from("comanda_items").insert({
        comanda_id: comandaId, store_id: storeId, product_id: p.id, product_name: p.name,
        barcode: p.barcode, quantity: qty, unit_price: Number(p.price_sell), note: note.trim() || null,
        created_by: u.user?.id ?? null,
      });
      if (e2) throw e2;
      return p.name;
    },
    onSuccess: (name) => { toast.success(`+ ${name}`); setScan(""); setQtyOverride("1"); setNote(""); qc.invalidateQueries({ queryKey: ["comanda_items", comandaId] }); scanRef.current?.focus(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeItem = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("comanda_items").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comanda_items", comandaId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelComanda = useMutation({
    mutationFn: async () => {
      if (!confirm("Cancelar esta comanda? Os itens ficam registrados mas não geram venda.")) throw new Error("cancelado");
      const { error } = await supabase.from("comandas").update({ status: "cancelada", closed_at: new Date().toISOString() }).eq("id", comandaId);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Comanda cancelada"); onChanged(); qc.invalidateQueries({ queryKey: ["comanda", comandaId] }); },
    onError: (e: Error) => { if (e.message !== "cancelado") toast.error(e.message); },
  });

  if (comanda.isLoading || !comanda.data) return <div className="p-6 text-sm text-muted-foreground">Carregando…</div>;

  return (
    <div className="flex flex-col gap-4 h-full">
      <header className="flex items-start justify-between gap-3 border border-border rounded-md bg-card p-4">
        <div>
          <div className="text-[10px] font-mono uppercase text-muted-foreground">Comanda</div>
          <div className="text-3xl font-mono font-bold text-primary">#{comanda.data.number}</div>
          <div className="text-sm">{comanda.data.label || "—"}</div>
          <div className="text-[11px] font-mono text-muted-foreground mt-1">
            Aberta {new Date(comanda.data.opened_at).toLocaleString("pt-BR")} · Status <span className="uppercase">{comanda.data.status}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-mono uppercase text-muted-foreground">Total</div>
          <div className="text-4xl font-mono font-bold">{brl(total)}</div>
          <div className="text-[11px] text-muted-foreground">{items.data?.length ?? 0} item(ns)</div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}><X className="size-4" /></Button>
      </header>

      {!readOnly && (
        <form onSubmit={(e) => { e.preventDefault(); addItem.mutate(); }} className="border border-border rounded-md bg-card p-3 grid grid-cols-[auto_1fr_5rem_1fr_auto] gap-2 items-center">
          <ScanBarcode className="size-5 text-primary" />
          <Input ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Bipe/digite código do produto" className="font-mono" />
          <Input value={qtyOverride} onChange={(e) => setQtyOverride(e.target.value)} type="number" step="0.001" min="0.001" className="font-mono text-right" />
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observação (ex.: sem cebola)" />
          <Button type="submit" className="gap-2" disabled={addItem.isPending}><Plus className="size-4" /> Lançar</Button>
        </form>
      )}

      <div className="flex-1 border border-border rounded-md bg-card overflow-auto min-h-0">
        <Table>
          <TableHeader className="sticky top-0 bg-card z-10">
            <TableRow>
              <TableHead>Produto</TableHead>
              <TableHead className="w-40">Obs.</TableHead>
              <TableHead className="w-20 text-right">Qtd</TableHead>
              <TableHead className="w-24 text-right">Unit.</TableHead>
              <TableHead className="w-28 text-right">Total</TableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(items.data ?? []).length === 0 && <TableRow><TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">Nenhum item lançado.</TableCell></TableRow>}
            {(items.data ?? []).map(i => (
              <TableRow key={i.id}>
                <TableCell>{i.product_name}<div className="text-[10px] font-mono text-muted-foreground">{i.barcode || "—"}</div></TableCell>
                <TableCell className="text-xs text-muted-foreground">{i.note || "—"}</TableCell>
                <TableCell className="text-right font-mono">{i.quantity}</TableCell>
                <TableCell className="text-right font-mono">{brl(i.unit_price)}</TableCell>
                <TableCell className="text-right font-mono font-semibold">{brl(i.quantity * i.unit_price)}</TableCell>
                <TableCell>
                  {!readOnly && <Button variant="ghost" size="icon" onClick={() => removeItem.mutate(i.id)}><Trash2 className="size-4 text-destructive" /></Button>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {!readOnly && (
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" className="gap-2 text-destructive" onClick={() => cancelComanda.mutate()}><Ban className="size-4" /> Cancelar comanda</Button>
          <Button asChild size="lg" className="gap-2">
            <Link to="/pdv" search={{ comanda: comanda.data.number } as never}>
              <ReceiptText className="size-5" /> Fechar no PDV
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
