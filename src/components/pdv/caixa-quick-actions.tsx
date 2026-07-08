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
type PermCheck = "can_open_close_cash" | "can_sangria" | "can_all";

export class WrongStoreCodeError extends Error {
  targetStoreId: string;
  targetStoreName: string;
  constructor(storeId: string, storeName: string) {
    super(`Este código pertence à loja "${storeName}". Troque para essa loja para usá-lo.`);
    this.targetStoreId = storeId;
    this.targetStoreName = storeName;
  }
}

async function verifyAdmin(storeId: string, code: string, perm: PermCheck): Promise<AdminRow> {
  const clean = code.replace(/\D/g, "");
  if (clean.length !== 5) throw new Error("Digite o código de 5 dígitos");
  const { data, error } = await supabase.rpc("verify_admin_code", { _store_id: storeId, _code: clean });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    // Não achou na loja atual: verifica se pertence a outra loja acessível.
    const { data: other } = await supabase.rpc("lookup_admin_code", { _code: clean });
    const hit = Array.isArray(other) ? other[0] : other;
    if (hit && hit.store_id && hit.store_id !== storeId) {
      throw new WrongStoreCodeError(hit.store_id, hit.store_name || "outra loja");
    }
    throw new Error("Código inválido");
  }
  // Senha mestra (user_id nulo) autoriza qualquer ação.
  if (!row.user_id) return row as AdminRow;
  const { data: permData, error: permErr } = await supabase.rpc("user_store_permissions", {
    _user_id: row.user_id, _store_id: storeId,
  });
  if (permErr) throw permErr;
  const p = Array.isArray(permData) ? permData[0] : permData;
  const allowed = !!p && (p.can_all || p[perm]);
  if (!allowed) throw new Error("Usuário sem permissão para esta ação");
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

function AdminCodeField({ code, setCode, admin, setAdmin, storeId, perm }: {
  code: string; setCode: (v: string) => void;
  admin: AdminRow | null; setAdmin: (a: AdminRow | null) => void;
  storeId: string;
  perm: PermCheck;
}) {
  const [checking, setChecking] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [wrongStore, setWrongStore] = useState<{ id: string; name: string } | null>(null);
  const { setStoreId } = useCurrentStore();
  const check = async (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 5);
    setCode(digits);
    setErrMsg(null);
    setWrongStore(null);
    if (digits.length < 5) { setAdmin(null); return; }
    setChecking(true);
    try {
      const a = await verifyAdmin(storeId, digits, perm);
      setAdmin(a);
    } catch (e) {
      setAdmin(null);
      if (e instanceof WrongStoreCodeError) {
        setWrongStore({ id: e.targetStoreId, name: e.targetStoreName });
        setErrMsg(e.message);
      } else {
        setErrMsg(e instanceof Error ? e.message : "Código inválido");
      }
    } finally {
      setChecking(false);
    }
  };
  return (
    <div>
      <Label className="flex items-center gap-1"><ShieldCheck className="size-3" /> Código de administrador (5 dígitos)</Label>
      <Input
        autoFocus
        value={code}
        onChange={(e) => check(e.target.value)}
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={5}
        placeholder="_ _ _ _ _"
        className="font-mono text-center text-2xl tracking-[0.6em] tabular-nums"
      />
      <div className="text-[11px] mt-1 min-h-4 space-y-1">
        {checking && <span className="text-muted-foreground">Validando…</span>}
        {!checking && admin && (
          <span className="text-primary font-mono uppercase">✓ {admin.full_name || admin.email} · {admin.role}</span>
        )}
        {!checking && !admin && errMsg && code.length === 5 && (
          <div className="text-destructive">{errMsg}</div>
        )}
        {!checking && wrongStore && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-[11px] gap-1 mt-1"
            onClick={() => { setStoreId(wrongStore.id); toast.success(`Loja alterada para ${wrongStore.name}`); setWrongStore(null); setErrMsg(null); setTimeout(() => check(code), 200); }}
          >
            Trocar para {wrongStore.name}
          </Button>
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
          <AdminCodeField code={code} setCode={setCode} admin={admin} setAdmin={setAdmin} storeId={storeId} perm="can_open_close_cash" />
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
          <AdminCodeField code={code} setCode={setCode} admin={admin} setAdmin={setAdmin} storeId={storeId} perm="can_open_close_cash" />
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
          <AdminCodeField code={code} setCode={setCode} admin={admin} setAdmin={setAdmin} storeId={storeId} perm={movType === "sangria" || movType === "retirada" ? "can_sangria" : "can_open_close_cash"} />
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
