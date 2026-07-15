// ESC/POS raw printing via Web Serial API.
// Fallback: quando não suportado, o chamador deve imprimir o HTML térmico.
// Perfis 58mm (32 col) e 80mm (48 col).
import { buildDensityPrefix } from "./print-density";

import type { ReceiptData } from "./receipt";
import {
  describeBrowserDeviceError,
  getBrowserDeviceFeatureState,
} from "./browser-device-permissions";

const STORAGE_FLAG = "escpos.enabled";

type SerialLike = {
  requestPort: (opts?: { filters?: Array<{ usbVendorId?: number; usbProductId?: number }> }) => Promise<SerialPortLike>;
  getPorts: () => Promise<SerialPortLike[]>;
};
type SerialPortLike = {
  open: (opts: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  writable: WritableStream<Uint8Array> | null;
};

function getSerial(): SerialLike | null {
  const nav = (typeof navigator !== "undefined" ? navigator : null) as (Navigator & { serial?: SerialLike }) | null;
  return nav?.serial ?? null;
}

export function isEscPosSupported(): boolean {
  return getBrowserDeviceFeatureState("serial").available;
}

export function isEscPosEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(STORAGE_FLAG) === "1";
}

export function setEscPosEnabled(v: boolean) {
  if (typeof localStorage === "undefined") return;
  if (v) localStorage.setItem(STORAGE_FLAG, "1");
  else localStorage.removeItem(STORAGE_FLAG);
}

/** Solicita porta ao usuário (gesto explícito obrigatório) e persiste a permissão. */
export async function requestEscPosPort(): Promise<boolean> {
  const s = getSerial();
  if (!s) throw new Error("Web Serial não suportado neste navegador (use Chrome/Edge desktop).");
  const state = getBrowserDeviceFeatureState("serial");
  if (!state.available) throw new Error(state.message);
  let port: SerialPortLike;
  try {
    port = await s.requestPort();
  } catch (error) {
    throw new Error(describeBrowserDeviceError(error, "serial"));
  }
  // apenas testar abertura rápida para validar
  await port.open({ baudRate: 9600 });
  await port.close();
  setEscPosEnabled(true);
  return true;
}

async function getGrantedPort(): Promise<SerialPortLike | null> {
  const s = getSerial();
  if (!s) return null;
  if (!getBrowserDeviceFeatureState("serial").available) return null;
  try {
    const ports = await s.getPorts();
    return ports[0] ?? null;
  } catch (error) {
    if (error instanceof Error) console.warn("[escpos] serial indisponível:", describeBrowserDeviceError(error, "serial"));
    return null;
  }
}

// ESC/POS opcodes
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

