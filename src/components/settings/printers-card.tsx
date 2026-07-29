/**
 * Configuração de impressoras do terminal.
 *
 * A escolha é POR LOJA + TERMINAL (o PC do caixa), não por usuário: quem senta
 * no caixa 2 precisa da impressora do caixa 2, independente do login. Por isso
 * seleção, largura de papel e codepage vivem no localStorage do navegador.
 *
 * Fontes unificadas: Agente Local (USB bruto), spooler do Windows e WebUSB.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Printer, RefreshCw, Ruler, Languages, Loader2, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  pingPrintAgent,
  getSelectedPrinterForStore,
  setSelectedPrinterForStore,
  type AgentPrinter,
  type StoredPrinterSelection,
} from "@/lib/print-agent";
import { getTerminalLabel } from "@/lib/print-agent";
import {
  getPrinterPaperWidth,
  setPrinterPaperWidth,
  getPrinterCodepage,
  setPrinterCodepage,
  buildCalibrationPayload,
} from "@/lib/printer-config";
import { CODEPAGE_OPTIONS, type Codepage } from "@/lib/escpos-codepage";
import { sendRawEscPos } from "@/lib/escpos";

interface Props {
  storeId: string | null;
}

const SOURCE_LABEL: Record<AgentPrinter["source"], string> = {
  agent: "Agente (USB)",
  windows: "Windows (spooler)",
  webusb: "WebUSB",
};

export function PrintersCard({ storeId }: Props) {
  const [loading, setLoading] = useState(true);
  const [agentOnline, setAgentOnline] = useState(false);
  const [printers, setPrinters] = useState<AgentPrinter[]>([]);
  const [selected, setSelected] = useState<StoredPrinterSelection | null>(null);
  const [paper, setPaper] = useState<"58" | "80" | "auto">("auto");
  const [codepage, setCodepage] = useState<Codepage>("cp850");
  const [testing, setTesting] = useState(false);

  /** Recarrega a lista do agente e sincroniza os overrides da impressora ativa. */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const status = await pingPrintAgent(4000);
      setAgentOnline(!!status.online);
      setPrinters(status.printers ?? []);
    } catch {
      setAgentOnline(false);
      setPrinters([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const sel = getSelectedPrinterForStore(storeId);
    setSelected(sel);
    const width = getPrinterPaperWidth(sel?.name ?? null);
    setPaper(width ? (String(width) as "58" | "80") : "auto");
    setCodepage(getPrinterCodepage(sel?.name ?? null) ?? "cp850");
  }, [storeId]);

  function choose(p: AgentPrinter) {
    const sel: StoredPrinterSelection = { name: p.name, source: p.source };
    setSelectedPrinterForStore(storeId, sel);
    setSelected(sel);
    const width = getPrinterPaperWidth(p.name) ?? p.paperWidth ?? null;
    setPaper(width ? (String(width) as "58" | "80") : "auto");
    setCodepage(getPrinterCodepage(p.name) ?? "cp850");
    toast.success(`Impressora "${p.name}" definida para este terminal.`);
  }

  function changePaper(v: "58" | "80" | "auto") {
    setPaper(v);
    if (!selected) return;
    if (v === "auto") setPrinterPaperWidth(selected.name, 80);
    else setPrinterPaperWidth(selected.name, Number(v) as 58 | 80);
  }

  function changeCodepage(v: Codepage) {
    setCodepage(v);
    if (selected) setPrinterCodepage(selected.name, v);
  }

  /** Régua de calibração: revela largura errada e acentos quebrados de uma vez. */
  async function printCalibration() {
    setTesting(true);
    try {
      const result = await sendRawEscPos(buildCalibrationPayload(selected?.name ?? null));
      if (result.ok) toast.success(`Calibração enviada (canal: ${result.channel ?? "—"}).`);
      else toast.error(result.error ?? "Não foi possível imprimir a calibração.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao imprimir.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Printer className="size-4" /> Impressoras deste terminal
        </CardTitle>
        <CardDescription>
          Terminal <span className="font-mono">#{getTerminalLabel()}</span>. A escolha vale só neste computador —
          cada caixa aponta para a própria impressora.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={agentOnline ? "default" : "secondary"} className={cn(agentOnline && "bg-emerald-600")}>
            {agentOnline ? "Agente Local online" : "Agente Local offline"}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            <span className="ml-1">Procurar impressoras</span>
          </Button>
        </div>

        {!loading && printers.length === 0 && (
          <p className="rounded border border-dashed p-3 text-xs text-muted-foreground">
            Nenhuma impressora encontrada. Instale/abra o Agente Local, ou autorize a impressora por WebUSB no botão
            “Impressora” dentro do PDV.
          </p>
        )}

        <ul className="space-y-2">
          {printers.map((p) => {
            const active = selected?.name === p.name;
            return (
              <li
                key={`${p.source}:${p.name}`}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded border p-3 text-sm",
                  active ? "border-primary bg-primary/5" : "border-border",
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {SOURCE_LABEL[p.source]}
                    {p.model ? ` · ${p.model}` : ""}
                    {p.paperWidth ? ` · ${p.paperWidth}mm` : ""}
                    {p.isDefault ? " · padrão do Windows" : ""}
                  </p>
                </div>
                <Badge variant={p.status === "online" ? "secondary" : "destructive"}>
                  {p.status === "online" ? "Pronta" : (p.statusMessage ?? p.status)}
                </Badge>
                {active ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                    <CheckCircle2 className="size-3" /> Em uso
                  </span>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => choose(p)}>
                    Usar esta
                  </Button>
                )}
              </li>
            );
          })}
        </ul>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-xs">
              <Ruler className="size-3" /> Largura do papel
            </Label>
            <Select value={paper} onValueChange={(v) => changePaper(v as "58" | "80" | "auto")} disabled={!selected}>
              <SelectTrigger>
                <SelectValue placeholder="Automático" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automático (reportado pela impressora)</SelectItem>
                <SelectItem value="80">80mm — 48 colunas</SelectItem>
                <SelectItem value="58">58mm — 32 colunas</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Texto cortado na lateral? Troque a largura e recalibre.</p>
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-xs">
              <Languages className="size-3" /> Codepage (acentos)
            </Label>
            <Select value={codepage} onValueChange={(v) => changeCodepage(v as Codepage)} disabled={!selected}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CODEPAGE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Saiu “Ã§Ã£o” no lugar de “ção”? Troque o codepage e imprima a calibração.
            </p>
          </div>
        </div>

        <Button variant="outline" onClick={() => void printCalibration()} disabled={testing || !selected}>
          {testing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Ruler className="mr-2 size-4" />}
          Imprimir régua de calibração
        </Button>
      </CardContent>
    </Card>
  );
}
