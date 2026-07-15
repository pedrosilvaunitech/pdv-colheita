/// <reference types="w3c-web-usb" />
import {
  describeBrowserDeviceError,
  getBrowserDeviceFeatureState,
} from "./browser-device-permissions";

/**
 * Impressão ESC/POS direta via WebUSB (Chrome/Edge desktop e Android).
 *
 * Diferente da API Web Serial (que exige uma porta COM/serial ou adaptador
 * USB→Serial), a WebUSB fala diretamente com a interface USB da impressora.
 * Funciona sem drivers extras em macOS e Linux. Em Windows, se o SO já
 * instalou o driver de impressora nativo, a interface fica "reservada" e o
 * navegador não consegue abri-la — nesse cenário use o **Agente de Impressão
 * Local** (executável .exe fornecido) ou instale o driver genérico WinUSB
 * via Zadig (ver documentação em `desktop/README.md`).
 *
 * Fabricantes suportados por filtro (vendorId):
 *  - 0x04b8  Epson (TM-T20, TM-T88, TM-U220 etc.)
 *  - 0x0fe6  ICS Advent / diversos Bematech OEM
 *  - 0x0dd4  Custom Engineering
 *  - 0x0416  Winbond / diversos genéricos (Elgin i7/i8/i9)
 *  - 0x1504  Bixolon
 *  - 0x0519  Star Micronics
 *  - 0x1fc9  NXP / Daruma DR700/DR800
 *  - 0x0483  STMicro / Sunmi
 *  - 0x28e9  GD32 (Xprinter XP-58, XP-80)
 *  - 0x154f  Citizen
 */

const VENDOR_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x04b8 },
  { vendorId: 0x0fe6 },
  { vendorId: 0x0dd4 },
  { vendorId: 0x0416 },
  { vendorId: 0x1504 },
  { vendorId: 0x0519 },
  { vendorId: 0x1fc9 },
  { vendorId: 0x0483 },
  { vendorId: 0x28e9 },
  { vendorId: 0x154f },
  // fallback: qualquer dispositivo classe 7 (Printer). Mantido no request()
  // apenas quando o usuário escolher "outra marca".
];

export function isWebUsbSupported(): boolean {
  return getBrowserDeviceFeatureState("usb").available;
}

export function isUsbAccessDeniedError(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /access denied|acesso negado|permission denied|libusb_error_access|libusb_error_not_supported|not_supported/i.test(msg);
}

export function isUsbDisconnectedError(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /device was disconnected|dispositivo foi desconectado|disconnected|desconectado|not found|no device/i.test(msg);
}

export function getUsbAccessDeniedMessage(detail?: string): string {
  const suffix = detail ? ` Detalhe: ${detail}` : "";
  return "Acesso USB negado: a impressora está presa pelo driver/spooler do sistema ou por outra sessão. " +
    "O PDV vai tentar imprimir pelo Agente Local/Windows automaticamente. Para usar WebUSB direto, remova a impressora dos dispositivos do sistema ou instale WinUSB via Zadig." +
    suffix;
}

export function getUsbDisconnectedMessage(detail?: string): string {
  const suffix = detail ? ` Detalhe: ${detail}` : "";
  return "A conexão WebUSB foi perdida pelo navegador. O PDV tentou reabrir a impressora automaticamente; se persistir, desconecte e reconecte o cabo USB e autorize novamente." + suffix;
}

/** Solicita permissão para uma impressora USB. Gesto de usuário obrigatório. */
export async function requestUsbPrinter(includeAll = false): Promise<USBDevice> {
  const state = getBrowserDeviceFeatureState("usb");
  if (!state.available) throw new Error(state.message);
  const filters: USBDeviceFilter[] = includeAll
    ? [...VENDOR_FILTERS, { classCode: 7 }] // 7 = Printer class
    : VENDOR_FILTERS;
  try {
    return await navigator.usb.requestDevice({ filters });
  } catch (error) {
    throw new Error(describeBrowserDeviceError(error, "usb"));
  }
}

/** Retorna a primeira impressora já autorizada previamente (filtrando por vendor conhecido). */
export async function getGrantedUsbPrinter(): Promise<USBDevice | null> {
  if (!isWebUsbSupported()) return null;
  try {
    const list = await navigator.usb.getDevices();
    if (list.length === 0) return null;
    const knownVendors = new Set(
      VENDOR_FILTERS.map((f) => f.vendorId).filter((v): v is number => typeof v === "number"),
    );
    const preferred = list.find((d) => knownVendors.has(d.vendorId));
    if (preferred) return preferred;
    const printerClass = list.find((d) => {
      const cfg = d.configuration ?? d.configurations[0];
      return cfg?.interfaces.some((i) => i.alternate.interfaceClass === 7);
    });
    return printerClass ?? list[0];
  } catch (error) {
    if (error instanceof Error) console.warn("[escpos] webusb indisponível:", describeBrowserDeviceError(error, "usb"));
    return null;
  }
}

/** Revoga a permissão WebUSB previamente concedida (para reautorizar). */
export async function forgetUsbPrinter(): Promise<void> {
  if (!isWebUsbSupported()) return;
  try {
    const list = await navigator.usb.getDevices();
    for (const d of list) {
      const anyDev = d as USBDevice & { forget?: () => Promise<void> };
      if (typeof anyDev.forget === "function") await anyDev.forget();
    }
  } catch (error) {
    console.warn("[escpos] forgetUsbPrinter falhou:", error);
  }
}

