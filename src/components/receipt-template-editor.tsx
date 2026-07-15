import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ArrowUp, ArrowDown, Trash2, Plus, RotateCcw, Save, Lock,
  AlignLeft, AlignCenter, AlignRight, Bold, ZoomIn, ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { buildReceiptHTML, type ReceiptData } from "@/lib/receipt";
import { ReceiptPaperPreview, type ReceiptPreviewZoom } from "@/components/receipt-paper-preview";
import {
  loadTemplate, saveTemplate, resetTemplate,
  moveBlock, updateBlock, removeBlock, addCustomTextBlock, addSeparatorBlock,
  BLOCK_LABEL,
  type ReceiptTemplate, type BlockAlign, type BlockSize,
} from "@/lib/receipt-template";
import { useCurrentStore } from "@/lib/current-store";

/**
 * Editor "estilo blocos" do cupom — cada bloco tem toggle, ordem (↑/↓),
 * alinhamento, negrito, tamanho e (quando aplicável) texto livre. Blocos
 * legais do fiscal (tributos, NFC-e info, QR, chave) ficam travados.
 *
 * Prévia ao vivo ao lado — usa exatamente o mesmo `buildReceiptHTML` da
 * impressão, então "o que você vê é o que sai".
 */
export function ReceiptTemplateEditor({
  open, onOpenChange, sampleData,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sampleData: ReceiptData; // dados de exemplo pra popular a prévia
}) {
  const { storeId } = useCurrentStore();
  const [docType, setDocType] = useState<"fiscal" | "nao_fiscal">(sampleData.document_type);
  const [tpl, setTpl] = useState<ReceiptTemplate>(() => loadTemplate(storeId, docType));
  const [zoom, setZoom] = useState<ReceiptPreviewZoom>("125");

  // Recarrega ao trocar tipo/loja
  useEffect(() => { setTpl(loadTemplate(storeId, docType)); }, [storeId, docType]);

  const previewData: ReceiptData = useMemo(
    () => ({ ...sampleData, document_type: docType }),
    [sampleData, docType],
  );
  const html = useMemo(() => buildReceiptHTML(previewData, tpl), [previewData, tpl]);
  const zoomOptions: ReceiptPreviewZoom[] = ["100", "125", "150", "175"];
  const zoomIndex = zoomOptions.indexOf(zoom);

  const save = () => {
    saveTemplate(storeId, docType, tpl);
    toast.success(`Template ${docType === "fiscal" ? "fiscal" : "não-fiscal"} salvo`);
    onOpenChange(false);
  };

  const doReset = () => {
    if (!confirm("Restaurar o template padrão? Suas edições serão perdidas.")) return;
    setTpl(resetTemplate(storeId, docType));
    toast.info("Template restaurado");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[98vw] max-w-none h-[94vh] max-h-[94vh] overflow-hidden flex flex-col p-0">
        <div className="px-4 py-3 border-b border-border">
          <DialogHeader>
            <DialogTitle>Editor do cupom</DialogTitle>
            <DialogDescription>
              Configure os blocos e acompanhe a nota em tamanho ampliado ao lado.
            </DialogDescription>
          </DialogHeader>
        </div>

        <Tabs value={docType} onValueChange={(v) => setDocType(v as "fiscal" | "nao_fiscal")} className="flex-1 overflow-hidden flex flex-col px-4 py-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <TabsList className="w-fit">
              <TabsTrigger value="nao_fiscal">Recibo não-fiscal</TabsTrigger>
              <TabsTrigger value="fiscal">Cupom fiscal (NFC-e)</TabsTrigger>
            </TabsList>
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

          <TabsContent value={docType} className="flex-1 overflow-hidden mt-3">
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(430px,0.9fr)_minmax(520px,1.1fr)] gap-4 h-full">
              {/* Blocos */}
              <div className="border border-border rounded-md p-2 overflow-y-auto min-h-0">
                {docType === "fiscal" && (
                  <div className="mb-2 text-[11px] bg-warning/10 border border-warning/30 rounded p-2 flex items-start gap-1.5 text-warning">
                    <Lock className="size-3 mt-0.5" />
                    <span>Blocos legais (tributos, NFC-e nº, QR, chave) são obrigatórios pela SEFAZ e ficam travados.</span>
                  </div>
                )}
                <div className="space-y-1.5">
                  {tpl.blocks.map((b, idx) => {
                    const isFirst = idx === 0;
                    const isLast = idx === tpl.blocks.length - 1;
                    const isTextual = b.kind === "custom_text" || b.kind === "header_msg" || b.kind === "footer_msg";
                    return (
                      <div key={b.id} className={`rounded-md border p-2 ${b.enabled ? "bg-card" : "bg-muted/40 opacity-60"} ${b.locked ? "border-amber-400/40" : "border-border"}`}>
                        <div className="flex items-center gap-1.5">
                          <div className="flex flex-col">
                            <Button size="icon" variant="ghost" className="h-5 w-5" disabled={isFirst} onClick={() => setTpl(moveBlock(tpl, b.id, -1))}>
                              <ArrowUp className="size-3" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-5 w-5" disabled={isLast} onClick={() => setTpl(moveBlock(tpl, b.id, 1))}>
                              <ArrowDown className="size-3" />
                            </Button>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-medium truncate">{BLOCK_LABEL[b.kind]}</span>
                              {b.locked && <Badge variant="outline" className="h-4 text-[9px] gap-0.5 border-warning/40 text-warning"><Lock className="size-2.5" /> Legal</Badge>}
                            </div>
                          </div>
                          <Switch checked={b.enabled} disabled={b.locked} onCheckedChange={(v) => setTpl(updateBlock(tpl, b.id, { enabled: v }))} />
                          {!b.locked && (
                            <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => setTpl(removeBlock(tpl, b.id))}>
                              <Trash2 className="size-3" />
                            </Button>
                          )}
                        </div>

                        {b.enabled && b.kind !== "separator" && (
                          <div className="mt-2 grid grid-cols-[auto_auto_1fr] gap-1.5 items-center">
                            <div className="flex rounded border border-border overflow-hidden">
                              {(["left", "center", "right"] as BlockAlign[]).map((a) => (
                                <button key={a} onClick={() => setTpl(updateBlock(tpl, b.id, { align: a }))}
                                  className={`px-1.5 py-1 ${b.align === a ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
                                  title={a}>
                                  {a === "left" ? <AlignLeft className="size-3" /> : a === "center" ? <AlignCenter className="size-3" /> : <AlignRight className="size-3" />}
                                </button>
                              ))}
                            </div>
                            <button onClick={() => setTpl(updateBlock(tpl, b.id, { bold: !b.bold }))}
                              className={`px-1.5 py-1 rounded border border-border ${b.bold ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
                              title="Negrito">
                              <Bold className="size-3" />
                            </button>
                            <Select value={b.size} onValueChange={(v) => setTpl(updateBlock(tpl, b.id, { size: v as BlockSize }))}>
                              <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="sm">Pequeno</SelectItem>
                                <SelectItem value="md">Médio</SelectItem>
                                <SelectItem value="lg">Grande</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        )}

                        {b.enabled && isTextual && (
                          b.kind === "custom_text" ? (
                            <Textarea
                              className="mt-2 text-xs min-h-[50px]"
                              placeholder="Digite o texto…"
                              value={b.text ?? ""}
                              onChange={(e) => setTpl(updateBlock(tpl, b.id, { text: e.target.value }))}
                            />
                          ) : (
                            <Input
                              className="mt-2 h-8 text-xs"
                              placeholder={b.kind === "header_msg" ? "Mensagem topo (opcional)" : "Mensagem rodapé (opcional)"}
                              value={b.text ?? ""}
                              onChange={(e) => setTpl(updateBlock(tpl, b.id, { text: e.target.value }))}
                            />
                          )
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setTpl(addCustomTextBlock(tpl))}>
                    <Plus className="size-3" /> Bloco de texto
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setTpl(addSeparatorBlock(tpl))}>
                    <Plus className="size-3" /> Separador
                  </Button>
                </div>
              </div>

              {/* Prévia */}
              <div className="border border-border rounded-md bg-muted/40 overflow-auto min-h-0 p-3">
                <div className="text-[10px] text-muted-foreground mb-3 text-center font-mono uppercase">
                  Prévia — papel {previewData.paper_width}mm
                </div>
                <ReceiptPaperPreview html={html} paperWidth={previewData.paper_width ?? 80} zoom={zoom} />
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" onClick={doReset} className="gap-1 mr-auto">
            <RotateCcw className="size-4" /> Restaurar padrão
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={save} className="gap-1">
            <Save className="size-4" /> Salvar template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
