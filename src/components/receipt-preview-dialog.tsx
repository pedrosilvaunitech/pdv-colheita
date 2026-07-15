import { useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Printer, X } from "lucide-react";
import { buildReceiptHTML, type ReceiptData } from "@/lib/receipt";

/**
 * Prévia visual do cupom não-fiscal — renderiza o mesmo HTML térmico que
 * seria impresso, dentro de um iframe. O operador vê exatamente como vai
 * sair no papel (largura 58/80 mm, negrito, alinhamentos), sem gastar bobina.
 */
export function ReceiptPreviewDialog({
  open, onOpenChange, data, onPrint,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  data: ReceiptData | null;
  onPrint?: () => void;
}) {
  const html = useMemo(() => (data ? buildReceiptHTML(data) : ""), [data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Prévia do cupom</DialogTitle>
          <DialogDescription>
            Papel {data?.paper_width ?? 80}mm — como vai sair na impressora térmica.
          </DialogDescription>
        </DialogHeader>

        <div className="bg-muted rounded-md p-3 flex justify-center max-h-[60vh] overflow-y-auto">
          {data ? (
            <iframe
              title="Prévia do cupom"
              srcDoc={html}
              className="bg-white border border-border rounded shadow-sm"
              style={{
                width: `${(data.paper_width ?? 80) * 3.78}px`, // mm → px aprox (@ 96dpi)
                minHeight: 400,
                border: "1px solid hsl(var(--border))",
              }}
            />
          ) : (
            <div className="text-xs text-muted-foreground py-10">Sem dados para prévia.</div>
          )}
        </div>

        <DialogFooter className="gap-2">
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
  );
}
