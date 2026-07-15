import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getHardwareErrorMessage } from "@/lib/hardware-errors";
import {
  Printer, Usb, Cable, Server, CheckCircle2, XCircle, TestTube2, Ruler, RefreshCw,
  RotateCcw, ExternalLink, Activity, Sparkles, MonitorSmartphone, AlertTriangle,
} from "lucide-react";
import { PrintDiagnosticsDialog } from "./print-diagnostics-dialog";
import { toast } from "sonner";
import {
  isEscPosEnabled, isEscPosSupported, requestEscPosPort, setEscPosEnabled, tryPrintEscPosDetailed,
} from "@/lib/escpos";
import {
  isWebUsbSupported, requestUsbPrinter, getGrantedUsbPrinter, forgetUsbPrinter,
  isUsbAccessDeniedError, resetUsbPrinterConnection,
} from "@/lib/escpos-usb";
import {
  getLastPrintError,
  isPrintAgentEnabled,
  pingPrintAgent,
  setPrintAgentEnabled,
  getSelectedPrinterForStore,
  setSelectedPrinterForStore,
  pickBestPrinter,
  getTerminalLabel,
  PRINT_AGENT_EVENT,
  PRINTER_SELECTION_EVENT,
  type AgentPrinter,
  type AgentStatus,
  type PrinterSource,
  type StoredPrinterSelection,
} from "@/lib/print-agent";
import { getLastReceipt } from "@/lib/print-history";
import { DENSITY_LABELS, getPrintDensity, setPrintDensity, type PrintDensity } from "@/lib/print-density";
import { getBrowserDeviceFeatureState } from "@/lib/browser-device-permissions";
import { useCurrentStore } from "@/lib/current-store";

/**
 * Seletor unificado de impressora do PDV.
 *
 * Une três fontes num único popover, com auto-detecção da Epson TM-T20X e
 * memória de escolha por (loja + terminal):
 *   - Agente Local (spooler do Windows OU USB bruto via libusb)
 *   - WebUSB direta (quando o operador autorizou a impressora no navegador)
 *
 * Status ao vivo: a cada 5s enquanto o popover está aberto, 30s quando
 * fechado — sem gastar rede/CPU à toa.
 */
