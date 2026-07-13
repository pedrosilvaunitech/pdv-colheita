// ESC/POS raw printing via Web Serial API.
// Fallback: quando não suportado, o chamador deve imprimir o HTML térmico.
// Perfis 58mm (32 col) e 80mm (48 col).
import { getHardwareErrorMessage } from "./hardware-errors";
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

function enc(text: string): Uint8Array {
  // CP860/CP850 seriam ideais para PT; fallback ASCII-safe removendo diacríticos.
  const ascii = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return new TextEncoder().encode(ascii);
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

export function buildEscPosPayload(r: ReceiptData): Uint8Array {
  const cols = r.paper_width === 58 ? 32 : 48;
  const chunks: Uint8Array[] = [];
  chunks.push(bytes(ESC, 0x40));                          // init
  chunks.push(bytes(ESC, 0x74, 0x02));                    // charset CP850
  chunks.push(bytes(ESC, 0x61, 0x01));                    // center
  chunks.push(bytes(ESC, 0x21, 0x08));                    // emphasized
  chunks.push(enc(r.store.name + "\n"));
  chunks.push(bytes(ESC, 0x21, 0x00));                    // normal
  if (r.store.cnpj)    chunks.push(enc(`CNPJ ${r.store.cnpj}\n`));
  if (r.store.address) chunks.push(enc(r.store.address + "\n"));
  if (r.store.phone)   chunks.push(enc(r.store.phone + "\n"));
  if (r.header)        chunks.push(enc(r.header + "\n"));
  chunks.push(enc(`[ ${r.document_type === "fiscal" ? "CUPOM FISCAL (NFC-e)" : "DOCUMENTO NAO FISCAL"} ]\n`));
  if (r.document_type !== "fiscal") chunks.push(enc("nao substitui nota fiscal\n"));
  chunks.push(bytes(ESC, 0x61, 0x00));                    // left
  chunks.push(enc(sep(cols) + "\n"));
  chunks.push(enc(`Venda: ${r.sale_id.slice(0, 8).toUpperCase()}\n`));
  chunks.push(enc(`Data:  ${r.issued_at.toLocaleString("pt-BR")}\n`));
  if (r.operator) chunks.push(enc(`Op:    ${r.operator}\n`));
  if (r.customer?.name || r.customer?.doc) {
    chunks.push(enc(`Cli:   ${r.customer?.name ?? ""}${r.customer?.doc ? " " + r.customer.doc : ""}\n`));
  }
  chunks.push(enc(sep(cols) + "\n"));
  for (const it of r.items) {
    chunks.push(enc(it.name.slice(0, cols) + "\n"));
    const qty = it.quantity.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
    chunks.push(enc(line(cols, `  ${qty} x ${brl(it.unit_price)}`, brl(it.total)) + "\n"));
  }
  chunks.push(enc(sep(cols) + "\n"));
  chunks.push(enc(line(cols, "SUBTOTAL", brl(r.subtotal)) + "\n"));
  if (r.discount > 0) chunks.push(enc(line(cols, "DESCONTO", "-" + brl(r.discount)) + "\n"));
  chunks.push(bytes(ESC, 0x21, 0x08));
  chunks.push(enc(line(cols, "TOTAL", brl(r.total)) + "\n"));
  chunks.push(bytes(ESC, 0x21, 0x00));
  if (r.payments && r.payments.length > 0) {
    chunks.push(enc("PAGAMENTOS\n"));
    for (const p of r.payments) {
      chunks.push(enc(line(cols, p.label.toUpperCase(), brl(p.amount)) + "\n"));
      if (p.installments && p.installments > 1) {
        chunks.push(enc(line(cols, `  ${p.installments}x de ${brl(p.amount / p.installments)}`, "") + "\n"));
      }
    }
    chunks.push(enc(line(cols, "RECEBIDO", brl(r.received ?? r.total)) + "\n"));
  } else {
    chunks.push(enc(line(cols, r.payment_method.toUpperCase(), brl(r.received ?? r.total)) + "\n"));
  }
  if (r.change && r.change > 0) chunks.push(enc(line(cols, "TROCO", brl(r.change)) + "\n"));
  chunks.push(enc(sep(cols) + "\n"));
  chunks.push(bytes(ESC, 0x61, 0x01));
  chunks.push(enc((r.footer || "Obrigado pela preferencia!") + "\n"));
  chunks.push(enc("Bastion POS\n"));
  chunks.push(bytes(LF, LF, LF, LF));
  chunks.push(bytes(GS, 0x56, 0x42, 0x00));                // full cut
  return bytes(...chunks);
}

import { getGrantedUsbPrinter, isWebUsbSupported, printUsbRaw } from "./escpos-usb";
import { isPrintAgentEnabled, pingPrintAgent, printViaAgent } from "./print-agent";

/**
 * Tenta imprimir usando (nesta ordem, para máxima compatibilidade):
 *   1. Agente de Impressão Local (executável .exe/.msi/.pkg em 127.0.0.1:9100)
 *   2. WebUSB (impressora USB direta — melhor em Linux/macOS)
 *   3. Web Serial (impressora serial ou USB-to-Serial)
 * Retorna `false` se nenhum caminho funcionou — o chamador imprime HTML.
 */
export async function tryPrintEscPos(r: ReceiptData): Promise<boolean> {
  const payload = buildEscPosPayload(r);

  // 1) Agente local
  if (isPrintAgentEnabled()) {
    try {
      const st = await pingPrintAgent();
      if (st.online) {
        await printViaAgent(payload);
        return true;
      }
    } catch (err) { console.warn("[escpos] agente falhou:", err); }
  }

  // 2) WebUSB direto
  if (isWebUsbSupported()) {
    try {
      const dev = await getGrantedUsbPrinter();
      if (dev) { await printUsbRaw(dev, payload); return true; }
    } catch (err) { console.warn("[escpos] webusb falhou:", err); }
  }

  // 3) Web Serial (fallback histórico)
  if (!isEscPosEnabled()) return false;
  const port = await getGrantedPort();
  if (!port) return false;
  try {
    await port.open({ baudRate: 9600 });
    const writer = port.writable?.getWriter();
    if (!writer) { await port.close(); return false; }
    await writer.write(payload);
    await writer.close();
    await port.close();
    return true;
  } catch (err) {
    console.warn("[escpos] serial falhou:", err);
    try { await port.close(); } catch { /* ignore */ }
    return false;
  }
}
