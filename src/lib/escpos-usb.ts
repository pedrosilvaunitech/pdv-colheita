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

/**
 * Envia bytes ESC/POS crus para a impressora USB.
 * Estratégia: abre o device, seleciona a primeira configuração, faz claim
 * da primeira interface com endpoint OUT bulk, e escreve o payload.
 */
export async function printUsbRaw(device: USBDevice, payload: Uint8Array): Promise<void> {
  await device.open();
  try {
    if (device.configuration === null) await device.selectConfiguration(1);
    const iface = pickPrinterInterface(device);
    if (!iface) throw new Error("Nenhuma interface de impressão encontrada no dispositivo.");
    // Em Linux/macOS o driver genérico usbfs cede a interface sem drama.
    // Em Windows exige WinUSB (via Zadig) ou uso do Agente Local.
    try { await device.claimInterface(iface.interfaceNumber); }
    catch (e: unknown) {
      throw new Error(
        "Não foi possível reservar a interface USB da impressora. " +
        "No Windows, instale o driver WinUSB (Zadig) ou utilize o Agente de Impressão Local (.exe). " +
        `Detalhe: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    const endpoint = iface.alternate.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
    if (!endpoint) throw new Error("Endpoint OUT/bulk não encontrado.");
    // Alguns firmwares aceitam apenas blocos <= 64 bytes; enviamos em pedaços.
    const CHUNK = 64;
    for (let i = 0; i < payload.length; i += CHUNK) {
      const slice = payload.slice(i, i + CHUNK);
      await device.transferOut(endpoint.endpointNumber, slice);
    }
  } finally {
    try { await device.releaseInterface(0); } catch { /* noop */ }
    try { await device.close(); } catch { /* noop */ }
  }
}

function pickPrinterInterface(device: USBDevice): USBInterface | null {
  const cfg = device.configuration;
  if (!cfg) return null;
  for (const iface of cfg.interfaces) {
    if (iface.alternate.interfaceClass === 7) return iface;
  }
  for (const iface of cfg.interfaces) {
    if (iface.alternate.endpoints.some((ep) => ep.direction === "out" && ep.type === "bulk")) return iface;
  }
  return null;
}
