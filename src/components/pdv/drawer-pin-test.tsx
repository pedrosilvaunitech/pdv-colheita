import { useState } from "react";
import { PlugZap, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { openCashDrawer } from "@/lib/cash-drawer";

export interface DrawerPinTestProps {
  storeId: string | null | undefined;
  /** Chamado quando um pino funciona, para o formulário já adotar o valor. */
  onWorkingPin?: (pin: 0 | 1) => void;
  className?: string;
}

type TestState = { pin: 0 | 1; ok: boolean; channel: string; error?: string } | null;

/**
 * Testa os dois pinos possíveis do conector RJ11/RJ12 da gaveta.
 * A maioria das gavetas usa o pino 2; algumas (Bematech/Daruma antigas) usam o 5.
 * O teste é auditado com motivo "teste" para não poluir o relatório de turno.
 */
export function DrawerPinTest({ storeId, onWorkingPin, className }: DrawerPinTestProps) {
  const [running, setRunning] = useState<0 | 1 | null>(null);
  const [last, setLast] = useState<TestState>(null);

  const test = async (pin: 0 | 1) => {
    setRunning(pin);
    try {
      const r = await openCashDrawer({ storeId, reason: "teste", automatic: false, pin });
      setLast({ pin, ok: r.ok, channel: r.channel, error: r.error });
      if (r.ok) {
        toast.success(`Pulso enviado no pino ${pin === 0 ? "2" : "5"} via ${r.channel}`, {
          description: "Se a gaveta abriu, use este pino nas configurações.",
          action: onWorkingPin
            ? { label: "Usar este pino", onClick: () => onWorkingPin(pin) }
            : undefined,
        });
      } else {
        toast.error(`Falha no pino ${pin === 0 ? "2" : "5"}: ${r.error ?? "sem canal disponível"}`);
      }
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className={className}>
      <div className="grid grid-cols-2 gap-2">
        {([0, 1] as const).map((pin) => (
          <Button
            key={pin}
            type="button"
            variant="outline"
            size="sm"
            disabled={running !== null}
            onClick={() => test(pin)}
            className="gap-2"
          >
            {running === pin ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            Testar pino {pin === 0 ? "2" : "5"}
          </Button>
        ))}
      </div>
      {last && (
        <p className="mt-2 text-[11px] font-mono flex items-center gap-1.5">
          {last.ok ? (
            <CheckCircle2 className="size-3.5 text-primary" />
          ) : (
            <XCircle className="size-3.5 text-destructive" />
          )}
          <span className={last.ok ? "text-primary" : "text-destructive"}>
            Pino {last.pin === 0 ? "2" : "5"} · {last.ok ? `pulso enviado (${last.channel})` : last.error ?? "falhou"}
          </span>
        </p>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">
        Dispare cada pino e observe qual abre a gaveta. Registros ficam com o motivo “Teste do equipamento”.
      </p>
    </div>
  );
}
