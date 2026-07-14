import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getHardwareErrorMessage } from "@/lib/hardware-errors";
import { Printer, Usb, Cable, Server, CheckCircle2, XCircle, TestTube2, AlertCircle, Ruler, RefreshCw, RotateCcw, ExternalLink } from "lucide-react";
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
  type AgentPrinter,
  type AgentStatus,
} from "@/lib/print-agent";
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
    return () => clearInterval(t);
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
          <span>Ordem: <strong>Agente → USB → Serial</strong></span>
          <button onClick={refreshAgent} className="flex items-center gap-1 hover:text-foreground">
            <RefreshCw className="size-3" /> Atualizar
          </button>
        </div>
      </PopoverContent>
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
