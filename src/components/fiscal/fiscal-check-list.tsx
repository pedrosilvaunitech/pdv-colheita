/**
 * Lista de checagens fiscais (agente local ou servidor central).
 * Formato compartilhado: { key, label, status, detail, fix }.
 */
import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FiscalCheckItem {
  key: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string | null;
}

interface Props {
  checks: FiscalCheckItem[];
  summary?: string;
  className?: string;
}

const ICONS = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
} as const;

const TONES = {
  ok: "text-emerald-600",
  warn: "text-amber-600",
  fail: "text-destructive",
} as const;

export function FiscalCheckList({ checks, summary, className }: Props) {
  if (!checks.length) return null;
  const failed = checks.filter((c) => c.status === "fail").length;

  return (
    <div
      className={cn(
        "rounded-md border p-3 space-y-2",
        failed ? "border-destructive/40 bg-destructive/5" : "border-emerald-500/40 bg-emerald-500/5",
        className,
      )}
    >
      {summary && <p className="text-sm font-medium">{summary}</p>}
      <ul className="space-y-2">
        {checks.map((c) => {
          const Icon = ICONS[c.status];
          return (
            <li key={c.key} className="flex items-start gap-2 text-sm">
              <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", TONES[c.status])} aria-hidden />
              <div className="min-w-0">
                <span className="font-medium">{c.label}</span>
                <span className="text-muted-foreground"> — {c.detail}</span>
                {c.fix && <p className="text-xs text-muted-foreground mt-0.5">Como resolver: {c.fix}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
