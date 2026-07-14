import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getHardwareErrorMessage } from "@/lib/hardware-errors";
import { Printer, Usb, Cable, Server, CheckCircle2, XCircle, TestTube2, AlertCircle, Ruler, RefreshCw, RotateCcw, ExternalLink, Activity } from "lucide-react";
import { PrintDiagnosticsDialog } from "./print-diagnostics-dialog";
import { toast } from "sonner";
import {
  isEscPosEnabled,
  isEscPosSupported,
  requestEscPosPort,
  setEscPosEnabled,
  tryPrintEscPosDetailed,
} from "@/lib/escpos";
import { isWebUsbSupported, requestUsbPrinter, getGrantedUsbPrinter, forgetUsbPrinter } from "@/lib/escpos-usb";
import {
  getLastPrintError,
  getSelectedPrinter,
  isPrintAgentEnabled,
  pingPrintAgent,
  setPrintAgentEnabled,
  setSelectedPrinter,
  PRINT_AGENT_EVENT,
  type AgentPrinter,
  type AgentStatus,
} from "@/lib/print-agent";
import { getLastReceipt } from "@/lib/print-history";
import { DENSITY_LABELS, getPrintDensity, setPrintDensity, type PrintDensity } from "@/lib/print-density";
import { getBrowserDeviceFeatureState } from "@/lib/browser-device-permissions";

/**
 * Configuração de impressora térmica: canais, seleção fixa da impressora,
 * intensidade por dispositivo, teste de impressão e diagnóstico do último erro.
 */
