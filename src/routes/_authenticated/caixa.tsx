import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Wallet, LockOpen, Lock, ArrowDownCircle, ArrowUpCircle, Receipt } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/caixa")({ component: CaixaPage });

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function CaixaPage() {
  const { store, storeId } = useCurrentStore();
  const qc = useQueryClient();

  const openReg = useQuery({
    queryKey: ["cash_open", storeId],
    enabled: !!storeId,
    queryFn: async () => {
      const { data, error } = await supabase.from("cash_registers")
        .select("*").eq("store_id", storeId!).eq("status", "aberto")
        .order("opened_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const history = useQuery({
    queryKey: ["cash_history", storeId],
    enabled: !!storeId,
    queryFn: async () => {
      const { data, error } = await supabase.from("cash_registers")
        .select("*").eq("store_id", storeId!).order("opened_at", { ascending: false }).limit(30);
      if (error) throw error;
      return data ?? [];
    },
  });

  const movements = useQuery({
    queryKey: ["cash_mov", openReg.data?.id],
    enabled: !!openReg.data?.id,
    queryFn: async () => {
      const { data, error } = await supabase.from("cash_movements")
        .select("*").eq("cash_register_id", openReg.data!.id).order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const salesSummary = useQuery({
    queryKey: ["cash_sales", openReg.data?.id],
    enabled: !!openReg.data?.id,
    queryFn: async () => {
      const { data, error } = await supabase.from("sale_payments")
        .select("method, amount, sales!inner(cash_register_id, status)")
        .eq("sales.cash_register_id", openReg.data!.id)
        .eq("sales.status", "finalizada");
      if (error) throw error;
      const totals: Record<string, number> = {};
      let total = 0;
      for (const row of (data ?? []) as Array<{ method: string; amount: number }>) {
        totals[row.method] = (totals[row.method] || 0) + Number(row.amount);
        total += Number(row.amount);
      }
      return { totals, total };
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["cash_open"] });
    qc.invalidateQueries({ queryKey: ["cash_history"] });
    qc.invalidateQueries({ queryKey: ["cash_mov"] });
    qc.invalidateQueries({ queryKey: ["cash_sales"] });
  };

  const operatorIds = useMemo(() => {
    const ids = new Set<string>();
    if (openReg.data?.opened_by) ids.add(openReg.data.opened_by);
    if (openReg.data?.closed_by) ids.add(openReg.data.closed_by);
    for (const h of history.data ?? []) {
      if (h.opened_by) ids.add(h.opened_by);
      if (h.closed_by) ids.add(h.closed_by);
    }
    for (const m of movements.data ?? []) {
      if (m.created_by) ids.add(m.created_by);
    }
    return Array.from(ids);
  }, [history.data, movements.data, openReg.data]);

  const profiles = useQuery({
    queryKey: ["cash_operator_profiles", operatorIds],
    enabled: operatorIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", operatorIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  const profileMap = useMemo(() => Object.fromEntries((profiles.data ?? []).map((p) => [p.id, p])), [profiles.data]);
  const userBadge = (id?: string | null) => {
    if (!id) return "—";
    const p = profileMap[id];
    return `${p?.full_name || p?.email || "Usuário"} · ${id.slice(0, 8).toUpperCase()}`;
  };

  if (!store) return <StoreRequired />;

  const cashIn =
    Number(openReg.data?.opening_amount ?? 0)
    + Number(salesSummary.data?.totals["dinheiro"] ?? 0)
    + (movements.data ?? []).filter((m) => m.type === "suprimento" || m.type === "reforco").reduce((s, m) => s + Number(m.amount), 0)
    - (movements.data ?? []).filter((m) => m.type === "sangria" || m.type === "retirada").reduce((s, m) => s + Number(m.amount), 0);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Caixa · Sessão operacional"
        description={`Loja ${store.fantasy_name || store.name}`}
        actions={
          openReg.data ? (
            <CloseRegisterDialog reg={openReg.data} expected={cashIn} onDone={invalidate} />
          ) : (
            <OpenRegisterDialog storeId={storeId!} onDone={invalidate} />
          )
        }
      />

      <div className="p-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="Status" value={openReg.data ? "ABERTO" : "FECHADO"} tone={openReg.data ? "primary" : "warning"} icon={openReg.data ? LockOpen : Lock} />
            <Kpi label="Abertura" value={brl(Number(openReg.data?.opening_amount ?? 0))} icon={Wallet} />
            <Kpi label="Vendas (todas formas)" value={brl(salesSummary.data?.total ?? 0)} icon={Receipt} />
            <Kpi label="Dinheiro esperado" value={brl(cashIn)} tone="primary" icon={Wallet} />
          </div>

          <div className="border border-border rounded-md bg-card">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Movimentações do caixa</h3>
                <p className="text-[11px] font-mono uppercase text-muted-foreground">Sangria, suprimento, reforço, retirada</p>
              </div>
              {openReg.data && <NewMovementDialog reg={openReg.data} onDone={invalidate} />}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Hora</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Operador</TableHead>
                  <TableHead>Motivo</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(movements.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center py-10 text-sm text-muted-foreground">Nenhuma movimentação.</TableCell></TableRow>
                )}
                {(movements.data ?? []).map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-mono text-xs">{new Date(m.created_at).toLocaleTimeString("pt-BR")}</TableCell>
                    <TableCell><Badge variant="outline" className="uppercase text-[10px]">{m.type}</Badge></TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{userBadge(m.created_by)}</TableCell>
                    <TableCell className="text-sm">{m.reason || "—"}</TableCell>
                    <TableCell className={`text-right font-mono ${m.type === "sangria" || m.type === "retirada" ? "text-destructive" : "text-primary"}`}>
                      {m.type === "sangria" || m.type === "retirada" ? "-" : "+"}{brl(Number(m.amount))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="border border-border rounded-md bg-card">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold">Histórico de sessões</h3>
              <p className="text-[11px] font-mono uppercase text-muted-foreground">Últimas 30 aberturas de caixa</p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Abertura</TableHead>
                  <TableHead>Aberto por</TableHead>
                  <TableHead>Fechamento</TableHead>
                  <TableHead>Fechado por</TableHead>
                  <TableHead>Terminal</TableHead>
                  <TableHead className="text-right">Abertura</TableHead>
                  <TableHead className="text-right">Esperado</TableHead>
                  <TableHead className="text-right">Contado</TableHead>
                  <TableHead className="text-right">Diferença</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(history.data ?? []).map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="font-mono text-xs">{new Date(h.opened_at).toLocaleString("pt-BR")}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{userBadge(h.opened_by)}</TableCell>
                    <TableCell className="font-mono text-xs">{h.closed_at ? new Date(h.closed_at).toLocaleString("pt-BR") : <Badge className="bg-primary/10 text-primary border-primary/30">ABERTO</Badge>}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{userBadge(h.closed_by)}</TableCell>
                    <TableCell className="font-mono text-xs">{h.terminal}</TableCell>
                    <TableCell className="text-right font-mono">{brl(Number(h.opening_amount))}</TableCell>
                    <TableCell className="text-right font-mono">{h.expected_amount != null ? brl(Number(h.expected_amount)) : "—"}</TableCell>
                    <TableCell className="text-right font-mono">{h.closing_amount != null ? brl(Number(h.closing_amount)) : "—"}</TableCell>
                    <TableCell className={`text-right font-mono ${Number(h.difference ?? 0) < 0 ? "text-destructive" : Number(h.difference ?? 0) > 0 ? "text-warning" : ""}`}>
                      {h.difference != null ? brl(Number(h.difference)) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className="space-y-4">
          <div className="border border-border rounded-md bg-card p-4">
            <h3 className="text-sm font-semibold mb-3">Relatório Z (sessão atual)</h3>
            {!openReg.data ? (
              <p className="text-xs text-muted-foreground">Nenhum caixa aberto.</p>
            ) : (
              <div className="space-y-2 text-sm">
                {Object.entries(salesSummary.data?.totals ?? {}).map(([m, v]) => (
                  <div key={m} className="flex justify-between font-mono">
                    <span className="uppercase text-xs text-muted-foreground">{m}</span>
                    <span>{brl(v)}</span>
                  </div>
                ))}
                <div className="flex justify-between font-mono border-t border-border pt-2 mt-2">
                  <span className="text-xs text-muted-foreground">TOTAL VENDAS</span>
                  <span className="font-semibold text-primary">{brl(salesSummary.data?.total ?? 0)}</span>
                </div>
                <div className="flex justify-between font-mono">
                  <span className="text-xs text-muted-foreground">DINHEIRO EM CAIXA</span>
                  <span className="font-semibold">{brl(cashIn)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, icon: Icon, tone = "default" }: { label: string; value: string; icon: React.ComponentType<{ className?: string }>; tone?: "default" | "primary" | "warning" }) {
  const toneCls = tone === "primary" ? "text-primary" : tone === "warning" ? "text-warning" : "text-foreground";
  return (
    <div className="border border-border rounded-md bg-card p-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</div>
        <Icon className={`size-4 ${toneCls}`} />
      </div>
      <div className={`text-xl font-mono font-bold mt-1 ${toneCls}`}>{value}</div>
    </div>
  );
}

function OpenRegisterDialog({ storeId, onDone }: { storeId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("0");
  const [terminal, setTerminal] = useState("PDV-01");
  const [notes, setNotes] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Não autenticado");
      const { error } = await supabase.from("cash_registers").insert({
        store_id: storeId, terminal, opened_by: u.user.id,
        opening_amount: Number(amount) || 0, notes: notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Caixa aberto"); setOpen(false); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button className="gap-2"><LockOpen className="size-4" />Abrir caixa</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Abertura de caixa</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Terminal</Label><Input value={terminal} onChange={(e) => setTerminal(e.target.value)} /></div>
          <div><Label>Fundo de troco (R$)</Label><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" /></div>
          <div><Label>Observações</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>Abrir</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseRegisterDialog({ reg, expected, onDone }: { reg: { id: string }; expected: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Não autenticado");
      const c = Number(counted) || 0;
      const { error } = await supabase.from("cash_registers").update({
        status: "fechado", closed_by: u.user.id, closed_at: new Date().toISOString(),
        closing_amount: c, expected_amount: expected, difference: c - expected,
        notes: notes || null,
      }).eq("id", reg.id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Caixa fechado"); setOpen(false); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const diff = (Number(counted) || 0) - expected;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="destructive" className="gap-2"><Lock className="size-4" />Fechar caixa</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Fechamento de caixa (contagem cega)</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">Digite o valor <b>contado fisicamente</b> em dinheiro. O sistema calcula a diferença.</div>
          <div><Label>Valor contado (R$)</Label><Input autoFocus type="number" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} className="font-mono text-lg" /></div>
          {counted && (
            <div className="border border-border rounded-md p-3 space-y-1 font-mono text-sm">
              <div className="flex justify-between"><span>Esperado</span><span>{brl(expected)}</span></div>
              <div className="flex justify-between"><span>Contado</span><span>{brl(Number(counted))}</span></div>
              <div className={`flex justify-between font-bold ${diff < 0 ? "text-destructive" : diff > 0 ? "text-warning" : "text-primary"}`}>
                <span>Diferença</span><span>{brl(diff)}</span>
              </div>
            </div>
          )}
          <div><Label>Observações</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button variant="destructive" onClick={() => mut.mutate()} disabled={mut.isPending || !counted}>Fechar caixa</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewMovementDialog({ reg, onDone }: { reg: { id: string; store_id: string }; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"sangria" | "suprimento" | "reforco" | "retirada">("sangria");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Não autenticado");
      const { error } = await supabase.from("cash_movements").insert({
        cash_register_id: reg.id, store_id: reg.store_id,
        type, amount: Number(amount), reason: reason || null, created_by: u.user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Movimentação registrada"); setOpen(false); setAmount(""); setReason(""); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2">
          <ArrowDownCircle className="size-4" />Nova movimentação
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Nova movimentação de caixa</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Tipo</Label>
            <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sangria"><span className="inline-flex items-center gap-2"><ArrowDownCircle className="size-4 text-destructive" />Sangria (retira dinheiro)</span></SelectItem>
                <SelectItem value="retirada"><span className="inline-flex items-center gap-2"><ArrowDownCircle className="size-4 text-destructive" />Retirada (despesa)</span></SelectItem>
                <SelectItem value="suprimento"><span className="inline-flex items-center gap-2"><ArrowUpCircle className="size-4 text-primary" />Suprimento (adiciona dinheiro)</span></SelectItem>
                <SelectItem value="reforco"><span className="inline-flex items-center gap-2"><ArrowUpCircle className="size-4 text-primary" />Reforço de troco</span></SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>Valor (R$)</Label><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" autoFocus /></div>
          <div><Label>Motivo</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex: pagamento fornecedor, troco, etc." /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !amount}>Registrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
