/**
 * Agente de Impressão Local do Bastion POS.
 *
 * Servidor HTTP local que escuta em http://127.0.0.1:9100 e converte
 * requisições HTTP em impressões USB brutas (ESC/POS). Roda embutido
 * no wrapper Electron (main.cjs) ou standalone (`node agent.cjs`).
 *
 * Endpoints:
 *   GET  /status                → { version, printers: [nome, ...] }
 *   POST /print                 → body: bytes ESC/POS crus
 *          Header opcional X-Printer: <nome>
 *   POST /open-drawer           → pulso de abertura de gaveta
 *
 * Segurança:
 *   - Bind apenas em 127.0.0.1 (nunca exposto na rede).
 *   - CORS liberado (o PWA roda em outra origem — .lovable.app, etc).
 */

const express = require("express");
const cors = require("cors");
const usb = require("usb");

const PORT = Number(process.env.BASTION_AGENT_PORT || 9100);
const VERSION = "1.0.0";

// vendorId → rótulo humano (para exibição no /status)
const KNOWN_VENDORS = {
  0x04b8: "Epson",
  0x0fe6: "Bematech",
  0x0dd4: "Custom",
  0x0416: "Elgin",
  0x1504: "Bixolon",
  0x0519: "Star",
  0x1fc9: "Daruma",
  0x0483: "Sunmi/STMicro",
  0x28e9: "Xprinter",
  0x154f: "Citizen",
};

function listPrinters() {
  const out = [];
  for (const dev of usb.getDeviceList()) {
    try {
      const d = dev.deviceDescriptor;
      const isPrinter =
        KNOWN_VENDORS[d.idVendor] !== undefined ||
        hasPrinterInterface(dev);
      if (isPrinter) {
        out.push({
          name: `${KNOWN_VENDORS[d.idVendor] || "USB"}-${hex4(d.idVendor)}:${hex4(d.idProduct)}`,
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
  } catch { /* privileges/driver */ }
  return false;
}

function hex4(n) { return n.toString(16).padStart(4, "0"); }

function pickDevice(nameHint) {
  const printers = listPrinters();
  if (printers.length === 0) throw new Error("Nenhuma impressora USB detectada.");
  const chosen = nameHint
    ? printers.find((p) => p.name === nameHint) || printers[0]
    : printers[0];
  const dev = usb.getDeviceList().find(
    (d) => d.deviceDescriptor.idVendor === chosen.vendorId &&
           d.deviceDescriptor.idProduct === chosen.productId,
  );
  if (!dev) throw new Error(`Impressora não encontrada: ${chosen.name}`);
  return { dev, meta: chosen };
}

async function writeRaw(dev, payload) {
  dev.open();
  const iface =
    dev.interfaces.find((i) => i.descriptor && i.descriptor.bInterfaceClass === 7) ||
    dev.interfaces[0];
  if (!iface) throw new Error("Interface USB de impressora não encontrada.");
  // Windows: se o driver de impressora nativo tiver "pegado" o dispositivo,
  // detachKernelDriver libera para acesso direto. Em Linux é obrigatório;
  // no macOS/Windows é no-op ou não suportado (silenciamos o erro).
  if (typeof iface.isKernelDriverActive === "function") {
    try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); }
    catch { /* driver não-Linux */ }
  }
  iface.claim();
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

function startAgent() {
  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.raw({ type: "application/octet-stream", limit: "10mb" }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/status", (_req, res) => {
    let printers = [];
    try { printers = listPrinters().map((p) => p.name); } catch {}
    res.json({ version: VERSION, printers, platform: process.platform, arch: process.arch });
  });

  app.post("/print", async (req, res) => {
    try {
      const hint = req.headers["x-printer"];
      const { dev } = pickDevice(typeof hint === "string" ? hint : undefined);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
      if (!body.length) return res.status(400).send("Payload vazio.");
      await writeRaw(dev, body);
      res.status(200).send("ok");
    } catch (e) {
      console.error("[agent] print error:", e);
      res.status(500).send(e && e.message ? e.message : String(e));
    }
  });

  app.post("/open-drawer", async (req, res) => {
    try {
      const hint = req.headers["x-printer"];
      const { dev } = pickDevice(typeof hint === "string" ? hint : undefined);
      // ESC p m t1 t2 — pulso na conector RJ11 (gaveta)
      await writeRaw(dev, Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]));
      res.status(200).send("ok");
    } catch (e) {
      res.status(500).send(e && e.message ? e.message : String(e));
    }
  });

  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`[bastion-agent] escutando em http://127.0.0.1:${PORT} · v${VERSION}`);
  });
  return server;
}

if (require.main === module) startAgent();
module.exports = { startAgent };
