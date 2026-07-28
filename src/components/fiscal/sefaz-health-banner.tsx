/**
 * Banner de saúde da emissão fiscal (Direto SEFAZ).
 *
 * Fica visível no PDV e na tela Fiscal. Mostra o estado do motor, a última
 * verificação e — quando algo falha — o diagnóstico com passos acionáveis.
 * Em estado saudável, encolhe para uma linha discreta.
 */

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSefazHealth, type SefazHealthState } from "@/hooks/use-sefaz-health";
import { Loader2, ShieldCheck, ShieldAlert, TriangleAlert, RefreshCw, ChevronDown, ChevronUp, Activity } from "lucide-react";

export interface SefazHealthBannerProps {
  /** Só monitora quando o provedor da loja é "direto_sefaz". */
  enabled: boolean;
  className?: string;
}

const STATE_STYLES: Record<SefazHealthState, string> = {
  checking: "border-border bg-muted/30",
  ok: "border-success/40 bg-success/5",
  degraded: "border-warning/40 bg-warning/5",
  down: "border-destructive/40 bg-destructive/5",
};

export function SefazHealthBanner({ enabled, className }: SefazHealthBannerProps) {
  const health = useSefazHealth(enabled);
  const [open, setOpen] = useState(false);

  if (!enabled) return null;

  const { state, diagnosis, sefazMessage, lastCheckedAt, checking, refresh } = health;
  const healthy = state === "ok";

  return (
    <div className={cn("rounded-md border p-3 text-sm", STATE_STYLES[state], className)}>
      <div className="flex flex-wrap items-center gap-2">
        {state === "checking" ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : healthy ? (
          <ShieldCheck className="size-4 text-success" />
        ) : state === "degraded" ? (
          <TriangleAlert className="size-4 text-warning" />
        ) : (
          <ShieldAlert className="size-4 text-destructive" />
        )}

        <span className="font-medium">
          {state === "checking" && "Verificando motor fiscal…"}
          {state === "ok" && "Emissão fiscal operante"}
          {state === "degraded" && (diagnosis?.title ?? "Emissão fiscal instável")}
          {state === "down" && (diagnosis?.title ?? "Emissão fiscal indisponível")}
        </span>

        <Badge variant="outline" className="text-[10px]">
          {health.agentOnline ? (health.engineReady ? "Agente + motor OK" : "Motor não carregado") : "Agente offline"}
        </Badge>

        <span className="ml-auto flex items-center gap-1">
          {lastCheckedAt && (
            <span className="text-[10px] text-muted-foreground">
              {lastCheckedAt.toLocaleTimeString("pt-BR")}
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            disabled={checking}
            onClick={() => void refresh()}
          >
            {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            Verificar agora
          </Button>
          {!healthy && diagnosis && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              Como resolver
            </Button>
          )}
        </span>
      </div>

      {healthy && sefazMessage && (
        <p className="mt-1 text-xs text-muted-foreground">{sefazMessage}</p>
      )}

      {!healthy && diagnosis && (
        <p className="mt-1 text-xs text-muted-foreground">{diagnosis.cause}</p>
      )}

      {!healthy && diagnosis && open && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          <ol className="list-decimal space-y-1 pl-5 text-xs">
            {diagnosis.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">Mensagem técnica</summary>
            <code className="mt-1 block break-words font-mono">{diagnosis.raw}</code>
          </details>
          <Link
            to="/agente-diagnostico"
            className="inline-flex items-center gap-1 text-xs text-info hover:underline"
          >
            <Activity className="size-3" /> Abrir diagnóstico do agente
          </Link>
        </div>
      )}
    </div>
  );
}
