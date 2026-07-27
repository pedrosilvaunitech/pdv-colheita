import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, AlertTriangle, MinusCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type DiagStatus = "ok" | "fail" | "warn" | "unknown";

export interface DiagnosticRowProps {
  label: string;
  status: DiagStatus;
  /** Valor curto exibido à direita (versão, porta, contagem…). */
  value?: string;
  /** Explicação e, quando aplicável, a ação corretiva. */
  hint?: string;
  className?: string;
}

const CONFIG: Record<DiagStatus, { icon: typeof CheckCircle2; label: string; tone: string }> = {
  ok: { icon: CheckCircle2, label: "OK", tone: "text-primary" },
  fail: { icon: XCircle, label: "Falha", tone: "text-destructive" },
  warn: { icon: AlertTriangle, label: "Atenção", tone: "text-muted-foreground" },
  unknown: { icon: MinusCircle, label: "N/D", tone: "text-muted-foreground" },
};

/** Linha padronizada de diagnóstico: status + rótulo + valor + dica. */
export function DiagnosticRow({ label, status, value, hint, className }: DiagnosticRowProps) {
  const { icon: Icon, label: statusLabel, tone } = CONFIG[status];
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-b border-border py-2 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-6 sm:pl-0">
        {value && (
          <span className="font-mono text-xs text-muted-foreground break-all">{value}</span>
        )}
        <Badge variant={status === "ok" ? "default" : status === "fail" ? "destructive" : "secondary"}>
          {statusLabel}
        </Badge>
      </div>
    </div>
  );
}
