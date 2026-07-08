import { createFileRoute, useNavigate, redirect } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { resetCurrentStoreSelection } from "@/lib/current-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { ScanBarcode, Loader2 } from "lucide-react";
import { z } from "zod";

const schema = z.object({
  email: z.string().trim().email("Email inválido").max(255),
  password: z.string().min(8, "Mínimo 8 caracteres").max(128),
});

export const Route = createFileRoute("/auth")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) throw redirect({ to: "/dashboard" });
  },
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  useEffect(() => { document.title = "Entrar — Bastion POS"; }, []);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setLoading(true);
    try {
      if (tab === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await ensureCurrentUserProfile();
        toast.success("Autenticado");
        qc.clear();
        resetCurrentStoreSelection();
        await qc.invalidateQueries({ queryKey: ["stores"] });
        await qc.invalidateQueries({ queryKey: ["my-profile"] });
        navigate({ to: "/dashboard", replace: true });
      } else {
        const { error } = await supabase.auth.signUp({
          email, password,
          options: {
            emailRedirectTo: window.location.origin,
            data: { full_name: name || email.split("@")[0] },
          },
        });
        if (error) throw error;
        toast.success("Conta criada. Faça login.");
        setTab("login");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha na autenticação";
      toast.error(msg.includes("Invalid login") ? "Email ou senha incorretos" : msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-8">
          <div className="size-10 rounded-md bg-primary flex items-center justify-center">
            <ScanBarcode className="size-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">BASTION POS</h1>
            <p className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
              Gestão · Estoque · Nota fiscal
            </p>
          </div>
        </div>

        <div className="border border-border rounded-md bg-card p-6">
          <Tabs value={tab} onValueChange={(v) => setTab(v as "login" | "signup")}>
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="login">Entrar</TabsTrigger>
              <TabsTrigger value="signup">Criar conta</TabsTrigger>
            </TabsList>

            <form onSubmit={handle} className="space-y-4 mt-6">
              {tab === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="name">Nome completo</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Como você quer ser chamado" />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Senha</Label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={tab === "login" ? "current-password" : "new-password"} />
                {tab === "signup" && <p className="text-[11px] text-muted-foreground">Mínimo 8 caracteres.</p>}
              </div>
              <TabsContent value="login" className="p-0 m-0" />
              <TabsContent value="signup" className="p-0 m-0" />
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
                {tab === "login" ? "Entrar" : "Criar conta"}
              </Button>
            </form>
          </Tabs>
        </div>

        <p className="text-center text-[11px] font-mono uppercase tracking-wider text-muted-foreground mt-6">
          Ambiente seguro · dados protegidos por loja
        </p>
      </div>
    </div>
  );
}

async function ensureCurrentUserProfile() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  const user = data.user;
  if (!user) throw new Error("Sessão inválida após login");

  const fullName =
    typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim().length > 0
      ? user.user_metadata.full_name.trim()
      : user.email?.split("@")[0] ?? "Usuário";

  const { error: profileError } = await supabase
    .from("profiles")
    .upsert(
      {
        id: user.id,
        email: user.email ?? null,
        full_name: fullName,
        avatar_url: typeof user.user_metadata?.avatar_url === "string" ? user.user_metadata.avatar_url : null,
      },
      { onConflict: "id" },
    );

  if (profileError) throw new Error(`Falha ao preparar usuário: ${profileError.message}`);
}
