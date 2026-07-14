import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Trash2, Ruler, TestTube2 } from "lucide-react";
import { clearPrintHistory, getPrintHistory, type PrintHistoryEntry } from "@/lib/print-history";
import { buildCalibrationPayload, getPrinterPaperWidth, setPrinterPaperWidth } from "@/lib/printer-config";
import { sendRawEscPos } from "@/lib/escpos";

/**
 * Dialog de diagnóstico: mostra últimas 50 tentativas + wizard de calibração
 * automática da largura do papel.
 */
export function PrintDiagnosticsDialog({
  open, onOpenChange, printerName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  printerName: string | null;
}) {
  const [entries, setEntries] = useState<PrintHistoryEntry[]>([]);
  const [calibrating, setCalibrating] = useState(false);
  const [currentPaper, setCurrentPaper] = useState<58 | 80 | null>(null);

  useEffect(() => {
    if (open) {
      setEntries(getPrintHistory());
      setCurrentPaper(getPrinterPaperWidth(printerName ?? "__usb__"));
    }
  }, [open, printerName]);

  const refresh = () => setEntries(getPrintHistory());
  const clear = () => { clearPrintHistory(); refresh(); toast.info("Histórico limpo"); };

  const runCalibration = async () => {
    setCalibrating(true);
    try {
      const d = await sendRawEscPos(buildCalibrationPayload());
      if (d.ok) toast.success("Régua impressa. Escolha a largura que se encaixa.");
      else toast.error(`Falhou (${d.channel}): ${d.error ?? "erro desconhecido"}`);
    } finally { setCalibrating(false); }
  };

  const saveWidth = (w: 58 | 80) => {
    const key = printerName ?? "__usb__";
    setPrinterPaperWidth(key, w);
    setCurrentPaper(w);
    toast.success(`Largura ${w}mm salva para ${printerName ?? "USB direta"}`);
  };

  const okCount = entries.filter((e) => e.ok).length;
  const failCount = entries.length - okCount;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Diagnóstico de impressão</DialogTitle>
          <DialogDescription>
            Histórico das últimas tentativas e calibração da largura do papel.
          </DialogDescription>
        </DialogHeader>

        {/* Calibração */}
        <div className="border border-border rounded-md p-3 bg-card space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Ruler className="size-4" /> Calibração automática de largura
          </div>
          <p className="text-xs text-muted-foreground">
            Imprime duas réguas (48 e 32 colunas). Escolha qual delas se encaixa exatamente
            na largura do papel sem cortar caracteres.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={runCalibration} disabled={calibrating} className="gap-2">
              <TestTube2 className="size-3" /> {calibrating ? "Imprimindo…" : "Imprimir régua"}
            </Button>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">A régua que encaixou é:</span>
              <Button size="sm" variant={currentPaper === 58 ? "default" : "outline"} onClick={() => saveWidth(58)}>58mm</Button>
              <Button size="sm" variant={currentPaper === 80 ? "default" : "outline"} onClick={() => saveWidth(80)}>80mm</Button>
            </div>
            {currentPaper && (
              <Badge variant="secondary" className="text-[10px]">
                Salvo: {currentPaper}mm · {printerName ?? "USB direta"}
              </Badge>
            )}
          </div>
        </div>

        {/* Histórico */}
        <div className="border border-border rounded-md">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <div className="flex items-center gap-2 text-sm font-semibold">
              Histórico
              <Badge variant="outline" className="text-[10px]">{entries.length}</Badge>
              <span className="text-[10px] text-primary">{okCount} OK</span>
              <span className="text-[10px] text-destructive">{failCount} erro</span>
            </div>
            <Button size="sm" variant="ghost" onClick={clear} className="h-7 gap-1 text-[11px]">
              <Trash2 className="size-3" /> Limpar
            </Button>
          </div>
          <ScrollArea className="h-64">
            {entries.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">Nenhuma impressão registrada ainda.</div>
            ) : (
              <ul className="divide-y divide-border">
                {entries.map((e, i) => (
                  <li key={i} className="px-3 py-2 text-xs flex items-start gap-2">
                    {e.ok
                      ? <CheckCircle2 className="size-4 text-primary shrink-0 mt-0.5" />
                      : <XCircle className="size-4 text-destructive shrink-0 mt-0.5" />}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium uppercase text-[10px]">{e.channel}</span>
                        {e.printer && <span className="text-muted-foreground truncate">{e.printer}</span>}
                        {e.paperWidth && <Badge variant="outline" className="text-[9px] h-4">{e.paperWidth}mm</Badge>}
                        {e.saleId && <span className="text-[10px] text-muted-foreground">#{e.saleId.slice(0, 8)}</span>}
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {new Date(e.ts).toLocaleString("pt-BR")}
                        </span>
                      </div>
                      {e.error && <div className="mt-1 text-[10px] text-destructive break-words">{e.error}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={refresh}>Recarregar</Button>
          <Button onClick={() => onOpenChange(false)}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
