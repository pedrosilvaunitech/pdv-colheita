import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentStore } from "@/lib/current-store";
import { PageHeader, StoreRequired } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/usuarios")({
  component: UsuariosPage,
});

function UsuariosPage() {
  const { store, storeId } = useCurrentStore();

  const { data: roles } = useQuery({
    queryKey: ["roles", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const { data, error } = await supabase.from("user_roles").select("id,user_id,role,created_at").eq("store_id", storeId!);
      if (error) throw error;
      return data ?? [];
    },
  });

  if (!store) return <StoreRequired />;

  return (
    <div>
      <PageHeader
        title="Usuários & papéis"
        description="Papéis por loja: admin (tudo), gerente (opera + gerencia), caixa (PDV), estoquista (estoque)."
      />
      <div className="p-6 space-y-4">
        <div className="border border-border rounded-md bg-card p-4 text-xs text-muted-foreground">
          Para adicionar um novo usuário: peça para ele criar conta em <b>Entrar → Criar conta</b>, depois um admin desta loja concede o papel.
          A gestão avançada de convites está prevista para a próxima versão.
        </div>

        <div className="border border-border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Usuário (ID)</TableHead>
              <TableHead className="w-32">Papel</TableHead>
              <TableHead className="w-40">Desde</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {roles?.length === 0 && <TableRow><TableCell colSpan={3} className="text-center py-10 text-sm text-muted-foreground">Sem papéis registrados.</TableCell></TableRow>}
              {roles?.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.user_id}</TableCell>
                  <TableCell><RoleBadge role={r.role} /></TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{new Date(r.created_at).toLocaleString("pt-BR")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, string> = {
    admin: "border-primary/40 text-primary",
    gerente: "border-info/40 text-info",
    caixa: "border-warning/40 text-warning",
    estoquista: "border-muted-foreground/40 text-muted-foreground",
  };
  return <Badge variant="outline" className={map[role] || ""}>{role}</Badge>;
}