export function EscPosPrinterButton() {
  const [serialEnabled, setSerialEnabled] = useState(() => isEscPosEnabled());
  const [usbAuthorized, setUsbAuthorized] = useState(false);
  const [usbName, setUsbName] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentStatus>({ online: false });
  const [agentEnabled, setAgentEnabled] = useState(() => isPrintAgentEnabled());
  const [selected, setSelected] = useState<string | null>(() => getSelectedPrinter());
  const [density, setDensityState] = useState<PrintDensity>(() => getPrintDensity(getSelectedPrinter()));
  const [lastErr, setLastErr] = useState<string | null>(() => getLastPrintError());
  const [testing, setTesting] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const usbState = getBrowserDeviceFeatureState("usb");
  const serialState = getBrowserDeviceFeatureState("serial");

  useEffect(() => {
    if (isWebUsbSupported()) {
      getGrantedUsbPrinter().then((d) => {
        setUsbAuthorized(!!d);
        setUsbName(d?.productName ?? null);
      }).catch(() => { /* noop */ });
    }
    const check = () => pingPrintAgent().then(setAgent).catch(() => setAgent({ online: false }));
    check();
    const t = setInterval(check, 15000);
    // Sincroniza estado local com eventos globais (multi-aba / outros componentes)
    const onAgent = (e: Event) => setAgent((e as CustomEvent<AgentStatus>).detail);
    window.addEventListener(PRINT_AGENT_EVENT, onAgent);
    return () => { clearInterval(t); window.removeEventListener(PRINT_AGENT_EVENT, onAgent); };
  }, []);

  // Ao trocar de impressora selecionada, recarrega densidade daquela impressora
  useEffect(() => { setDensityState(getPrintDensity(selected)); }, [selected]);

  const connectSerial = async () => {
    try { await requestEscPosPort(); setSerialEnabled(true); toast.success("Impressora serial conectada"); }
    catch (e) { toast.error(getHardwareErrorMessage(e, "serial")); }
  };
  const disconnectSerial = () => { setEscPosEnabled(false); setSerialEnabled(false); toast.info("Serial desativada"); };

  const connectUsb = async () => {
    try {
      const d = await requestUsbPrinter();
      setUsbAuthorized(true);
      setUsbName(d.productName ?? null);
      toast.success(`USB autorizada: ${d.productName ?? "impressora"}`);
    } catch (e) { toast.error(getHardwareErrorMessage(e, "usb")); }
  };

  const reauthorizeUsb = async () => {
    try {
      await forgetUsbPrinter();
      setUsbAuthorized(false);
      setUsbName(null);
      const d = await requestUsbPrinter();
      setUsbAuthorized(true);
      setUsbName(d.productName ?? null);
      toast.success(`USB reautorizada: ${d.productName ?? "impressora"}`);
    } catch (e) { toast.error(getHardwareErrorMessage(e, "usb")); }
  };

  const refreshAgent = async () => {
    const st = await pingPrintAgent();
    setAgent(st);
    if (st.online) toast.success(`Agente online · ${st.printers?.length ?? 0} impressora(s)`);
    else toast.error("Agente offline em 127.0.0.1:9100");
  };

  const toggleAgent = async () => {
    if (agentEnabled) { setPrintAgentEnabled(false); setAgentEnabled(false); toast.info("Agente desativado"); return; }
    const st = await pingPrintAgent();
    if (!st.online) { toast.error("Agente não encontrado em 127.0.0.1:9100. Instale o executável (ver /desktop/README.md)."); return; }
    setPrintAgentEnabled(true); setAgentEnabled(true); setAgent(st);
    toast.success(`Agente conectado · ${st.printers?.length ?? 0} impressora(s)`);
  };

  const pickPrinter = (name: string) => {
    const v = name === "__auto__" ? null : name;
    setSelectedPrinter(v);
    setSelected(v);
    toast.success(v ? `Impressora fixada: ${v}` : "Seleção automática ativada");
  };

  const changeDensity = (v: PrintDensity) => {
    setPrintDensity(v, selected);
    setDensityState(v);
    toast.success(`Intensidade ${DENSITY_LABELS[v]}${selected ? ` · ${selected}` : ""}`);
  };

  const runTest = async () => {
    setTesting(true);
    try {
      const paperFromAgent = agent.printers?.find((p) => p.name === (selected ?? ""))?.paperWidth;
      const paper = paperFromAgent ?? 80;
      const d = await tryPrintEscPosDetailed({
        store: { name: "TESTE DE IMPRESSAO", cnpj: null, address: null, phone: null },
        header: `Impressora: ${selected ?? "auto"}\nIntensidade: ${DENSITY_LABELS[density]}\nPapel detectado: ${paper}mm`,
        footer: "Se o texto estiver fraco, aumente a intensidade.",
        paper_width: paper as 58 | 80,
        items: [
          { name: "TESTE DE CONTRASTE #####", quantity: 1, unit_price: 0.01, total: 0.01 },
          { name: "abcdefghijklmnopqrstuvwxyz", quantity: 1, unit_price: 0, total: 0 },
        ],
        subtotal: 0.01, discount: 0, total: 0.01, payment_method: "teste",
        received: 0.01, change: 0,
        sale_id: "TESTE" + Date.now().toString(36).slice(-4), document_type: "nao_fiscal", issued_at: new Date(),
      }, false);
      if (d.ok) {
        toast.success(`Teste enviado via ${d.channel.toUpperCase()}${d.printer ? ` · ${d.printer}` : ""}`);
        setLastErr(null);
      } else {
        const msg = d.error ?? "Nenhum canal ESC/POS ativo";
        setLastErr(msg);
        toast.error(`Falhou (${d.channel}): ${msg}`);
      }
    } finally { setTesting(false); }
  };

  const reprintLast = async () => {
    const r = getLastReceipt();
    if (!r) { toast.error("Nenhum recibo anterior salvo"); return; }
    const d = await tryPrintEscPosDetailed(r, false);
    if (d.ok) { toast.success(`Reimpresso via ${d.channel.toUpperCase()}`); setLastErr(null); }
    else toast.error(`Falhou (${d.channel}): ${d.error ?? "erro"}`);
  };

  const anyActive = agentEnabled || usbAuthorized || serialEnabled;
  const printers: AgentPrinter[] = agent.printers ?? [];
  const activePrinter = printers.find((p) => p.name === (selected ?? printers[0]?.name));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 h-9">
          <Printer className={`size-4 ${anyActive ? "text-primary" : ""}`} />
          <span className="text-xs">
            {selected ? selected.slice(0, 18) :
              agentEnabled && agent.online ? "Agente" :
              usbAuthorized ? (usbName ?? "USB") :
              serialEnabled ? "Serial" :
              "Impressora"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <div className="p-3 border-b border-border">
          <div className="text-xs font-semibold mb-2">Impressora ativa</div>
          <Select value={selected ?? "__auto__"} onValueChange={pickPrinter}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Automática" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">Automática (primeira disponível)</SelectItem>
              {printers.map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  {p.name}{p.paperWidth ? ` · ${p.paperWidth}mm` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {activePrinter && (
            <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
              <Ruler className="size-3" />
              <span>Papel: <strong>{activePrinter.paperWidth ?? "não reportado"}{activePrinter.paperWidth ? "mm" : ""}</strong></span>
              {activePrinter.status && <span>· {activePrinter.status}</span>}
            </div>
          )}
        </div>

        <div className="p-3 border-b border-border">
          <div className="text-xs font-semibold mb-2">Contraste (por impressora)</div>
          <Select value={density} onValueChange={(v) => changeDensity(v as PrintDensity)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{DENSITY_LABELS.light}</SelectItem>
              <SelectItem value="medium">{DENSITY_LABELS.medium}</SelectItem>
              <SelectItem value="dark">{DENSITY_LABELS.dark}</SelectItem>
              <SelectItem value="extra_dark">{DENSITY_LABELS.extra_dark}</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="w-full mt-2 gap-2 h-8" onClick={runTest} disabled={testing}>
            <TestTube2 className="size-3" /> {testing ? "Imprimindo…" : "Imprimir teste"}
          </Button>
        </div>

        <div className="p-2 space-y-1">
          <ChannelRow
            icon={<Server className="size-4" />}
            title="Agente Local (127.0.0.1)"
            subtitle={agent.online ? `Online · v${agent.version ?? "?"} · ${printers.length} impressora(s)` : "Offline · instale o .exe/.msi"}
            ok={agentEnabled && agent.online}
            onClick={toggleAgent}
          />
          <ChannelRow
            icon={<Usb className="size-4" />}
            title="WebUSB direto"
            subtitle={isWebUsbSupported() ? (usbAuthorized ? `Autorizada: ${usbName ?? "impressora"}` : "Clique para autorizar") : usbState.message}
            ok={usbAuthorized}
            onClick={connectUsb}
            disabled={!isWebUsbSupported()}
          />
          <ChannelRow
            icon={<Cable className="size-4" />}
            title="Web Serial (COM / USB→Serial)"
            subtitle={isEscPosSupported() ? (serialEnabled ? "Clique para desativar" : "Clique para autorizar") : serialState.message}
            ok={serialEnabled}
            onClick={serialEnabled ? disconnectSerial : connectSerial}
            disabled={!isEscPosSupported()}
          />
        </div>

        {lastErr && <PrintErrorPanel message={lastErr} onClear={() => setLastErr(null)} onReauthUsb={reauthorizeUsb} onRefreshAgent={refreshAgent} />}

        <div className="px-3 py-2 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
          <button onClick={() => setDiagOpen(true)} className="flex items-center gap-1 hover:text-foreground">
            <Activity className="size-3" /> Diagnóstico
          </button>
          <button onClick={refreshAgent} className="flex items-center gap-1 hover:text-foreground">
            <RefreshCw className="size-3" /> Atualizar
          </button>
        </div>
      </PopoverContent>
      <PrintDiagnosticsDialog open={diagOpen} onOpenChange={setDiagOpen} printerName={selected} />
    </Popover>
  );
}

function ChannelRow({ icon, title, subtitle, ok, onClick, disabled }: {
  icon: React.ReactNode; title: string; subtitle: string;
  ok: boolean; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left px-2 py-1.5 rounded hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="font-medium text-xs flex-1">{title}</span>
        {ok ? <CheckCircle2 className="size-4 text-primary" /> : <XCircle className="size-4 text-muted-foreground/50" />}
      </div>
      <div className="text-[10px] text-muted-foreground pl-6">{subtitle}</div>
    </button>
  );
}

/**
 * Painel de erro com remediação inteligente. Detecta "Access denied" (WebUSB
 * bloqueado pelo driver do Windows) e oferece as três saídas possíveis:
 * instalar Agente Local, trocar driver via Zadig, ou reautorizar USB.
 */
function PrintErrorPanel({ message, onClear, onReauthUsb, onRefreshAgent }: {
  message: string;
  onClear: () => void;
  onReauthUsb: () => void;
  onRefreshAgent: () => void;
}) {
  const isAccessDenied = /access denied|acesso negado/i.test(message);
  const isAgentDown = /agente|failed to fetch|127\.0\.0\.1/i.test(message);

  return (
    <div className="p-3 border-t border-border bg-destructive/10 space-y-2">
      <div className="flex items-start gap-2 text-[11px] text-destructive">
        <AlertCircle className="size-3 mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="font-semibold mb-0.5">Último erro de impressão</div>
          <div className="opacity-90 break-words">{message}</div>
        </div>
      </div>

      {isAccessDenied && (
        <div className="text-[10px] text-foreground/80 bg-background/50 rounded p-2 space-y-1.5 leading-relaxed">
          <div className="font-semibold text-destructive">Windows travou o acesso USB</div>
          <div>O driver de impressora do Windows reservou a interface — o navegador não consegue abri-la. Reautorizar <strong>não resolve</strong>. Use uma das opções abaixo:</div>
          <ol className="list-decimal pl-4 space-y-1">
            <li><strong>Instale o Agente Local</strong> (recomendado): imprime via driver do Windows sem conflito.</li>
            <li><strong>Zadig → WinUSB</strong>: substitua o driver por WinUSB para liberar o WebUSB.</li>
            <li><strong>Desinstale o driver</strong> da impressora e conecte-a como dispositivo genérico.</li>
          </ol>
        </div>
      )}

      {isAgentDown && !isAccessDenied && (
        <div className="text-[10px] text-foreground/80 bg-background/50 rounded p-2 leading-relaxed">
          O Agente Local não respondeu em <code>127.0.0.1:9100</code>. Verifique se o executável está rodando (bandeja do sistema) e clique em <strong>Atualizar</strong>.
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {isAccessDenied && (
          <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]" onClick={onRefreshAgent}>
            <Server className="size-3" /> Tentar Agente Local
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]" onClick={onReauthUsb}>
          <RotateCcw className="size-3" /> Reautorizar USB
        </Button>
        <a
          href="https://zadig.akeo.ie/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[10px] px-2 h-7 rounded border border-input hover:bg-accent"
        >
          <ExternalLink className="size-3" /> Baixar Zadig
        </a>
        <Button size="sm" variant="ghost" className="h-7 text-[10px] ml-auto" onClick={onClear}>Limpar</Button>
      </div>
    </div>
  );
}
