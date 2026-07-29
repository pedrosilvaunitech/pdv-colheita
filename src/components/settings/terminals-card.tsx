/**
 * Card: Caixas (terminais) da loja.
 *
 * Lista todos os PDVs registrados na loja, identifica qual é ESTE PC,
 * permite renomear e vincular o Agente Local ao caixa correto para que
 * impressora, gaveta, balança e pinpad não sejam compartilhados por engano.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  type AgentIdentity,
  type TerminalRow,
  bindAgentToTerminal,
  getAgentIdentity,
  getTerminalId,
  getTerminalName,
  isTerminalOnline,
  isThisTerminal,
  listTerminals,
  registerTerminal,
  removeTerminal,
  renameTerminal,
  setTerminalName,
  unbindAgent,
} from "@/lib/terminal";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Monitor, Link2, Link2Off, RefreshCw, Trash2, Printer } from "lucide-react";

interface Props {
  storeId: string | null;
}

export function TerminalsCard({ storeId }: Props) {
  const [rows, setRows] = useState<TerminalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(getTerminalName());
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    try {
      await registerTerminal({ storeId, agentId: identity?.agent_id ?? null, agentVersion: identity?.version ?? null });
      setRows(await listTerminals(storeId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao listar caixas.");
    } finally {
      setLoading(false);
    }
    // identity é lida separadamente para não reexecutar em loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    void getAgentIdentity().then(setIdentity);
    void refresh();
  }, [refresh]);

  const myKey = getTerminalId();
  const bound = identity?.terminal_key ?? null;
  const boundHere = bound === myKey;

  async function saveName() {
    if (!storeId) return;
    setBusy(true);
    try {
      setTerminalName(name);
      await registerTerminal({ storeId, agentId: identity?.agent_id ?? null, agentVersion: identity?.version ?? null });
      if (boundHere) await bindAgentToTerminal(storeId);
      toast.success("Nome do caixa atualizado.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleBind() {
    if (!storeId) return;
    setBusy(true);
    const r = await bindAgentToTerminal(storeId);
    setBusy(false);
    if (!r.ok) return toast.error(r.error ?? "Falha ao vincular agente.");
    toast.success("Agente local vinculado a este caixa.");
    setIdentity(await getAgentIdentity());
    await refresh();
  }

  async function handleUnbind() {
    setBusy(true);
    const r = await unbindAgent();
    setBusy(false);
    if (!r.ok) return toast.error(r.error ?? "Falha ao desvincular.");
    toast.success("Agente liberado. Vincule ao caixa desejado.");
    setIdentity(await getAgentIdentity());
  }

  async function handleRemove(row: TerminalRow) {
    try {
      await removeTerminal(row.id);
      toast.success(`Caixa "${row.name}" removido.`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao remover caixa.");
    }
  }

  async function handleRename(row: TerminalRow, value: string) {
    try {
      await renameTerminal(row.id, value);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao renomear.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Monitor className="size-4" /> Caixas desta loja
            </CardTitle>
            <CardDescription>
              Cada PC recebe um identificador próprio. O Agente Local vinculado a um caixa recusa comandos de
              outro terminal — impressora, gaveta, balança e pinpad ficam isolados por caixa.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Este PC</Badge>
            <code className="text-xs text-muted-foreground">{myKey.slice(-8).toUpperCase()}</code>
            {identity ? (
              <Badge variant="outline" className="gap-1">
                Agente {identity.version ?? ""} · {identity.agent_id.slice(-6)}
              </Badge>
            ) : (
              <Badge variant="outline">Agente local offline</Badge>
            )}
            {identity && (boundHere
              ? <Badge className="gap-1"><Link2 className="size-3" /> Vinculado a este caixa</Badge>
              : bound
                ? <Badge variant="destructive" className="gap-1"><Link2Off className="size-3" /> Vinculado a {identity.terminal_name ?? "outro caixa"}</Badge>
                : <Badge variant="outline">Agente livre</Badge>)}
          </div>

          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-1">
              <Label htmlFor="terminal-name">Nome deste caixa</Label>
              <Input
                id="terminal-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Caixa 01"
                maxLength={40}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void saveName()} disabled={busy || !storeId}>Salvar</Button>
              {identity && (boundHere ? (
                <Button variant="outline" onClick={() => void handleUnbind()} disabled={busy}>
                  <Link2Off className="size-3" /> Desvincular
                </Button>
              ) : (
                <Button variant="outline" onClick={() => void handleBind()} disabled={busy || !storeId}>
                  <Link2 className="size-3" /> Vincular agente
                </Button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          {rows.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">Nenhum caixa registrado ainda.</p>
          )}
          {rows.map((row) => {
            const mine = isThisTerminal(row);
            const online = isTerminalOnline(row);
            return (
              <div
                key={row.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3 text-sm"
              >
                <span className={online ? "size-2 rounded-full bg-primary" : "size-2 rounded-full bg-muted-foreground/40"} />
                <Input
                  defaultValue={row.name}
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value !== row.name) void handleRename(row, e.target.value);
                  }}
                  className="h-8 w-40"
                />
                {mine && <Badge variant="secondary">este PC</Badge>}
                <Badge variant="outline">{online ? "ativo" : "inativo"}</Badge>
                {row.printer_name && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Printer className="size-3" /> {row.printer_name}
                    {row.printer_source ? ` (${row.printer_source})` : ""}
                  </span>
                )}
                {row.agent_version && (
                  <span className="text-xs text-muted-foreground">agente v{row.agent_version}</span>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {new Date(row.last_seen_at).toLocaleString("pt-BR")}
                </span>
                {!mine && (
                  <Button variant="ghost" size="icon" onClick={() => void handleRemove(row)} aria-label={`Remover ${row.name}`}>
                    <Trash2 className="size-3" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
