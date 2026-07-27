import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck, RefreshCw, Loader2, Download } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";


export interface RpcAuditLogProps {
  storeId: string | null | undefined;
  className?: string;
  /** Quantidade máxima de registros carregados. */
  limit?: number;
}

interface AuditRow {
  id: string;
  user_id: string | null;
  function_name: string;
  store_id: string | null;
  allowed: boolean;
  detail: string | null;
  created_at: string;
}

interface RateLimitRow {
  id: string;
  user_id: string;
  function_name: string;
  attempts: number;
  blocked_until: string | null;
}


type FilterMode = "all" | "denied" | "allowed";

const FUNCTION_LABEL: Record<string, string> = {
  verify_admin_code: "Validação de código admin",
  lookup_admin_code: "Busca de código admin",
  set_store_master_password: "Senha mestra da loja",
  regenerate_admin_code: "Regeneração de código",
  set_user_store_permissions: "Alteração de permissões",
  reserve_nfce_number: "Reserva de numeração NFC-e",
};

/**
 * Trilha de auditoria das chamadas sensíveis (RPC) da loja.
 * Somente admin/gerente enxerga os registros da loja — a RLS de
 * `rpc_audit_log` restringe o restante ao próprio usuário.
 */
export function RpcAuditLog({ storeId, className, limit = 200 }: RpcAuditLogProps) {
  const [mode, setMode] = useState<FilterMode>("all");

  const query = useQuery({
    queryKey: ["rpc-audit-log", storeId, limit],
    enabled: Boolean(storeId),
    staleTime: 30_000,
    queryFn: async (): Promise<AuditRow[]> => {
      const { data, error } = await supabase
        .from("rpc_audit_log")
        .select("id, user_id, function_name, store_id, allowed, detail, created_at")
        .eq("store_id", storeId!)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []) as AuditRow[];
    },
  });

  /** Bloqueios de rate limit ativos nesta loja (visível a gestores pela RLS). */
  const blocks = useQuery({
    queryKey: ["rpc-rate-limits", storeId],
    enabled: Boolean(storeId),
    refetchInterval: 30_000,
    queryFn: async (): Promise<RateLimitRow[]> => {
      const { data, error } = await supabase
        .from("rpc_rate_limits")
        .select("id, user_id, function_name, attempts, blocked_until")
        .eq("store_id", storeId!)
        .gt("blocked_until", new Date().toISOString())
        .order("blocked_until", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as RateLimitRow[];
    },
  });


  const rows = useMemo(() => {
    const all = query.data ?? [];
    if (mode === "denied") return all.filter((r) => !r.allowed);
    if (mode === "allowed") return all.filter((r) => r.allowed);
    return all;
  }, [query.data, mode]);

  const deniedCount = (query.data ?? []).filter((r) => !r.allowed).length;

  /**
   * Exporta exatamente o que está em tela (respeitando o filtro ativo).
   * Campos são escapados no padrão RFC 4180 e o arquivo leva BOM UTF-8
   * para o Excel pt-BR abrir acentuação corretamente.
   */
  const exportCsv = () => {
    if (rows.length === 0) {
      toast.error("Nada para exportar com este filtro.");
      return;
    }
    const esc = (value: unknown): string => {
      const s = value === null || value === undefined ? "" : String(value);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = ["data_hora", "funcao", "resultado", "usuario", "loja", "detalhe"];
    const lines = rows.map((r) =>
      [
        new Date(r.created_at).toLocaleString("pt-BR"),
        FUNCTION_LABEL[r.function_name] ?? r.function_name,
        r.allowed ? "permitida" : "negada",
        r.user_id ?? "",
        r.store_id ?? "",
        r.detail ?? "",
      ]
        .map(esc)
        .join(";"),
    );
    const csv = "\uFEFF" + [header.map(esc).join(";"), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `auditoria-rpc-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success(`${rows.length} registro(s) exportado(s).`);
  };


  if (!storeId) {
    return <p className={cn("text-sm text-muted-foreground", className)}>Selecione uma loja para ver a auditoria.</p>;
  }

  const activeBlocks = blocks.data ?? [];

  return (
    <div className={className}>
      {activeBlocks.length > 0 && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-medium text-destructive flex items-center gap-2">
            <ShieldAlert className="size-4" />
            {activeBlocks.length} bloqueio(s) por excesso de tentativas
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {activeBlocks.map((b) => (
              <li key={b.id} className="font-mono">
                {(FUNCTION_LABEL[b.function_name] ?? b.function_name)} · {b.attempts} tentativas ·
                usuário {b.user_id.slice(0, 8)}… · liberado às{" "}
                {b.blocked_until ? new Date(b.blocked_until).toLocaleTimeString("pt-BR") : "—"}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Tentativas registradas</span>
          {deniedCount > 0 && (
            <Badge variant="destructive" className="font-mono">{deniedCount} negadas</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select value={mode} onValueChange={(v) => setMode(v as FilterMode)}>
            <SelectTrigger className="w-40 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              <SelectItem value="denied">Somente negadas</SelectItem>
              <SelectItem value="allowed">Somente permitidas</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={exportCsv}
            disabled={query.isLoading || rows.length === 0}
          >
            <Download className="size-3.5" />
            Exportar CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Atualizar
          </Button>

        </div>
      </div>

      {query.isLoading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />
          ))}
        </div>
      ) : query.isError ? (
        <p className="text-sm text-destructive">
          Não foi possível carregar a auditoria: {(query.error as Error).message}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma tentativa registrada com este filtro.</p>
      ) : (
        <div className="rounded-md border divide-y">
          {rows.map((row) => (
            <div key={row.id} className="flex items-start gap-3 p-2.5 text-xs">
              {row.allowed ? (
                <ShieldCheck className="size-4 shrink-0 text-primary mt-0.5" />
              ) : (
                <ShieldAlert className="size-4 shrink-0 text-destructive mt-0.5" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {FUNCTION_LABEL[row.function_name] ?? row.function_name}
                </p>
                {row.detail && <p className="text-muted-foreground truncate">{row.detail}</p>}
              </div>
              <div className="text-right shrink-0 font-mono text-[11px] text-muted-foreground">
                <p>{new Date(row.created_at).toLocaleString("pt-BR")}</p>
                <p className="truncate max-w-[9rem]">{row.user_id ?? "—"}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
