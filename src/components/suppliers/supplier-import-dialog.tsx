/**
 * Importação de fornecedores em lote.
 *
 * O fluxo é sempre "carregar → conferir → gravar": nada vai ao banco antes do
 * lojista ver o espelho das linhas, os erros por linha e as duplicidades
 * detectadas. Isso evita cadastros duplicados vindos de planilhas antigas.
 */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Upload, FileDown, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  parseSupplierCsv,
  markDuplicates,
  toSupplierInsert,
  SUPPLIER_CSV_TEMPLATE,
  type ParsedImport,
} from "@/lib/supplier-import";

export interface SupplierImportDialogProps {
  storeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fornecedores já cadastrados, para detecção de duplicidade. */
  existing: Array<{ name: string; cnpj: string | null }>;
}

export function SupplierImportDialog({
  storeId, open, onOpenChange, existing,
}: SupplierImportDialogProps) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [text, setText] = useState("");
  const [skipDuplicates, setSkipDuplicates] = useState(true);

  const reset = () => { setParsed(null); setText(""); };

  const analyze = (content: string) => {
    const result = markDuplicates(parseSupplierCsv(content), existing);
    setParsed(result);
    if (result.rows.length === 0) toast.error("Nenhuma linha de dados encontrada no arquivo");
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Arquivo maior que 5 MB");
      return;
    }
    const content = await file.text();
    setText(content);
    analyze(content);
  };

  const importable = useMemo(
    () =>
      (parsed?.rows ?? []).filter(
        (r) => r.data && r.errors.length === 0 && !(skipDuplicates && r.duplicate),
      ),
    [parsed, skipDuplicates],
  );

  const run = useMutation({
    mutationFn: async () => {
      if (importable.length === 0) throw new Error("Nenhuma linha válida para importar");
      const payload = importable.map((r) => toSupplierInsert(storeId, r.data!));
      // Lotes pequenos para uma linha ruim não derrubar o arquivo inteiro.
      let inserted = 0;
      for (let i = 0; i < payload.length; i += 50) {
        const chunk = payload.slice(i, i + 50);
        const { error } = await supabase.from("suppliers").insert(chunk);
        if (error) throw new Error(`Lote ${i / 50 + 1}: ${error.message}`);
        inserted += chunk.length;
      }
      return inserted;
    },
    onSuccess: (count) => {
      toast.success(`${count} fornecedor(es) importado(s)`);
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      reset();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const downloadTemplate = () => {
    const blob = new Blob([`\uFEFF${SUPPLIER_CSV_TEMPLATE}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "modelo-fornecedores.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const errorCount = (parsed?.rows ?? []).filter((r) => r.errors.length > 0).length;
  const dupCount = (parsed?.rows ?? []).filter((r) => r.duplicate).length;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar fornecedores em lote</DialogTitle>
          <DialogDescription>
            Aceita CSV ou texto delimitado por <code>;</code>, <code>,</code> ou tabulação.
            Os cabeçalhos são reconhecidos automaticamente (nome, cnpj, telefone, email,
            formas de pagamento, prazo…).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <Button variant="outline" className="gap-2" onClick={() => fileRef.current?.click()}>
              <Upload className="size-4" /> Escolher arquivo
            </Button>
            <Button variant="outline" className="gap-2" onClick={downloadTemplate}>
              <FileDown className="size-4" /> Baixar modelo
            </Button>
            {parsed && (
              <Button variant="ghost" onClick={reset}>Limpar</Button>
            )}
          </div>

          <div>
            <Textarea
              rows={4}
              className="font-mono text-xs"
              placeholder="…ou cole as linhas da planilha aqui"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <Button
              size="sm"
              className="mt-2"
              variant="secondary"
              disabled={!text.trim()}
              onClick={() => analyze(text)}
            >
              Analisar conteúdo colado
            </Button>
          </div>

          {parsed && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline" className="gap-1">
                  <CheckCircle2 className="size-3 text-primary" /> {parsed.validCount} válidas
                </Badge>
                {errorCount > 0 && (
                  <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive">
                    <AlertTriangle className="size-3" /> {errorCount} com erro
                  </Badge>
                )}
                {dupCount > 0 && (
                  <Badge variant="outline" className="gap-1 border-warning/40 text-warning">
                    {dupCount} já cadastrado(s)
                  </Badge>
                )}
                {parsed.unknownColumns.length > 0 && (
                  <span className="text-muted-foreground">
                    Colunas ignoradas: {parsed.unknownColumns.join(", ")}
                  </span>
                )}
              </div>

              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={skipDuplicates}
                  onCheckedChange={(c) => setSkipDuplicates(c === true)}
                />
                Ignorar fornecedores já cadastrados (mesmo CNPJ ou nome)
              </label>

              <div className="border border-border rounded-md overflow-hidden max-h-72 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-14">Linha</TableHead>
                      <TableHead>Nome</TableHead>
                      <TableHead className="w-36 font-mono text-xs">CNPJ</TableHead>
                      <TableHead className="w-40">Contato</TableHead>
                      <TableHead className="w-40">Pagamento</TableHead>
                      <TableHead className="w-56">Situação</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsed.rows.map((row) => {
                      const willImport = importable.includes(row);
                      return (
                        <TableRow key={row.line} className={willImport ? "" : "opacity-60"}>
                          <TableCell className="font-mono text-xs">{row.line}</TableCell>
                          <TableCell className="font-medium text-sm">
                            {row.data?.name || row.raw.nome || "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{row.data?.cnpj || "—"}</TableCell>
                          <TableCell className="text-xs">
                            {[row.data?.phone, row.data?.email].filter(Boolean).join(" · ") || "—"}
                          </TableCell>
                          <TableCell className="text-xs">
                            {row.data?.payment_methods.join(", ") || "—"}
                          </TableCell>
                          <TableCell className="text-xs">
                            {row.errors.length > 0 ? (
                              <span className="text-destructive">{row.errors.join(" | ")}</span>
                            ) : row.duplicate ? (
                              <span className="text-warning">
                                Já existe ({row.duplicate}) {skipDuplicates ? "— será ignorado" : "— será duplicado"}
                              </span>
                            ) : (
                              <span className="text-primary">Pronto para importar</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Fechar</Button>
          <Button
            disabled={!parsed || importable.length === 0 || run.isPending}
            onClick={() => run.mutate()}
            className="gap-2"
          >
            {run.isPending && <Loader2 className="size-4 animate-spin" />}
            Importar {importable.length > 0 ? `${importable.length} fornecedor(es)` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
