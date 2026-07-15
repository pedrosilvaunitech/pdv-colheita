import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Trash2, Ruler, TestTube2, FileDown, Cloud, Mail, RotateCcw } from "lucide-react";
import {
  clearPrintHistory,
  getPrintHistory,
  getLastReceipt,
  PRINT_HISTORY_EVENT,
  type PrintHistoryEntry,
} from "@/lib/print-history";
import { buildCalibrationPayload, getPrinterPaperWidth, setPrinterPaperWidth } from "@/lib/printer-config";
import { sendRawEscPos, tryPrintEscPosDetailed } from "@/lib/escpos";
import { syncPrintHistoryToCloud } from "@/lib/print-cloud-sync";
import { jsPDF } from "jspdf";

/**
 * Dialog de diagnóstico: mostra últimas 50 tentativas + wizard de calibração
 * automática da largura do papel + sincronização com o Cloud + exportação PDF
 * + envio ao suporte + reimpressão do último recibo.
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
  const [syncing, setSyncing] = useState(false);
  const [currentPaper, setCurrentPaper] = useState<58 | 80 | null>(null);

  useEffect(() => {
    if (!open) return;
    const refresh = () => setEntries(getPrintHistory());
    refresh();
    setCurrentPaper(getPrinterPaperWidth(printerName ?? "__usb__"));
    // Atualização em tempo real via evento global
    const h = () => refresh();
    window.addEventListener(PRINT_HISTORY_EVENT, h);
    return () => window.removeEventListener(PRINT_HISTORY_EVENT, h);
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

  const reprintLast = async () => {
    const r = getLastReceipt();
    if (!r) { toast.error("Nenhum recibo anterior salvo"); return; }
    const d = await tryPrintEscPosDetailed(r, true);
    if (d.ok) toast.success(`Reimpresso via ${d.channel.toUpperCase()}`);
    else toast.error(`Falhou (${d.channel}): ${d.error ?? "erro"}`);
  };

  const syncCloud = async () => {
    setSyncing(true);
    try {
      const r = await syncPrintHistoryToCloud();
      if (r.error) toast.error(`Sync: ${r.error}`);
      else toast.success(`Sync Cloud: ${r.uploaded} enviadas · ${r.skipped} já sincronizadas`);
      refresh();
    } finally { setSyncing(false); }
  };

  const exportPdf = () => {
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const now = new Date();
    doc.setFontSize(14);
    doc.text("Relatório de Impressão — Bastion POS", 40, 40);
    doc.setFontSize(9);
    doc.text(`Gerado em: ${now.toLocaleString("pt-BR")}`, 40, 58);
    doc.text(`Impressora ativa: ${printerName ?? "auto"}`, 40, 72);
    doc.text(`Total: ${entries.length}  ·  OK: ${okCount}  ·  Erros: ${failCount}`, 40, 86);

    let y = 110;
    doc.setFontSize(9);
    doc.setFillColor(240, 240, 240);
    doc.rect(40, y - 12, 515, 16, "F");
    doc.text("Data/Hora", 44, y);
    doc.text("Canal", 160, y);
    doc.text("OK", 210, y);
    doc.text("Impressora", 240, y);
    doc.text("Papel", 370, y);
    doc.text("Venda", 410, y);
    doc.text("Erro", 470, y);
    y += 14;

    for (const e of entries) {
      if (y > 780) { doc.addPage(); y = 40; }
      doc.text(new Date(e.ts).toLocaleString("pt-BR"), 44, y);
      doc.text(e.channel.toUpperCase(), 160, y);
      doc.text(e.ok ? "✓" : "✗", 210, y);
      doc.text((e.printer ?? "-").slice(0, 22), 240, y);
      doc.text(e.paperWidth ? `${e.paperWidth}mm` : "-", 370, y);
      doc.text((e.saleId ?? "-").slice(0, 8).toUpperCase(), 410, y);
      const err = (e.error ?? "").slice(0, 40);
      if (err) doc.text(err, 470, y);
      y += 12;
    }
    doc.save(`impressao-${now.toISOString().slice(0, 10)}.pdf`);
    toast.success("PDF exportado");
  };

  const emailSupport = () => {
    const subject = encodeURIComponent(`[Bastion POS] Diagnóstico de impressão — ${printerName ?? "auto"}`);
    const summary = `Impressora: ${printerName ?? "auto"}\nUA: ${navigator.userAgent}\nTotal: ${entries.length} | OK: ${okCount} | Erros: ${failCount}\n\nÚltimas tentativas:\n`;
    const body = summary + entries.slice(0, 15).map((e) =>
      `${new Date(e.ts).toLocaleString("pt-BR")} · ${e.channel.toUpperCase()} · ${e.ok ? "OK" : "ERRO"} · ${e.printer ?? "-"}${e.error ? ` — ${e.error}` : ""}`
    ).join("\n");
    const url = `mailto:suporte@bastion.pos?subject=${subject}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank");
  };

  const okCount = entries.filter((e) => e.ok).length;
  const failCount = entries.length - okCount;
  const unsynced = entries.filter((e) => !e.synced).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Diagnóstico de impressão</DialogTitle>
          <DialogDescription>
            Histórico em tempo real, calibração, exportação e sincronização com o Cloud.
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

        {/* Ações rápidas */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Button size="sm" variant="outline" onClick={reprintLast} className="gap-1 text-xs">
            <RotateCcw className="size-3" /> Reimprimir último
          </Button>
          <Button size="sm" variant="outline" onClick={syncCloud} disabled={syncing} className="gap-1 text-xs">
            <Cloud className="size-3" /> {syncing ? "Enviando…" : `Sync Cloud${unsynced ? ` (${unsynced})` : ""}`}
          </Button>
          <Button size="sm" variant="outline" onClick={exportPdf} disabled={entries.length === 0} className="gap-1 text-xs">
            <FileDown className="size-3" /> Exportar PDF
          </Button>
          <Button size="sm" variant="outline" onClick={emailSupport} className="gap-1 text-xs">
            <Mail className="size-3" /> Enviar ao suporte
          </Button>
        </div>

        {/* Histórico */}
        <div className="border border-border rounded-md">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <div className="flex items-center gap-2 text-sm font-semibold">
              Histórico
              <Badge variant="outline" className="text-[10px]">{entries.length}</Badge>
              <span className="text-[10px] text-primary">{okCount} OK</span>
              <span className="text-[10px] text-destructive">{failCount} erro</span>
              {unsynced > 0 && <span className="text-[10px] text-amber-600">{unsynced} pendente(s)</span>}
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
                        {e.synced && <Cloud className="size-3 text-primary" />}
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
