import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LockOpen, Lock, ArrowDownCircle, ArrowUpCircle, ShieldCheck, Maximize2, Minimize2 } from "lucide-react";
import { toast } from "sonner";
import { useNavigate, useRouterState } from "@tanstack/react-router";

interface AdminRow { user_id: string; full_name: string | null; email: string | null; role: string }

async function verifyAdmin(storeId: string, code: string): Promise<AdminRow> {
  const clean = code.trim();
  if (!clean) throw new Error("Digite o código de administrador");
  const { data, error } = await supabase.rpc("verify_admin_code", { _store_id: storeId, _code: clean });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Código de administrador inválido");
  return row as AdminRow;
}

export function CaixaQuickActions({ storeId }: { storeId: string }) {
  const qc = useQueryClient();
  const openReg = useQuery({
    queryKey: ["cash_open", storeId],
    enabled: !!storeId,
    queryFn: async () => {
      const { data, error } = await supabase.from("cash_registers")
        .select("id,terminal,opening_amount,opened_at,store_id")
        .eq("store_id", storeId).eq("status", "aberto")
        .order("opened_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["cash_open"] });
    qc.invalidateQueries({ queryKey: ["cash_mov"] });
    qc.invalidateQueries({ queryKey: ["cash_sales"] });
    qc.invalidateQueries({ queryKey: ["cash_history"] });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <KioskToggle />
      {openReg.data ? (
        <>
          <MovementButton
            storeId={storeId}
            regId={openReg.data.id}
            type="sangria"
            label="Sangria"
            icon={ArrowDownCircle}
            tone="destructive"
            onDone={invalidate}
          />
          <MovementButton
            storeId={storeId}
            regId={openReg.data.id}
            type="reforco"
            label="Reforço"
            icon={ArrowUpCircle}
            tone="primary"
            onDone={invalidate}
          />
          <CloseButton storeId={storeId} regId={openReg.data.id} onDone={invalidate} />
        </>
      ) : (
        <OpenButton storeId={storeId} onDone={invalidate} />
      )}
    </div>
  );
}

function KioskToggle() {
  const navigate = useNavigate();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const kiosk = search?.kiosk === "1" || search?.kiosk === 1 || search?.kiosk === true;

  const enable = async () => {
    try { localStorage.setItem("pdv-kiosk", "1"); } catch { /* ignore */ }
    try { await document.documentElement.requestFullscreen?.(); } catch { /* ignore */ }
    navigate({ to: "/pdv", search: { kiosk: "1" } });
  };
  const disable = async () => {
    try { localStorage.removeItem("pdv-kiosk"); } catch { /* ignore */ }
    try { if (document.fullscreenElement) await document.exitFullscreen?.(); } catch { /* ignore */ }
    navigate({ to: "/pdv", search: {} });
  };

  return kiosk ? (
    <Button size="sm" variant="outline" onClick={disable} className="gap-2 h-9">
      <Minimize2 className="size-4" /> Sair do modo PDV
    </Button>
  ) : (
    <Button size="sm" variant="outline" onClick={enable} className="gap-2 h-9">
      <Maximize2 className="size-4" /> Modo PDV tela cheia
    </Button>
  );
}

function AdminCodeField({ code, setCode, admin, setAdmin, storeId }: {
  code: string; setCode: (v: string) => void;
  admin: AdminRow | null; setAdmin: (a: AdminRow | null) => void;
  storeId: string;
}) {
  const [checking, setChecking] = useState(false);
  const check = async (raw: string) => {
    setCode(raw);
    if (raw.trim().length < 6) { setAdmin(null); return; }
    setChecking(true);
    try {
      const a = await verifyAdmin(storeId, raw);
      setAdmin(a);
    } catch {
      setAdmin(null);
    } finally {
      setChecking(false);
    }
  };
  return (
    <div>
      <Label className="flex items-center gap-1"><ShieldCheck className="size-3" /> Código de administrador</Label>
      <Input
        autoFocus
        value={code}
        onChange={(e) => check(e.target.value)}
        placeholder="Cole o ID do gerente (ou os 8 primeiros caracteres)"
        className="font-mono"
      />
      <div className="text-[11px] mt-1 h-4">
        {checking && <span className="text-muted-foreground">Validando…</span>}
        {!checking && admin && (
          <span className="text-primary font-mono uppercase">✓ {admin.full_name || admin.email} · {admin.role}</span>
        )}
        {!checking && !admin && code.trim().length >= 6 && (
          <span className="text-destructive">Código inválido para esta loja</span>
        )}
      </div>
    </div>
  );
}

function OpenButton({ storeId, onDone }: { storeId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [admin, setAdmin] = useState<AdminRow | null>(null);
  const [amount, setAmount] = useState("0");
  const [terminal, setTerminal] = useState("PDV-01");
  const mut = useMutation({
    mutationFn: async () => {
      if (!admin) throw new Error("Código de administrador inválido");
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Não autenticado");
      const { error } = await supabase.from("cash_registers").insert({
        store_id: storeId, terminal, opened_by: u.user.id,
        opening_amount: Number(amount) || 0,
        notes: `Autorizado por ${admin.full_name || admin.email} (${admin.user_id.slice(0, 8).toUpperCase()})`,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Caixa aberto"); setOpen(false); setCode(""); setAdmin(null); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" className="gap-2 h-9" onClick={() => setOpen(true)}>
        <LockOpen className="size-4" /> Abrir caixa
      </Button>
      <DialogContent>
        <DialogHeader><DialogTitle>Abrir caixa</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <AdminCodeField code={code} setCode={setCode} admin={admin} setAdmin={setAdmin} storeId={storeId} />
          <div><Label>Terminal</Label><Input value={terminal} onChange={(e) => setTerminal(e.target.value)} /></div>
          <div><Label>Fundo de troco (R$)</Label><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !admin}>Abrir</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseButton({ storeId, regId, onDone }: { storeId: string; regId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [admin, setAdmin] = useState<AdminRow | null>(null);
  const [counted, setCounted] = useState("");
  const mut = useMutation({
    mutationFn: async () => {
      if (!admin) throw new Error("Código de administrador inválido");
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Não autenticado");
      const c = Number(counted) || 0;
      const { error } = await supabase.from("cash_registers").update({
        status: "fechado", closed_by: u.user.id, closed_at: new Date().toISOString(),
        closing_amount: c,
        notes: `Fechado no PDV · autorizado por ${admin.full_name || admin.email} (${admin.user_id.slice(0, 8).toUpperCase()})`,
      }).eq("id", regId).eq("store_id", storeId);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Caixa fechado"); setOpen(false); setCode(""); setAdmin(null); setCounted(""); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="destructive" className="gap-2 h-9" onClick={() => setOpen(true)}>
        <Lock className="size-4" /> Fechar caixa
      </Button>
      <DialogContent>
        <DialogHeader><DialogTitle>Fechar caixa</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <AdminCodeField code={code} setCode={setCode} admin={admin} setAdmin={setAdmin} storeId={storeId} />
          <div><Label>Valor contado em dinheiro (R$)</Label><Input type="number" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} className="font-mono text-lg" /></div>
          <div className="text-xs text-muted-foreground">Confira o valor contado antes de confirmar. O relatório completo com diferença fica em <b>Caixa</b>.</div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button variant="destructive" onClick={() => mut.mutate()} disabled={mut.isPending || !admin || !counted}>Fechar caixa</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MovementButton({ storeId, regId, type, label, icon: Icon, tone, onDone }: {
  storeId: string; regId: string;
  type: "sangria" | "reforco" | "suprimento" | "retirada";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "primary" | "destructive";
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [admin, setAdmin] = useState<AdminRow | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [movType, setMovType] = useState(type);

  const mut = useMutation({
    mutationFn: async () => {
      if (!admin) throw new Error("Código de administrador inválido");
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Não autenticado");
      const { error } = await supabase.from("cash_movements").insert({
        cash_register_id: regId, store_id: storeId,
        type: movType, amount: Number(amount),
        reason: `${reason || label} · autorizado por ${admin.full_name || admin.email} (${admin.user_id.slice(0, 8).toUpperCase()})`,
        created_by: u.user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success(`${label} registrada`); setOpen(false); setCode(""); setAdmin(null); setAmount(""); setReason(""); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={tone === "destructive" ? "destructive" : "outline"} className="gap-2 h-9" onClick={() => setOpen(true)}>
        <Icon className="size-4" /> {label}
      </Button>
      <DialogContent>
        <DialogHeader><DialogTitle>{label}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <AdminCodeField code={code} setCode={setCode} admin={admin} setAdmin={setAdmin} storeId={storeId} />
          <div>
            <Label>Tipo</Label>
            <Select value={movType} onValueChange={(v) => setMovType(v as typeof movType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {type === "sangria" && (
                  <>
                    <SelectItem value="sangria">Sangria (retira dinheiro)</SelectItem>
                    <SelectItem value="retirada">Retirada (despesa)</SelectItem>
                  </>
                )}
                {type === "reforco" && (
                  <>
                    <SelectItem value="reforco">Reforço de troco</SelectItem>
                    <SelectItem value="suprimento">Suprimento (adiciona dinheiro)</SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Valor (R$)</Label><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="font-mono" /></div>
          <div><Label>Motivo (opcional)</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex: pagamento fornecedor, troco" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !admin || !amount}>Registrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