function bytes(...arr: (number | Uint8Array)[]): Uint8Array {
  const parts: Uint8Array[] = arr.map((a) => (typeof a === "number" ? new Uint8Array([a]) : a));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

import { encodeForCodepage, getCodepageCommand, type Codepage } from "./escpos-codepage";

function encWith(text: string, cp: Codepage): Uint8Array {
  return encodeForCodepage(text, cp);
}


function line(cols: number, left: string, right: string): string {
  const l = left.slice(0, cols - 1);
  const r = right.slice(0, cols - l.length);
  const pad = Math.max(1, cols - l.length - r.length);
  return l + " ".repeat(pad) + r;
}

function center(cols: number, s: string): string {
  const t = s.slice(0, cols);
  const pad = Math.max(0, Math.floor((cols - t.length) / 2));
  return " ".repeat(pad) + t;
}

function sep(cols: number): string { return "-".repeat(cols); }

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

import { defaultTemplate, loadTemplate, type ReceiptBlock, type ReceiptTemplate } from "./receipt-template";
import { getCurrentStoreIdSync } from "./current-store";

// Mapeamento alinhamento → ESC/POS ESC a n (0 esquerda, 1 centro, 2 direita)
const ALIGN_CMD = { left: 0x00, center: 0x01, right: 0x02 } as const;

// GS ! n — tamanho: bit 0-3 width mult, bit 4-7 height mult.
// sm=normal, md=normal, lg=double-height (0x01) para não estourar largura.
const SIZE_CMD: Record<"sm" | "md" | "lg", number> = { sm: 0x00, md: 0x00, lg: 0x01 };

function fakeChave(saleId: string): string {
  const hex = saleId.replace(/[^0-9a-f]/gi, "");
  let d = "";
  for (const c of hex) d += (parseInt(c, 16) % 10).toString();
  while (d.length < 44) d += "0";
  return d.slice(0, 44);
}

function renderBlockEscPos(
  b: ReceiptBlock,
  r: ReceiptData,
  cols: number,
  enc: (s: string) => Uint8Array,
): Uint8Array[] {
  if (!b.enabled) return [];
  const out: Uint8Array[] = [];
  const isFiscal = r.document_type === "fiscal";

  // Alinhamento e tamanho antes de imprimir
  out.push(bytes(ESC, 0x61, ALIGN_CMD[b.align]));
  out.push(bytes(GS, 0x21, SIZE_CMD[b.size]));
  if (b.bold) out.push(bytes(ESC, 0x45, 0x01));

  const push = (s: string) => out.push(enc(s + "\n"));
  const pushRaw = (s: string) => out.push(enc(s));

  switch (b.kind) {
    case "separator":
      out.push(bytes(ESC, 0x61, 0x00));
      pushRaw(sep(cols) + "\n");
      break;

    case "store_badge":
      out.push(bytes(ESC, 0x21, 0x30)); // double W+H
      push(`[ ${isFiscal ? "NFC-e" : "RECIBO"} ]`);
      out.push(bytes(ESC, 0x21, 0x00));
      break;

    case "store_info":
      out.push(bytes(ESC, 0x45, 0x01));
      push(r.store.name);
      out.push(bytes(ESC, 0x45, 0x00));
      if (r.store.cnpj) push(`CNPJ ${r.store.cnpj}`);
      if (r.store.address) push(r.store.address);
      if (r.store.phone) push(r.store.phone);
      break;

    case "header_msg": {
      const t = b.text ?? r.header ?? "";
      if (t) for (const ln of t.split("\n")) push(ln);
      break;
    }

    case "doc_title":
      push(isFiscal
        ? "DANFE NFC-e - Documento Auxiliar da NF-e"
        : "RECIBO DE VENDA - DOCUMENTO NAO FISCAL");
      push(isFiscal
        ? "Nao permite credito de ICMS"
        : "Nao substitui nota fiscal");
      break;

    case "sale_meta":
      push(`Venda: ${r.sale_id.slice(0, 8).toUpperCase()} - ${r.issued_at.toLocaleString("pt-BR")}`);
      if (r.operator) push(`Op: ${r.operator}`);
      break;

    case "customer":
      if (r.customer?.name || r.customer?.doc) {
        push(`Cli: ${r.customer?.name ?? ""}${r.customer?.doc ? " " + r.customer.doc : ""}`);
      }
      break;

    case "items":
      out.push(bytes(ESC, 0x61, 0x00)); // itens sempre à esquerda
      for (const it of r.items) {
        push(it.name.slice(0, cols));
        const qty = it.quantity.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
        push(line(cols, `  ${qty} x ${brl(it.unit_price)}`, brl(it.total)));
      }
      break;

    case "totals": {
      out.push(bytes(ESC, 0x61, 0x00));
      const itemsCount = r.items.reduce((s, it) => s + it.quantity, 0);
      push(line(cols, "QTD ITENS", itemsCount.toLocaleString("pt-BR", { maximumFractionDigits: 3 })));
      push(line(cols, "SUBTOTAL", brl(r.subtotal)));
      if (r.discount > 0) push(line(cols, "DESCONTO", "-" + brl(r.discount)));
      out.push(bytes(ESC, 0x21, 0x10)); // double height
      push(line(cols, "TOTAL", brl(r.total)));
      out.push(bytes(ESC, 0x21, 0x00));
      break;
    }

    case "payments":
      out.push(bytes(ESC, 0x61, 0x00));
      if (r.payments && r.payments.length > 0) {
        push("PAGAMENTOS");
        for (const p of r.payments) {
          push(line(cols, p.label.toUpperCase(), brl(p.amount)));
          if (p.installments && p.installments > 1) {
            push(line(cols, `  ${p.installments}x de ${brl(p.amount / p.installments)}`, ""));
          }
        }
        push(line(cols, "RECEBIDO", brl(r.received ?? r.total)));
      } else {
        push(line(cols, r.payment_method.toUpperCase(), brl(r.received ?? r.total)));
      }
      if (r.change && r.change > 0) push(line(cols, "TROCO", brl(r.change)));
      break;

    case "tributes":
      if (!isFiscal) break;
      push("Tributos (Lei 12.741/2012): R$ 0,00");
      break;

    case "nfce_info":
      if (!isFiscal) break;
      push(`NFC-e nº ${r.sale_id.slice(0, 9).toUpperCase()} - Serie 001`);
      push(`Emissao ${r.issued_at.toLocaleDateString("pt-BR")}`);
      break;

    case "consumer_via":
      if (!isFiscal) break;
      push("Via Consumidor");
      break;

    case "sefaz_link":
      if (!isFiscal) break;
      push("Consulta: www.nfce.sefaz.uf.gov.br");
      break;

    case "qr": {
      if (!isFiscal) break;
      // Placeholder QR — quando emissao real estiver ativa, substituir por
      // GS ( k … com a URL retornada pela SEFAZ.
      const url = `https://www.nfce.sefaz.uf.gov.br/?chNFe=${fakeChave(r.sale_id)}`;
      const data = new TextEncoder().encode(url);
      const storeLen = data.length + 3;
      out.push(bytes(GS, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00)); // model 2
      out.push(bytes(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x06));       // module size
      out.push(bytes(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x30));       // ec level L
      out.push(bytes(GS, 0x28, 0x6B, storeLen & 0xFF, (storeLen >> 8) & 0xFF, 0x31, 0x50, 0x30, ...Array.from(data)));
      out.push(bytes(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30));       // print
      break;
    }

    case "chave": {
      if (!isFiscal) break;
      const chave = fakeChave(r.sale_id);
      push(chave.match(/.{1,4}/g)?.join(" ") ?? chave);
      push("!! Aguardando autorizacao SEFAZ");
      break;
    }

    case "footer_msg": {
      const t = b.text ?? r.footer ?? "";
      if (t) for (const ln of t.split("\n")) push(ln);
      break;
    }

    case "brand":
      push("Bastion POS");
      break;

    case "custom_text": {
      const t = b.text ?? "";
      if (t) for (const ln of t.split("\n")) push(ln);
      break;
    }
  }

  // Reset negrito
  if (b.bold) out.push(bytes(ESC, 0x45, 0x00));
  out.push(bytes(GS, 0x21, 0x00));
  return out;
}

export function buildEscPosPayload(
  r: ReceiptData,
  opts?: { printerId?: string | null; template?: ReceiptTemplate },
): Uint8Array {
  const cols = r.paper_width === 58 ? 32 : 48;
  const codepage: Codepage = getPrinterCodepage(opts?.printerId ?? null) ?? "cp850";
  const enc = (s: string) => encWith(s, codepage);
  const chunks: Uint8Array[] = [];
  chunks.push(bytes(ESC, 0x40));                          // init
  chunks.push(buildDensityPrefix(undefined, opts?.printerId ?? null));
  chunks.push(getCodepageCommand(codepage));

  let template: ReceiptTemplate;
  try { template = opts?.template ?? loadTemplate(getCurrentStoreIdSync(), r.document_type); }
  catch { template = defaultTemplate(r.document_type); }

  for (const b of template.blocks) {
    for (const c of renderBlockEscPos(b, r, cols, enc)) chunks.push(c);
  }

  chunks.push(bytes(ESC, 0x61, 0x00));
  chunks.push(bytes(LF, LF, LF, LF));
  chunks.push(bytes(GS, 0x56, 0x42, 0x00));                // full cut
  return bytes(...chunks);
}

import { getGrantedUsbPrinter, isUsbDisconnectedError, isWebUsbSupported, printUsbRaw, requestUsbPrinter } from "./escpos-usb";
import {
  getSelectedPrinterForStore,
  pingPrintAgent,
  printViaAgent,
  setLastPrintError,
} from "./print-agent";
import { getCurrentStoreIdSync } from "./current-store";
import { appendPrintHistory, setLastReceipt } from "./print-history";
import { getPrinterCodepage, getPrinterPaperWidth } from "./printer-config";
import type { AgentStatus } from "./print-agent";

export interface PrintDiagnostic {
  channel: "agent" | "usb" | "serial" | "none";
  ok: boolean;
  printer?: string;
  paperWidth?: 58 | 80;
  error?: string;
}

/**
 * Tenta imprimir SEM diálogo do navegador, na ordem:
 *   1. WebUSB direta (PWA/navegador)
 *   2. Web Serial (fallback histórico)
 *   3. Agente Local/Windows (última opção)
 *
 * Retorna diagnóstico completo do canal escolhido e erros de cada tentativa.
 */
export async function tryPrintEscPosDetailed(
  r: ReceiptData,
  interactiveFallback = false,
): Promise<PrintDiagnostic> {
  const storeId = getCurrentStoreIdSync();
  const selection = getSelectedPrinterForStore(storeId);
  const selected = selection?.name ?? null;
  const selectedSource = selection?.source ?? null;
  // Guarda o último recibo para permitir reimpressão após falha.
  try { setLastReceipt(r); } catch { /* noop */ }

  const record = (d: PrintDiagnostic) => {
    appendPrintHistory({
      ts: Date.now(),
      channel: d.channel,
      ok: d.ok,
      printer: d.printer,
      paperWidth: d.paperWidth,
      saleId: r.sale_id,
      error: d.error,
    });
    return d;
  };

  // Preferência de nome/densidade por impressora WebUSB (usa o nome salvo pelo
  // seletor quando existir; assim as configs de densidade/papel batem com a UI).
  const usbPrinterId = selectedSource === "webusb" && selected ? selected : "__usb__";
  const usbPaper = getPrinterPaperWidth(usbPrinterId) ?? getPrinterPaperWidth("__usb__") ?? r.paper_width;
  const usbPayload = buildEscPosPayload({ ...r, paper_width: usbPaper }, { printerId: usbPrinterId });
  const failedAttempts: string[] = [];

  const tryWebUsb = async (allowPrompt: boolean): Promise<PrintDiagnostic | null> => {
    if (!isWebUsbSupported()) return null;
    try {
      let dev = await getGrantedUsbPrinter();
      if (!dev && allowPrompt) {
        try { dev = await requestUsbPrinter(true); }
        catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failedAttempts.push(`WebUSB autorização: ${msg}`);
          setLastPrintError(msg);
          console.warn("[escpos] usuário não autorizou USB:", e);
        }
      }
      if (!dev) return null;
      try {
        await printUsbRaw(dev, usbPayload);
        return record({ channel: "usb", ok: true, printer: dev.productName ?? "USB", paperWidth: usbPaper });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failedAttempts.push(`WebUSB: ${msg}`);
        setLastPrintError(msg);
        if (allowPrompt && isUsbDisconnectedError(err)) {
          try {
            const freshDev = await requestUsbPrinter(true);
            await printUsbRaw(freshDev, usbPayload);
            return record({ channel: "usb", ok: true, printer: freshDev.productName ?? "USB", paperWidth: usbPaper });
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            failedAttempts.push(`WebUSB reautorização: ${retryMsg}`);
            setLastPrintError(retryMsg);
          }
        }
        return record({ channel: "usb", ok: false, printer: dev.productName ?? "USB", paperWidth: usbPaper, error: msg });
      }
    } catch (err) { console.warn("[escpos] webusb falhou:", err); return null; }
  };

  const trySerial = async (): Promise<PrintDiagnostic | null> => {
    if (!isEscPosEnabled()) return null;
    const port = await getGrantedPort();
    if (!port) {
      failedAttempts.push("Serial: porta não autorizada");
      return null;
    }
    try {
      await port.open({ baudRate: 9600 });
      const writer = port.writable?.getWriter();
      if (!writer) {
        await port.close();
        failedAttempts.push("Serial: sem writer serial");
        return record({ channel: "serial", ok: false, error: "Sem writer serial" });
      }
      await writer.write(usbPayload);
      await writer.close();
      await port.close();
      return record({ channel: "serial", ok: true, paperWidth: r.paper_width });
    } catch (err) {
      console.warn("[escpos] serial falhou:", err);
      try { await port.close(); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      failedAttempts.push(`Serial: ${msg}`);
      setLastPrintError(msg);
      return record({ channel: "serial", ok: false, error: msg });
    }
  };

  // Prioridade corrigida: WebUSB é canal principal no PWA/navegador. O agente
  // local fica como última opção para preservar o comportamento antigo direto.
  const usb = await tryWebUsb(interactiveFallback || selectedSource === "webusb");
  if (usb?.ok) return usb;

  const serial = await trySerial();
  if (serial?.ok) return serial;

  // Se houve falha real no WebUSB/Serial, ainda tenta agente como último
  // fallback, mas só retorna erro depois de esgotar todos os canais.

  const tryAgent = async (): Promise<PrintDiagnostic | null> => {
    try {
      const st: AgentStatus = await pingPrintAgent();
      if (st.online && (st.printers?.length ?? 0) > 0) {
        const printers = st.printers!;
        let target: typeof printers[number] | undefined;
        if (selected && selectedSource !== "webusb") {
          target = printers.find((p) => p.name === selected && (!selectedSource || p.source === selectedSource))
                ?? printers.find((p) => p.name === selected);
        }
        if (!target) target = printers.find((p) => p.source === "windows") ?? printers[0];
        if (!target) return null;
        const effectivePaper = getPrinterPaperWidth(target.name) ?? target.paperWidth ?? r.paper_width;
        const payload = buildEscPosPayload({ ...r, paper_width: effectivePaper }, { printerId: target.name });
        try {
          await printViaAgent(payload, target.name, target.source);
          return record({ channel: "agent", ok: true, printer: target.name, paperWidth: effectivePaper });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn("[escpos] agente falhou, tentando fallback Windows:", msg);
          failedAttempts.push(`Agente (${target.source}/${target.name}): ${msg}`);
          record({ channel: "agent", ok: false, printer: target.name, paperWidth: effectivePaper, error: msg });

          const windowsFallback = printers.find((p) => p.source === "windows" && p.name !== target.name)
            ?? printers.find((p) => p.source === "windows");
          if (windowsFallback) {
            const fallbackPaper = getPrinterPaperWidth(windowsFallback.name) ?? windowsFallback.paperWidth ?? effectivePaper;
            const fallbackPayload = buildEscPosPayload({ ...r, paper_width: fallbackPaper }, { printerId: windowsFallback.name });
            try {
              await printViaAgent(fallbackPayload, windowsFallback.name, "windows");
              return record({ channel: "agent", ok: true, printer: windowsFallback.name, paperWidth: fallbackPaper });
            } catch (fallbackErr) {
              const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
              failedAttempts.push(`Windows (${windowsFallback.name}): ${fallbackMsg}`);
              console.warn("[escpos] fallback Windows falhou:", fallbackMsg);
            }
          }
        }
      }
    } catch (err) { console.warn("[escpos] agente indisponível:", err); }
    return null;
  };

  const agentResult = await tryAgent();
  if (agentResult?.ok) return agentResult;

  const err = failedAttempts.length > 0
    ? failedAttempts.join(" | ")
    : "Nenhum canal ESC/POS conectado (autorize WebUSB, Web Serial ou instale o Agente Local)";
  return record({ channel: "none", ok: false, error: err });

}

/**
 * Envia bytes brutos ESC/POS (sem envelope de recibo) para o canal ativo.
 * Usado por rotinas de manutenção como a calibração de largura.
 */
export async function sendRawEscPos(bytes: Uint8Array): Promise<PrintDiagnostic> {
  const selection = getSelectedPrinterForStore(getCurrentStoreIdSync());
  const selected = selection?.name ?? null;
  const selectedSource = selection?.source ?? null;
  const failedAttempts: string[] = [];

  const tryWebUsbRaw = async (): Promise<PrintDiagnostic | null> => {
    if (!isWebUsbSupported()) return null;
    const dev = await getGrantedUsbPrinter();
    if (!dev) return null;
    try {
      await printUsbRaw(dev, bytes);
      return { channel: "usb", ok: true, printer: dev.productName ?? "USB" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failedAttempts.push(`WebUSB: ${msg}`);
      setLastPrintError(msg);
      return null;
    }
  };

  const trySerialRaw = async (): Promise<PrintDiagnostic | null> => {
    if (!isEscPosEnabled()) return null;
    const port = await getGrantedPort();
    if (!port) return null;
    try {
      await port.open({ baudRate: 9600 });
      const writer = port.writable?.getWriter();
      if (!writer) {
        await port.close();
        failedAttempts.push("Serial: sem writer serial");
        return null;
      }
      await writer.write(bytes);
      await writer.close();
      await port.close();
      return { channel: "serial", ok: true };
    } catch (err) {
      try { await port.close(); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      failedAttempts.push(`Serial: ${msg}`);
      setLastPrintError(msg);
      return null;
    }
  };

  const tryAgentRaw = async (): Promise<PrintDiagnostic | null> => {
    try {
      const st = await pingPrintAgent();
      if (st.online && (st.printers?.length ?? 0) > 0) {
        const printers = st.printers!;
        const target = (selected && selectedSource !== "webusb" && printers.find((p) => p.name === selected && (!selectedSource || p.source === selectedSource)))
          || (selected && printers.find((p) => p.name === selected))
          || printers.find((p) => p.source === "windows")
          || printers[0];
        if (!target) return null;
        try {
          await printViaAgent(bytes, target.name, target.source);
          return { channel: "agent", ok: true, printer: target.name };
        } catch (err) {
          console.warn("[escpos] agente falhou, tentando fallback:", err);
          const msg = err instanceof Error ? err.message : String(err);
          failedAttempts.push(`Agente (${target.source}/${target.name}): ${msg}`);
        }
      }
    } catch { /* segue */ }
    return null;
  };

  const usbResult = await tryWebUsbRaw();
  if (usbResult) return usbResult;

  const serialResult = await trySerialRaw();
  if (serialResult) return serialResult;

  const agentResult = await tryAgentRaw();
  if (agentResult) return agentResult;

  return { channel: "none", ok: false, error: failedAttempts.join(" | ") || "Nenhum canal ativo" };
}

/** Wrapper retro-compatível: retorna apenas boolean. */
export async function tryPrintEscPos(r: ReceiptData, interactiveFallback = false): Promise<boolean> {
  const d = await tryPrintEscPosDetailed(r, interactiveFallback);
  return d.ok;
}
