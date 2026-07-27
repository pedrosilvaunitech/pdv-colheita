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

  const rows = useMemo(() => {
    const all = query.data ?? [];
    if (mode === "denied") return all.filter((r) => !r.allowed);
    if (mode === "allowed") return all.filter((r) => r.allowed);
    return all;
  }, [query.data, mode]);

  const deniedCount = (query.data ?? []).filter((r) => !r.allowed).length;

  if (!storeId) {
    return <p className={cn("text-sm text-muted-foreground", className)}>Selecione uma loja para ver a auditoria.</p>;
  }

  return (
    <div className={className}>
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
