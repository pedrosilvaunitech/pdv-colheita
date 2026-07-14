/**
 * Agente de Impressão Local do Bastion POS.
 *
 * Servidor HTTP local em http://127.0.0.1:9100 que envia bytes ESC/POS
 * para impressoras térmicas. Cadeia de canais em ordem de preferência:
 *
 *   1. SPOOLER do sistema (Windows/macOS/Linux) via @thiagoelg/node-printer
 *      → usa o driver oficial da impressora, sem exigir WinUSB.
 *      → resolve LIBUSB_ERROR_NOT_SUPPORTED / LIBUSB_ERROR_ACCESS.
 *   2. USB bruto via node-usb (libusb) — fallback quando não há spooler
 *      cadastrado ou o operador prefere acesso direto.
 *
 * Endpoints:
 *   GET  /status        → { version, printers, channels }
 *   POST /print         → body: bytes ESC/POS crus  · Header X-Printer: <nome>
 *   POST /open-drawer   → pulso de abertura de gaveta
 */

const express = require("express");
const cors = require("cors");
const usb = require("usb");

let nodePrinter = null;
try { nodePrinter = require("@thiagoelg/node-printer"); }
catch { console.warn("[agent] @thiagoelg/node-printer não instalado — apenas canal USB bruto disponível."); }

const PORT = Number(process.env.BASTION_AGENT_PORT || 9100);
const VERSION = "1.1.0";

const KNOWN_VENDORS = {
  0x04b8: "Epson", 0x0fe6: "Bematech", 0x0dd4: "Custom", 0x0416: "Elgin",
  0x1504: "Bixolon", 0x0519: "Star", 0x1fc9: "Daruma", 0x0483: "Sunmi/STMicro",
  0x28e9: "Xprinter", 0x154f: "Citizen",
};

function hex4(n) { return n.toString(16).padStart(4, "0"); }

// ────────────────────────────────────────────────────────────────────
// SPOOLER (canal preferencial — não exige WinUSB)
// ────────────────────────────────────────────────────────────────────
function listSpoolerPrinters() {
  if (!nodePrinter) return [];
  try {
    return nodePrinter.getPrinters().map((p) => ({
      name: p.name,
      channel: "spooler",
      status: p.status || (p.attributes || []).join(","),
    }));
  } catch (e) {
    console.warn("[agent] getPrinters falhou:", e && e.message);
    return [];
  }
}

function printViaSpooler(printerName, payload) {
  return new Promise((resolve, reject) => {
    if (!nodePrinter) return reject(new Error("Spooler indisponível (@thiagoelg/node-printer não instalado)"));
    const target = printerName || (nodePrinter.getDefaultPrinterName && nodePrinter.getDefaultPrinterName())
      || (listSpoolerPrinters()[0] && listSpoolerPrinters()[0].name);
    if (!target) return reject(new Error("Nenhuma impressora cadastrada no spooler do sistema"));
    nodePrinter.printDirect({
      data: Buffer.from(payload),
      printer: target,
      type: "RAW",
      success: () => resolve(target),
      error: (err) => reject(err instanceof Error ? err : new Error(String(err))),
    });
  });
}

// ────────────────────────────────────────────────────────────────────
// USB BRUTO (fallback — exige WinUSB no Windows)
// ────────────────────────────────────────────────────────────────────
function listUsbPrinters() {
  const out = [];
  for (const dev of usb.getDeviceList()) {
    try {
      const d = dev.deviceDescriptor;
      if (KNOWN_VENDORS[d.idVendor] !== undefined || hasPrinterInterface(dev)) {
        out.push({
          name: `${KNOWN_VENDORS[d.idVendor] || "USB"}-${hex4(d.idVendor)}:${hex4(d.idProduct)}`,
          channel: "usb",
          vendorId: d.idVendor,
          productId: d.idProduct,
        });
      }
    } catch { /* noop */ }
  }
  return out;
}

function hasPrinterInterface(dev) {
  try {
    dev.open();
    try {
      for (const iface of dev.interfaces || []) {
        if (iface.descriptor && iface.descriptor.bInterfaceClass === 7) return true;
      }
    } finally { try { dev.close(); } catch {} }
  } catch { /* driver reservou o device — típico Windows */ }
  return false;
}

function pickUsbDevice(nameHint) {
  const printers = listUsbPrinters();
  if (printers.length === 0) throw new Error("Nenhuma impressora USB detectada.");
  const chosen = nameHint ? printers.find((p) => p.name === nameHint) || printers[0] : printers[0];
  const dev = usb.getDeviceList().find(
    (d) => d.deviceDescriptor.idVendor === chosen.vendorId &&
           d.deviceDescriptor.idProduct === chosen.productId,
  );
  if (!dev) throw new Error(`Impressora não encontrada: ${chosen.name}`);
  return { dev, meta: chosen };
}