export function EscPosPrinterButton() {
  const { store, storeId } = useCurrentStore();
  const [serialEnabled, setSerialEnabled] = useState(() => isEscPosEnabled());
  const [usbDev, setUsbDev] = useState<USBDevice | null>(null);
  const [agent, setAgent] = useState<AgentStatus>({ online: false });
  const [agentEnabled, setAgentEnabled] = useState(() => isPrintAgentEnabled());
  const [selection, setSelection] = useState<StoredPrinterSelection | null>(
    () => getSelectedPrinterForStore(storeId),
  );
  const [density, setDensityState] = useState<PrintDensity>(() => getPrintDensity(selection?.name ?? null));
  const [lastErr, setLastErr] = useState<string | null>(() => getLastPrintError());
  const [testing, setTesting] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [usbBlockedOpen, setUsbBlockedOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [terminalLabel] = useState(() => getTerminalLabel());
  const usbState = getBrowserDeviceFeatureState("usb");
  const serialState = getBrowserDeviceFeatureState("serial");

  // Sincroniza seleção salva quando trocar de loja
  useEffect(() => {
    const sel = getSelectedPrinterForStore(storeId);
    setSelection(sel);
    setDensityState(getPrintDensity(sel?.name ?? null));
  }, [storeId]);

  // WebUSB autorizada
  useEffect(() => {
    if (!isWebUsbSupported()) return;
    const refreshUsb = () => getGrantedUsbPrinter().then(setUsbDev).catch(() => setUsbDev(null));
    const usb = navigator.usb;
    const onDisconnect = (event: USBConnectionEvent) => {
      setUsbDev((current) => {
        if (!current) return null;
        const sameDevice = current.vendorId === event.device.vendorId
          && current.productId === event.device.productId
          && (current.serialNumber === event.device.serialNumber || !current.serialNumber || !event.device.serialNumber);
        return sameDevice ? null : current;
      });
    };
    refreshUsb();
    usb.addEventListener("connect", refreshUsb);
    usb.addEventListener("disconnect", onDisconnect);
    return () => {
      usb.removeEventListener("connect", refreshUsb);
      usb.removeEventListener("disconnect", onDisconnect);
    };
  }, []);

  // Polling adaptativo do agente + escuta de eventos globais
  useEffect(() => {
    const check = () => pingPrintAgent().then(setAgent).catch(() => setAgent({ online: false }));
    check();
    const interval = popoverOpen ? 5000 : 30000;
    const t = setInterval(check, interval);
    const onAgent = (e: Event) => setAgent((e as CustomEvent<AgentStatus>).detail);
    const onSel = () => setSelection(getSelectedPrinterForStore(storeId));
    window.addEventListener(PRINT_AGENT_EVENT, onAgent);
    window.addEventListener(PRINTER_SELECTION_EVENT, onSel);
    return () => {
      clearInterval(t);
      window.removeEventListener(PRINT_AGENT_EVENT, onAgent);
      window.removeEventListener(PRINTER_SELECTION_EVENT, onSel);
    };
  }, [popoverOpen, storeId]);

  // Lista mesclada: agente + windows + webusb, dedup por (source|name)
  const printers = useMemo<AgentPrinter[]>(() => {
    const list: AgentPrinter[] = [...(agent.printers ?? [])];
    if (usbDev) {
      list.push({
        name: usbDev.productName ?? `USB ${usbDev.vendorId.toString(16)}:${usbDev.productId.toString(16)}`,
        source: "webusb",
        status: "online",
        statusMessage: "Autorizada no navegador",
        vendorId: usbDev.vendorId,
        productId: usbDev.productId,
      });
    }
    // Dedup: mesmo (source|nameLower) só uma vez
    const seen = new Set<string>();
    return list.filter((p) => {
      const k = `${p.source}|${p.name.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [agent.printers, usbDev]);

  // Auto-detecção: se não há escolha salva mas há impressoras disponíveis,
  // seleciona a melhor (Epson TM-T20X → TM-* → default Windows → primeira).
  useEffect(() => {
    if (selection || printers.length === 0) return;
    const best = pickBestPrinter(printers);
    if (best) {
      const sel = { name: best.name, source: best.source };
      setSelectedPrinterForStore(storeId, sel);
      setSelection(sel);
      toast.success(`Impressora detectada: ${best.name}`, { description: sourceLabel(best.source) });
    }
  }, [printers, selection, storeId]);

  const activePrinter = printers.find(
    (p) => p.name === selection?.name && p.source === selection?.source,
  );

  const pickPrinter = (compositeKey: string) => {
    if (compositeKey === "__auto__") {
      setSelectedPrinterForStore(storeId, null);
      setSelection(null);
      toast.info("Auto-seleção reativada");
      return;
    }
    const [source, ...rest] = compositeKey.split("|");
    const name = rest.join("|");
    const src = source as PrinterSource;
    const sel = { name, source: src };
    setSelectedPrinterForStore(storeId, sel);
    setSelection(sel);
    toast.success(`Impressora fixada: ${name}`, { description: sourceLabel(src) });
  };

  const redetect = async () => {
    const st = await pingPrintAgent();
    setAgent(st);
    const merged = [...(st.printers ?? []), ...(usbDev ? [{
      name: usbDev.productName ?? "USB",
      source: "webusb" as const,
      status: "online" as const,
    }] : [])];
    const best = pickBestPrinter(merged);
    if (best) {
      const sel = { name: best.name, source: best.source };
      setSelectedPrinterForStore(storeId, sel);
      setSelection(sel);
      toast.success(`Redetectada: ${best.name}`, { description: sourceLabel(best.source) });
    } else {
      toast.error("Nenhuma impressora detectada");
    }
  };

  const connectSerial = async () => {
    try { await requestEscPosPort(); setSerialEnabled(true); toast.success("Impressora serial conectada"); }
    catch (e) { toast.error(getHardwareErrorMessage(e, "serial")); }
  };
  const disconnectSerial = () => { setEscPosEnabled(false); setSerialEnabled(false); toast.info("Serial desativada"); };

  const connectUsb = async () => {
    try {
      const d = await requestUsbPrinter(true);
      setUsbDev(d);
      const name = d.productName ?? `USB ${d.vendorId.toString(16)}:${d.productId.toString(16)}`;
      const sel = { name, source: "webusb" as const };
      setSelectedPrinterForStore(storeId, sel);
      setSelection(sel);
      toast.success(`USB autorizada: ${d.productName ?? "impressora"}`);
    } catch (e) {
      if (isUsbAccessDeniedError(e)) setUsbBlockedOpen(true);
      toast.error(getHardwareErrorMessage(e, "usb"));
    }
  };

  const reauthorizeUsb = async () => {
    try {
      await forgetUsbPrinter();
      setUsbDev(null);
      const d = await requestUsbPrinter(true);
      setUsbDev(d);
      toast.success(`USB reautorizada: ${d.productName ?? "impressora"}`);
    } catch (e) {
      if (isUsbAccessDeniedError(e)) setUsbBlockedOpen(true);
      toast.error(getHardwareErrorMessage(e, "usb"));
    }
  };

  const resetUsbConnection = async () => {
    try {
      await resetUsbPrinterConnection();
      setUsbDev(null);
      setLastErr(null);
      const d = await requestUsbPrinter(true);
      setUsbDev(d);
      const name = d.productName ?? `USB ${d.vendorId.toString(16)}:${d.productId.toString(16)}`;
      const sel = { name, source: "webusb" as const };
      setSelectedPrinterForStore(storeId, sel);
      setSelection(sel);
      setUsbBlockedOpen(false);
      toast.success(`Conexão USB resetada: ${name}`);
    } catch (e) {
      if (isUsbAccessDeniedError(e)) setUsbBlockedOpen(true);
      toast.error(getHardwareErrorMessage(e, "usb"));
    }
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

  const changeDensity = (v: PrintDensity) => {
    setPrintDensity(v, selection?.name ?? null);
    setDensityState(v);
    toast.success(`Intensidade ${DENSITY_LABELS[v]}${selection?.name ? ` · ${selection.name}` : ""}`);
  };

  const runTest = async () => {
    setTesting(true);
    try {
      const paper = activePrinter?.paperWidth ?? 80;
      const d = await tryPrintEscPosDetailed({
        store: { name: "TESTE DE IMPRESSAO", cnpj: null, address: null, phone: null },
        header: `Impressora: ${selection?.name ?? "auto"}\nCanal: ${selection?.source ?? "auto"}\nIntensidade: ${DENSITY_LABELS[density]}\nPapel: ${paper}mm`,
        footer: "Se o texto estiver fraco, aumente a intensidade.",
        paper_width: paper as 58 | 80,
        items: [
          { name: "TESTE DE CONTRASTE #####", quantity: 1, unit_price: 0.01, total: 0.01 },
          { name: "abcdefghijklmnopqrstuvwxyz", quantity: 1, unit_price: 0, total: 0 },
        ],
        subtotal: 0.01, discount: 0, total: 0.01, payment_method: "teste",
        received: 0.01, change: 0,
        sale_id: "TESTE" + Date.now().toString(36).slice(-4), document_type: "nao_fiscal", issued_at: new Date(),
      }, true);
      if (d.ok) {
        toast.success(`Teste enviado via ${d.channel.toUpperCase()}${d.printer ? ` · ${d.printer}` : ""}`);
        setLastErr(null);
      } else {
        const msg = d.error ?? "Nenhum canal ESC/POS ativo";
        setLastErr(msg);
        if (isUsbAccessDeniedError(msg)) setUsbBlockedOpen(true);
        toast.error(`Falhou (${d.channel}): ${msg}`);
      }
    } finally { setTesting(false); }
  };

  const reprintLast = async () => {
    const r = getLastReceipt();
    if (!r) { toast.error("Nenhum recibo anterior salvo"); return; }
    const d = await tryPrintEscPosDetailed(r, true);
    if (d.ok) { toast.success(`Reimpresso via ${d.channel.toUpperCase()}`); setLastErr(null); }
    else {
      const msg = d.error ?? "erro";
      if (isUsbAccessDeniedError(msg)) setUsbBlockedOpen(true);
      toast.error(`Falhou (${d.channel}): ${msg}`);
    }
  };

  const anyActive = Boolean(selection) || agentEnabled || usbDev || serialEnabled;
  const compositeValue = selection ? `${selection.source}|${selection.name}` : "__auto__";

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 h-9">
          <Printer className={`size-4 ${anyActive ? "text-primary" : ""}`} />
          <span className="text-xs truncate max-w-[140px]">
            {selection?.name ?? (agentEnabled && agent.online ? "Auto" : "Impressora")}
          </span>
          {activePrinter && <StatusDot status={activePrinter.status} />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="end">
        {/* Cabeçalho: loja + terminal */}
        <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between text-[10px]">
          <div className="flex items-center gap-2 text-muted-foreground">
            <MonitorSmartphone className="size-3" />
            <span>Loja: <strong className="text-foreground">{store?.fantasy_name || store?.name || "—"}</strong></span>
            <span>·</span>
            <span>Terminal: <strong className="text-foreground">PDV-{terminalLabel}</strong></span>
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            {agent.online ? <span className="text-primary">● Agente v{agent.version}</span> : <span>○ Agente offline</span>}
          </div>
        </div>

        {/* Seletor unificado */}
        <div className="p-3 border-b border-border">
          <div className="text-xs font-semibold mb-2 flex items-center justify-between">
            <span>Impressora ativa</span>
            <button
              onClick={redetect}
              className="text-[10px] text-primary hover:underline inline-flex items-center gap-1"
              title="Redetectar e escolher a melhor automaticamente"
            >
              <Sparkles className="size-3" /> Redetectar
            </button>
          </div>
          <Select value={compositeValue} onValueChange={pickPrinter}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue placeholder="Automática" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">
                <span className="inline-flex items-center gap-2">
                  <Sparkles className="size-3" /> Automática (melhor disponível)
                </span>
              </SelectItem>
              {printers.length === 0 && (
                <div className="px-2 py-3 text-[11px] text-muted-foreground">
                  Nenhuma impressora detectada. Ligue o Agente Local ou autorize a WebUSB abaixo.
                </div>
              )}
              {printers.map((p) => (
                <SelectItem key={`${p.source}|${p.name}`} value={`${p.source}|${p.name}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusDot status={p.status} />
                    <span className="truncate flex-1 max-w-[220px]">{p.name}</span>
                    <SourceBadge source={p.source} />
                    {p.paperWidth && <span className="text-[10px] text-muted-foreground">{p.paperWidth}mm</span>}
                    {p.isDefault && <span className="text-[9px] text-primary">DEFAULT</span>}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {activePrinter && (
            <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
              <StatusDot status={activePrinter.status} />
              <span className="text-foreground">{activePrinter.statusMessage ?? statusLabel(activePrinter.status)}</span>
              {activePrinter.model && <><span>·</span><span>{activePrinter.model}</span></>}
              {activePrinter.paperWidth && <><span>·</span><Ruler className="size-3" /> <span>{activePrinter.paperWidth}mm</span></>}
            </div>
          )}
        </div>

        {/* Contraste + teste */}
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

        {/* Fontes de impressão */}
        <div className="p-2 space-y-1">
          <ChannelRow
            icon={<Server className="size-4" />}
            title="Agente Local (127.0.0.1)"
            subtitle={agent.online ? `Online · v${agent.version ?? "?"} · ${agent.printers?.length ?? 0} impressora(s)` : "Offline · instale o .exe/.msi"}
            ok={agentEnabled && agent.online}
            onClick={toggleAgent}
          />
          <ChannelRow
            icon={<Usb className="size-4" />}
            title="WebUSB direto"
            subtitle={isWebUsbSupported() ? (usbDev ? `Autorizada: ${usbDev.productName ?? "impressora"}` : "Clique para autorizar") : usbState.message}
            ok={Boolean(usbDev)}
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

        {lastErr && (
          <PrintErrorPanel
            message={lastErr}
            onClear={() => setLastErr(null)}
            onReauthUsb={reauthorizeUsb}
            onResetUsb={resetUsbConnection}
            onRefreshAgent={refreshAgent}
            onReprint={reprintLast}
          />
        )}

        <div className="px-3 py-2 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
          <button onClick={() => setDiagOpen(true)} className="flex items-center gap-1 hover:text-foreground">
            <Activity className="size-3" /> Diagnóstico
          </button>
          <button onClick={refreshAgent} className="flex items-center gap-1 hover:text-foreground">
            <RefreshCw className="size-3" /> Atualizar
          </button>
        </div>
      </PopoverContent>
      <PrintDiagnosticsDialog open={diagOpen} onOpenChange={setDiagOpen} printerName={selection?.name ?? null} />
      <UsbBlockedDialog
        open={usbBlockedOpen}
        onOpenChange={setUsbBlockedOpen}
        onResetUsb={resetUsbConnection}
        onRefreshAgent={refreshAgent}
      />
    </Popover>
  );
}

function StatusDot({ status }: { status: AgentPrinter["status"] }) {
  const color =
    status === "online" ? "bg-primary" :
    status === "error"  ? "bg-destructive" :
                          "bg-muted-foreground/50";
  return <span className={`inline-block size-2 rounded-full ${color}`} aria-label={status} />;
}

function SourceBadge({ source }: { source: PrinterSource }) {
  const label =
    source === "windows" ? "Windows" :
    source === "agent"   ? "USB" :
                           "WebUSB";
  return <Badge variant="secondary" className="h-4 px-1.5 text-[9px] font-normal">{label}</Badge>;
}

function sourceLabel(s: PrinterSource): string {
  return s === "windows" ? "Spooler do Windows" : s === "agent" ? "USB via Agente Local" : "WebUSB direto";
}

function statusLabel(s: AgentPrinter["status"]): string {
  return s === "online" ? "Online" : s === "error" ? "Com erro" : "Offline";
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

function PrintErrorPanel({ message, onClear, onReauthUsb, onResetUsb, onRefreshAgent, onReprint }: {
  message: string;
  onClear: () => void;
  onReauthUsb: () => void;
  onResetUsb: () => void;
  onRefreshAgent: () => void;
  onReprint: () => void;
}) {
  const isLibusbBlocked = /libusb_error_not_supported|libusb_error_access|not_supported/i.test(message);
  const isAccessDenied = /access denied|acesso negado/i.test(message) || isLibusbBlocked;
  const isAgentDown = /failed to fetch|127\.0\.0\.1/i.test(message) && !isLibusbBlocked;

  return (
    <div className="p-3 border-t border-border bg-destructive/10 space-y-2">
      <div className="flex items-start gap-2 text-[11px] text-destructive">
        <XCircle className="size-3 mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="font-semibold mb-0.5">Último erro de impressão</div>
          <div className="opacity-90 break-words">{message}</div>
        </div>
      </div>

      {isAccessDenied && (
        <div className="text-[10px] text-foreground/80 bg-background/50 rounded p-2 leading-relaxed">
          Driver do Windows travou o acesso USB bruto. Escolha uma impressora com badge{" "}
          <SourceBadge source="windows" /> no seletor acima — ela imprime pelo driver oficial, sem WinUSB.
        </div>
      )}

      {isAgentDown && !isAccessDenied && (
        <div className="text-[10px] text-foreground/80 bg-background/50 rounded p-2 leading-relaxed">
          O Agente Local não respondeu em <code>127.0.0.1:9100</code>. Verifique se o executável está rodando (bandeja do sistema) e clique em <strong>Atualizar</strong>.
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="default" className="h-7 gap-1 text-[10px]" onClick={onReprint}>
          <RefreshCw className="size-3" /> Reimprimir última
        </Button>
        {isAccessDenied && (
          <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]" onClick={onRefreshAgent}>
            <Server className="size-3" /> Tentar Agente Local
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]" onClick={onReauthUsb}>
          <RotateCcw className="size-3" /> Reautorizar USB
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]" onClick={onResetUsb}>
          <Usb className="size-3" /> Resetar conexão
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

function UsbBlockedDialog({ open, onOpenChange, onResetUsb, onRefreshAgent }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResetUsb: () => void;
  onRefreshAgent: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-destructive" /> Acesso WebUSB bloqueado
          </DialogTitle>
          <DialogDescription>
            A impressora está sendo usada pelo driver/spooler do sistema ou por outra sessão. O PDV tenta usar o Agente Local/Windows como fallback automático; para WebUSB direto, o navegador precisa de acesso exclusivo.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm text-foreground">
          <p>Para liberar o WebUSB, remova a impressora dos dispositivos do Windows/Linux ou instale o driver WinUSB via Zadig.</p>
          <p className="text-muted-foreground">Se ela estiver instalada como impressora normal no Windows, prefira o item com badge Windows no seletor: ele imprime pelo Agente Local sem trocar driver.</p>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onRefreshAgent} className="gap-2">
            <Server className="size-4" /> Tentar Agente/Windows
          </Button>
          <Button onClick={onResetUsb} className="gap-2">
            <RotateCcw className="size-4" /> Resetar conexão de impressora
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
