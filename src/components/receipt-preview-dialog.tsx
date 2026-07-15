import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Printer, X, Pencil, ZoomIn, ZoomOut } from "lucide-react";
import { buildReceiptHTML, type ReceiptData } from "@/lib/receipt";
import { ReceiptTemplateEditor } from "@/components/receipt-template-editor";
import { ReceiptPaperPreview, type ReceiptPreviewZoom } from "@/components/receipt-paper-preview";

/**
 * Prévia visual do cupom — renderiza o mesmo HTML térmico que seria impresso,
 * dentro de um iframe. Botão "Editar" abre o editor de blocos.
 */
export function ReceiptPreviewDialog({
  open, onOpenChange, data, onPrint,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  data: ReceiptData | null;
  onPrint?: () => void;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [zoom, setZoom] = useState<ReceiptPreviewZoom>("150");
  // Nota: recomputa quando editor fecha (template pode ter mudado)
  const html = useMemo(() => (data ? buildReceiptHTML(data) : ""), [data, editorOpen]);
  const zoomOptions: ReceiptPreviewZoom[] = ["100", "125", "150", "175"];
  const zoomIndex = zoomOptions.indexOf(zoom);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[96vw] max-w-none h-[92vh] max-h-[92vh] p-0 overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-border flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <DialogHeader className="space-y-1">
              <DialogTitle>Prévia do cupom</DialogTitle>
              <DialogDescription>
                Papel {data?.paper_width ?? 80}mm — a impressão pelo Agente usa este mesmo HTML.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setZoom(zoomOptions[Math.max(0, zoomIndex - 1)])}
                disabled={zoomIndex <= 0}
                aria-label="Diminuir prévia"
              >
                <ZoomOut className="size-4" />
              </Button>
              <div className="h-9 min-w-14 rounded-sm border border-border px-2 flex items-center justify-center text-xs font-mono text-muted-foreground">
                {zoom}%
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setZoom(zoomOptions[Math.min(zoomOptions.length - 1, zoomIndex + 1)])}
                disabled={zoomIndex >= zoomOptions.length - 1}
                aria-label="Aumentar prévia"
              >
                <ZoomIn className="size-4" />
              </Button>
            </div>
          </div>

          <div className="flex-1 bg-muted/40 overflow-auto p-4 md:p-6">
            {data ? (
              <ReceiptPaperPreview html={html} paperWidth={data.paper_width ?? 80} zoom={zoom} />
            ) : (
              <div className="text-xs text-muted-foreground py-10">Sem dados para prévia.</div>
            )}
          </div>

          <DialogFooter className="gap-2 flex-wrap border-t border-border px-4 py-3">
            <Button variant="outline" onClick={() => setEditorOpen(true)} className="gap-1 md:mr-auto" disabled={!data}>
              <Pencil className="size-4" /> Editar cupom
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)} className="gap-1">
              <X className="size-4" /> Fechar
            </Button>
            {onPrint && (
              <Button onClick={onPrint} className="gap-1">
                <Printer className="size-4" /> Imprimir teste real
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {data && (
        <ReceiptTemplateEditor open={editorOpen} onOpenChange={setEditorOpen} sampleData={data} />
      )}
    </>
  );
}
