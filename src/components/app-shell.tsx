import { ReactNode, useEffect, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  ScanBarcode,
  Package,
  Boxes,
  FileText,
  Store,
  Users,
  LogOut,
  ChevronDown,
  Circle,
  AlertTriangle,
  Truck,
  UserSquare2,
  ShoppingBag,
  Wallet,
  Settings,
  RefreshCw,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentStore } from "@/lib/current-store";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/pdv", label: "PDV / Frente", icon: ScanBarcode },
  { to: "/caixa", label: "Caixa", icon: Wallet },
  { to: "/produtos", label: "Produtos", icon: Package },
  { to: "/estoque", label: "Estoque", icon: Boxes },
  { to: "/reposicao", label: "Reposição", icon: AlertTriangle },
  { to: "/compras", label: "Compras / NF entrada", icon: ShoppingBag },
  { to: "/fornecedores", label: "Fornecedores", icon: Truck },
  { to: "/clientes", label: "Clientes", icon: UserSquare2 },
  { to: "/fiscal", label: "Nota Fiscal", icon: FileText },
  { to: "/lojas", label: "Lojas", icon: Store },
  { to: "/usuarios", label: "Usuários", icon: Users },
  { to: "/configuracoes", label: "Configurações", icon: Settings },
] as const;


export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { store, stores, setStoreId, isLoading, isError } = useCurrentStore();
  const [email, setEmail] = useState<string>("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  const signOut = async () => {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    toast.success("Sessão encerrada");
    navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="dark min-h-screen flex bg-background text-foreground">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col">
        <div className="h-14 flex items-center gap-2 px-4 border-b border-sidebar-border">
          <div className="size-7 rounded-sm bg-primary flex items-center justify-center">
            <ScanBarcode className="size-4 text-primary-foreground" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">BASTION POS</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-mono">Operações fiscais</div>
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {NAV.map((item) => {
            const active = pathname === item.to || pathname.startsWith(item.to + "/");
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-sm text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground border-l-2 border-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60"
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-sidebar-border text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
          v0.1 · produção
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border bg-card flex items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <Store className="size-4" />
                  {isLoading ? "Carregando lojas" : store ? (store.fantasy_name || store.name) : "Selecionar loja"}
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel className="flex items-center justify-between">
                  <span>Lojas disponíveis</span>
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); qc.invalidateQueries({ queryKey: ["stores"] }); qc.invalidateQueries({ queryKey: ["my-profile"] }); toast.success("Lojas recarregadas"); }}
                    className="text-muted-foreground hover:text-foreground p-1 rounded"
                    title="Recarregar lojas"
                  >
                    <RefreshCw className="size-3" />
                  </button>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {isLoading && (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                    Carregando lojas disponíveis...
                  </div>
                )}
                {isError && (
                  <div className="px-2 py-6 text-center text-xs text-destructive">
                    Não foi possível carregar as lojas.
                  </div>
                )}
                {!isLoading && !isError && stores.length === 0 && (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                    Nenhuma loja. Cadastre a primeira em <b>Lojas</b>.
                  </div>
                )}
                {stores.map((s) => (
                  <DropdownMenuItem key={s.id} onClick={() => setStoreId(s.id)}>
                    <Circle className={cn("size-2 mr-2", s.id === store?.id ? "fill-primary text-primary" : "text-muted-foreground")} />
                    <div className="flex-1">
                      <div className="text-sm">{s.fantasy_name || s.name}</div>
                      <div className="text-[10px] font-mono text-muted-foreground">{s.cnpj || "sem CNPJ"}</div>
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <StoreStatusBadge />
          </div>

          <div className="flex items-center gap-3">
            <div className="text-xs text-muted-foreground font-mono hidden md:block">{email}</div>
            <Button variant="ghost" size="sm" onClick={signOut} className="gap-2">
              <LogOut className="size-4" /> Sair
            </Button>
          </div>
        </header>

        
        <main className="flex-1 overflow-auto">
          {!store && stores.length > 0 && (
            <div className="bg-warning/10 border-b border-warning/20 px-4 py-2 text-[11px] font-medium text-warning flex items-center gap-2 uppercase tracking-wider">
              <AlertTriangle className="size-3" />
              Nenhuma loja ativa. Selecione uma no menu acima para ver os dados.
            </div>
          )}
          {stores.length === 0 && pathname !== "/lojas" && (
            <div className="bg-primary/10 border-b border-primary/20 px-4 py-3 text-sm text-primary flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Store className="size-4" />
                <span>Você ainda não possui lojas cadastradas.</span>
              </div>
              <Button asChild size="sm" variant="outline" className="h-7 text-[10px] border-primary/40 hover:bg-primary/20 text-primary">
                <Link to="/lojas">CADASTRAR PRIMEIRA LOJA</Link>
              </Button>
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}

function StoreStatusBadge() {
  const { store } = useCurrentStore();
  if (!store) return null;
  const ok = Boolean(store.cnpj);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded-sm border",
        ok ? "border-primary/30 text-primary bg-primary/10" : "border-warning/30 text-warning bg-warning/10"
      )}
    >
      <Circle className={cn("size-2", ok ? "fill-primary" : "fill-warning")} />
      {ok ? "CNPJ configurado" : "Configuração pendente"}
    </span>
  );
}