async function writeUsbRaw(dev, payload) {
  dev.open();
  const iface =
    dev.interfaces.find((i) => i.descriptor && i.descriptor.bInterfaceClass === 7) ||
    dev.interfaces[0];
  if (!iface) throw new Error("Interface USB de impressora não encontrada.");
  if (typeof iface.isKernelDriverActive === "function") {
    try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch {}
  }
  try {
    iface.claim();
  } catch (e) {
    // Traduz erros libusb em mensagens acionáveis
    const m = e && e.message ? e.message : String(e);
    if (/NOT_SUPPORTED/i.test(m)) {
      throw new Error("LIBUSB_ERROR_NOT_SUPPORTED — driver de impressora do Windows travou a interface. Use o canal spooler (imprima pelo driver do Windows) ou substitua o driver por WinUSB via Zadig.");
    }
    if (/ACCESS/i.test(m)) {
      throw new Error("LIBUSB_ERROR_ACCESS — sem permissão para o dispositivo USB. Feche outros programas que estejam usando a impressora ou execute o agente como administrador.");
    }
    throw e;
  }
  try {
    const endpoint = iface.endpoints.find((e) => e.direction === "out");
    if (!endpoint) throw new Error("Endpoint OUT não encontrado.");
    await new Promise((resolve, reject) => {
      endpoint.transfer(Buffer.from(payload), (err) => (err ? reject(err) : resolve()));
    });
  } finally {
    try { iface.release(true, () => {}); } catch {}
    try { dev.close(); } catch {}
  }
}

// ────────────────────────────────────────────────────────────────────
// Envio unificado: spooler primeiro, USB depois. Se o cliente pedir
// explicitamente um nome no formato "Vendor-XXXX:YYYY", vai direto ao USB.
// ────────────────────────────────────────────────────────────────────
async function printSmart(hint, payload) {
  const isUsbHint = typeof hint === "string" && /^[^-]+-[0-9a-f]{4}:[0-9a-f]{4}$/i.test(hint);
  const errors = [];

  // 1. spooler
  if (!isUsbHint && nodePrinter) {
    try { const name = await printViaSpooler(hint, payload); return { channel: "spooler", printer: name }; }
    catch (e) { errors.push(`spooler: ${e.message}`); }
  }

  // 2. usb bruto
  try {
    const { dev, meta } = pickUsbDevice(isUsbHint ? hint : undefined);
    await writeUsbRaw(dev, payload);
    return { channel: "usb", printer: meta.name };
  } catch (e) { errors.push(`usb: ${e.message}`); }

  throw new Error(errors.join(" | "));
}

// ────────────────────────────────────────────────────────────────────
// HTTP
// ────────────────────────────────────────────────────────────────────
function startAgent() {
  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.raw({ type: "application/octet-stream", limit: "10mb" }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/status", (_req, res) => {
    let spooler = [], usbList = [];
    try { spooler = listSpoolerPrinters(); } catch {}
    try { usbList = listUsbPrinters().map((p) => ({ name: p.name, channel: "usb" })); } catch {}
    // Prioriza spooler na lista (é o que funciona sem WinUSB no Windows)
    const printers = [...spooler, ...usbList];
    res.json({
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      channels: { spooler: !!nodePrinter, usb: true },
      printers,
    });
  });

  app.post("/print", async (req, res) => {
    try {
      const hint = req.headers["x-printer"];
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
      if (!body.length) return res.status(400).send("Payload vazio.");
      const r = await printSmart(typeof hint === "string" ? hint : undefined, body);
      res.status(200).json({ ok: true, ...r });
    } catch (e) {
      console.error("[agent] print error:", e);
      res.status(500).send(e && e.message ? e.message : String(e));
    }
  });

  app.post("/open-drawer", async (req, res) => {
    try {
      const hint = req.headers["x-printer"];
      const pulse = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
      const r = await printSmart(typeof hint === "string" ? hint : undefined, pulse);
      res.status(200).json({ ok: true, ...r });
    } catch (e) {
      res.status(500).send(e && e.message ? e.message : String(e));
    }
  });

  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`[bastion-agent] http://127.0.0.1:${PORT} · v${VERSION} · spooler=${!!nodePrinter} usb=true`);
  });
  return server;
}

if (require.main === module) startAgent();
module.exports = { startAgent };
