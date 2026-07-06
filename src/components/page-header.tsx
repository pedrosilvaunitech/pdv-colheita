import { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentStore } from "@/lib/current-store";
import { Button } from "@/components/ui/button";
import { RefreshCw, Store as StoreIcon, Plus, AlertTriangle } from "lucide-react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="border-b border-border bg-card">
      <div className="px-6 py-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="border border-dashed border-border rounded-md p-10 text-center bg-card/40">
      <h3 className="text-sm font-medium">{title}</h3>
      {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function StoreRequired() {
  const { stores, isLoading, isError, setStoreId } = useCurrentStore();
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["stores"] });
    qc.invalidateQueries({ queryKey: ["my-profile"] });
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="border border-border rounded-md bg-card/40 p-10 text-center text-sm text-muted-foreground">
          Carregando lojas disponíveis...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6">
        <div className="border border-destructive/40 rounded-md bg-destructive/10 p-6 text-center space-y-3">
          <AlertTriangle className="size-6 mx-auto text-destructive" />
          <div className="text-sm font-medium text-destructive">Erro ao carregar lojas</div>
          <Button size="sm" variant="outline" className="gap-2" onClick={refresh}>
            <RefreshCw className="size-3" /> Tentar novamente
          </Button>
        </div>
      </div>
    );
  }

  // ONBOARDING: zero stores
  if (stores.length === 0) {
    return (
      <div className="p-6">
        <div className="border border-primary/40 rounded-md bg-primary/5 p-8 text-center space-y-4 max-w-xl mx-auto">
          <div className="size-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <StoreIcon className="size-7 text-primary" />
          </div>
          <div>
            <h3 className="text-base font-semibold">Bem-vindo! Cadastre sua primeira loja</h3>
            <p className="text-xs text-muted-foreground mt-2">
              Cada loja tem estoque, usuários, caixa e configuração fiscal próprios.
              Ao criar sua primeira loja, você é definido automaticamente como <b>admin</b>
              e ela vira sua loja padrão.
            </p>
          </div>
          <div className="flex items-center gap-2 justify-center">
            <Button asChild size="sm" className="gap-2">
              <Link to="/lojas"><Plus className="size-4" /> Cadastrar loja</Link>
            </Button>
            <Button size="sm" variant="outline" className="gap-2" onClick={refresh}>
              <RefreshCw className="size-3" /> Recarregar
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Has stores but none selected
  return (
    <div className="p-6">
      <div className="border border-warning/40 rounded-md bg-warning/5 p-6 text-center space-y-4 max-w-xl mx-auto">
        <AlertTriangle className="size-6 mx-auto text-warning" />
        <div>
          <h3 className="text-sm font-medium">Selecione uma loja para continuar</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Você tem {stores.length} loja(s) disponível(is). Escolha abaixo ou use o seletor no topo.
          </p>
        </div>
        <div className="grid gap-2">
          {stores.slice(0, 5).map((s) => (
            <Button key={s.id} variant="outline" size="sm" className="justify-start gap-2" onClick={() => setStoreId(s.id)}>
              <StoreIcon className="size-3" /> {s.fantasy_name || s.name}
            </Button>
          ))}
        </div>
        <Button size="sm" variant="ghost" className="gap-2" onClick={refresh}>
          <RefreshCw className="size-3" /> Recarregar lista
        </Button>
      </div>
    </div>
  );
}