/** Fecha sessões WebUSB abertas e revoga permissões para forçar uma autorização limpa. */
export async function resetUsbPrinterConnection(): Promise<void> {
  if (!isWebUsbSupported()) return;
  try {
    const list = await navigator.usb.getDevices();
    for (const device of list) {
      await safelyCloseUsbDevice(device);
      const anyDevice = device as USBDevice & { forget?: () => Promise<void> };
      if (typeof anyDevice.forget === "function") {
        try { await anyDevice.forget(); } catch { /* navegadores podem negar forget() */ }
      }
    }
  } catch (error) {
    console.warn("[escpos] resetUsbPrinterConnection falhou:", error);
  }
}

async function safelyCloseUsbDevice(device: USBDevice, claimedInterface?: number | null): Promise<void> {
  if (claimedInterface !== null && claimedInterface !== undefined) {
    try { await device.releaseInterface(claimedInterface); } catch { /* noop */ }
  }
  try {
    if (device.opened) await device.close();
  } catch { /* noop */ }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function sameUsbDevice(a: USBDevice, b: USBDevice): boolean {
  return a.vendorId === b.vendorId
    && a.productId === b.productId
    && (a.serialNumber === b.serialNumber || !a.serialNumber || !b.serialNumber);
}

async function refetchGrantedUsbDevice(reference: USBDevice): Promise<USBDevice | null> {
  try {
    const devices = await navigator.usb.getDevices();
    return devices.find((device) => sameUsbDevice(device, reference)) ?? null;
  } catch {
    return null;
  }
}

async function openUsbDeviceWithRecovery(device: USBDevice): Promise<USBDevice> {
  let activeDevice = device;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await wait(250 + attempt * 200);
      const refreshed = await refetchGrantedUsbDevice(device);
      if (refreshed) activeDevice = refreshed;
    }

    if (activeDevice.opened) return activeDevice;

    try {
      await activeDevice.open();
      return activeDevice;
    } catch (error) {
      lastError = error;
      await safelyCloseUsbDevice(activeDevice);
      if (!isUsbDisconnectedError(error)) break;
    }
  }

  if (isUsbAccessDeniedError(lastError)) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(getUsbAccessDeniedMessage(detail));
  }
  if (isUsbDisconnectedError(lastError)) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(getUsbDisconnectedMessage(detail));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Falha ao abrir WebUSB"));
}

interface UsbPrinterInterface {
  interfaceNumber: number;
  alternate: USBAlternateInterface;
}

/**
 * Envia bytes ESC/POS crus para a impressora USB.
 * Estratégia: abre o device, seleciona a primeira configuração, faz claim
 * da primeira interface com endpoint OUT bulk, e escreve o payload.
 */
export async function printUsbRaw(device: USBDevice, payload: Uint8Array): Promise<void> {
  let activeDevice = device;
  let claimed: number | null = null;
  try {
    activeDevice = await openUsbDeviceWithRecovery(device);
    if (activeDevice.configuration === null) {
      const configurationValue = activeDevice.configurations[0]?.configurationValue ?? 1;
      await activeDevice.selectConfiguration(configurationValue);
    }
    const iface = pickPrinterInterface(activeDevice);
    if (!iface) throw new Error("Nenhuma interface de impressão encontrada no dispositivo.");
    try {
      await activeDevice.claimInterface(iface.interfaceNumber);
      claimed = iface.interfaceNumber;
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(isUsbAccessDeniedError(e)
        ? getUsbAccessDeniedMessage(detail)
        : `Não foi possível reservar a interface USB da impressora. Detalhe: ${detail}`,
      );
    }
    try { await activeDevice.selectAlternateInterface(iface.interfaceNumber, iface.alternate.alternateSetting); }
    catch { /* algumas impressoras rejeitam — ignorar */ }
    const endpoint = iface.alternate.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
    if (!endpoint) throw new Error("Endpoint OUT/bulk não encontrado.");
    // Chunk conservador: algumas controladoras ESC/POS desconectam no Chrome
    // quando recebem blocos grandes logo após reabrir o device.
    const CHUNK = Math.max(64, endpoint.packetSize || 64);
    for (let i = 0; i < payload.length; i += CHUNK) {
      const slice = payload.slice(i, i + CHUNK);
      let res = await activeDevice.transferOut(endpoint.endpointNumber, slice);
      if (res.status === "stall") {
        await activeDevice.clearHalt("out", endpoint.endpointNumber);
        res = await activeDevice.transferOut(endpoint.endpointNumber, slice);
      }
      if (res.status !== "ok") throw new Error(`transferOut status=${res.status}`);
    }
  } finally {
    await safelyCloseUsbDevice(activeDevice, claimed);
  }
}

function hasBulkOutEndpoint(alternate: USBAlternateInterface): boolean {
  return alternate.endpoints.some((ep) => ep.direction === "out" && ep.type === "bulk");
}

function pickPrinterInterface(device: USBDevice): UsbPrinterInterface | null {
  const cfg = device.configuration;
  if (!cfg) return null;
  for (const iface of cfg.interfaces) {
    const alternate = iface.alternates.find((alt) => alt.interfaceClass === 7 && hasBulkOutEndpoint(alt));
    if (alternate) return { interfaceNumber: iface.interfaceNumber, alternate };
  }
  for (const iface of cfg.interfaces) {
    const alternate = iface.alternates.find(hasBulkOutEndpoint);
    if (alternate) return { interfaceNumber: iface.interfaceNumber, alternate };
  }
  for (const iface of cfg.interfaces) {
    const alternate = iface.alternates.find((alt) => alt.interfaceClass === 7);
    if (alternate) return { interfaceNumber: iface.interfaceNumber, alternate };
  }
  return null;
}
