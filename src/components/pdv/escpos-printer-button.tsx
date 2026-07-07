import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getHardwareErrorMessage } from "@/lib/hardware-errors";
import { Printer, Usb, Cable, Server, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { isEscPosEnabled, isEscPosSupported, requestEscPosPort, setEscPosEnabled } from "@/lib/escpos";
import { isWebUsbSupported, requestUsbPrinter, getGrantedUsbPrinter } from "@/lib/escpos-usb";
import { isPrintAgentEnabled, pingPrintAgent, setPrintAgentEnabled, type AgentStatus } from "@/lib/print-agent";
import { getBrowserDeviceFeatureState } from "@/lib/browser-device-permissions";

/**
 * Botão unificado de configuração de impressora térmica.
 * Oferece três canais, do mais confiável para o mais universal:
 *   1) Agente Local (.exe/.msi) — recomendado no Windows
 *   2) WebUSB — impressora USB direta (Chrome/Edge; ótimo no Linux/macOS)
 *   3) Web Serial — impressoras seriais ou USB→Serial
 */
export function EscPosPrinterButton() {
  const [serialEnabled, setSerialEnabled] = useState(() => isEscPosEnabled());
  const [usbAuthorized, setUsbAuthorized] = useState(false);
  const [agent, setAgent] = useState<AgentStatus>({ online: false });
  const [agentEnabled, setAgentEnabled] = useState(() => isPrintAgentEnabled());
  const usbState = getBrowserDeviceFeatureState("usb");
  const serialState = getBrowserDeviceFeatureState("serial");

  useEffect(() => {
    if (isWebUsbSupported()) getGrantedUsbPrinter().then((d) => setUsbAuthorized(!!d)).catch(() => { /* noop */ });
    const check = () => pingPrintAgent().then(setAgent).catch(() => setAgent({ online: false }));
    check();
    const t = setInterval(check, 15000);
    return () => clearInterval(t);
  }, []);

  const connectSerial = async () => {
    try { await requestEscPosPort(); setSerialEnabled(true); toast.success("Impressora serial conectada"); }
    catch (e) { toast.error(getHardwareErrorMessage(e, "serial")); }
  };
  const disconnectSerial = () => { setEscPosEnabled(false); setSerialEnabled(false); toast.info("Serial desativada"); };

  const connectUsb = async () => {
    try { const d = await requestUsbPrinter(); setUsbAuthorized(true); toast.success(`USB autorizada: ${d.productName ?? "impressora"}`); }
    catch (e) { toast.error(getHardwareErrorMessage(e, "usb")); }
  };

  const toggleAgent = async () => {
    if (agentEnabled) { setPrintAgentEnabled(false); setAgentEnabled(false); toast.info("Agente desativado"); return; }
    const st = await pingPrintAgent();
    if (!st.online) { toast.error("Agente não encontrado em 127.0.0.1:9100. Instale o executável (ver /desktop/README.md)."); return; }
    setPrintAgentEnabled(true); setAgentEnabled(true); setAgent(st);
    toast.success(`Agente conectado · ${st.printers?.length ?? 0} impressora(s)`);
  };

  const anyActive = agentEnabled || usbAuthorized || serialEnabled;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 h-9">
          <Printer className={`size-4 ${anyActive ? "text-primary" : ""}`} />
          <span className="text-xs">
            {agentEnabled && agent.online ? "Agente ativo" :
             usbAuthorized ? "USB ativa" :
             serialEnabled ? "Serial ativa" :
             "Impressora"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80">
        <DropdownMenuLabel className="text-xs">Canal de impressão ESC/POS</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={toggleAgent} className="flex-col items-start gap-1">
          <div className="flex items-center gap-2 w-full">
            <Server className="size-4" />
            <span className="font-medium text-sm flex-1">Agente Local (127.0.0.1)</span>
            <StatusBadge ok={agentEnabled && agent.online} />
          </div>
          <div className="text-[10px] text-muted-foreground pl-6">
            {agent.online ? `Online · v${agent.version ?? "?"} · ${agent.printers?.length ?? 0} impressora(s)` : "Offline · instale o .exe/.msi"}
          </div>
        </DropdownMenuItem>

        <DropdownMenuItem onClick={connectUsb} className="flex-col items-start gap-1" disabled={!isWebUsbSupported()}>
          <div className="flex items-center gap-2 w-full">
            <Usb className="size-4" />
            <span className="font-medium text-sm flex-1">WebUSB direto</span>
            <StatusBadge ok={usbAuthorized} />
          </div>
          <div className="text-[10px] text-muted-foreground pl-6">
            {isWebUsbSupported() ? (usbAuthorized ? "Autorizada" : "Clique para escolher a impressora USB") : usbState.message}
          </div>
        </DropdownMenuItem>

        <DropdownMenuItem onClick={serialEnabled ? disconnectSerial : connectSerial} className="flex-col items-start gap-1" disabled={!isEscPosSupported()}>
          <div className="flex items-center gap-2 w-full">
            <Cable className="size-4" />
            <span className="font-medium text-sm flex-1">Web Serial (USB→Serial / COM)</span>
            <StatusBadge ok={serialEnabled} />
          </div>
          <div className="text-[10px] text-muted-foreground pl-6">
            {isEscPosSupported() ? (serialEnabled ? "Clique para desativar" : "Clique para escolher a porta serial") : serialState.message}
          </div>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[10px] text-muted-foreground leading-relaxed">
          Ordem de tentativa na venda: <strong>Agente → USB → Serial → HTML</strong>.
          Impressão sem tela de diálogo apenas via Agente ou WebUSB.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusBadge({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle2 className="size-4 text-primary" />
    : <XCircle className="size-4 text-muted-foreground/50" />;
}
