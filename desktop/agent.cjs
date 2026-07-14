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
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let nodePrinter = null;
try { nodePrinter = require("@thiagoelg/node-printer"); }
catch { console.warn("[agent] @thiagoelg/node-printer não instalado — apenas canal USB bruto disponível."); }

const PORT = Number(process.env.BASTION_AGENT_PORT || 9100);
const VERSION = "1.2.0";

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
  if (!nodePrinter) return listWindowsSpoolerPrinters();
  try {
    return nodePrinter.getPrinters().map((p) => ({
      name: p.name,
      channel: "spooler",
      status: p.status || (p.attributes || []).join(","),
    }));
  } catch (e) {
    console.warn("[agent] getPrinters falhou:", e && e.message);
    return listWindowsSpoolerPrinters();
  }
}

function runPowerShell(script, args = [], opts = {}) {
  if (process.platform !== "win32") throw new Error("PowerShell spooler disponível apenas no Windows");
  const exe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const r = spawnSync(exe, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", script,
    ...args,
  ], { encoding: "utf8", windowsHide: true, timeout: opts.timeoutMs || 15000 });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || `PowerShell saiu com código ${r.status}`).trim();
    throw new Error(msg);
  }
  return (r.stdout || "").trim();
}

function listWindowsSpoolerPrinters() {
  if (process.platform !== "win32") return [];
  try {
    const out = runPowerShell(
      "Get-CimInstance Win32_Printer | " +
      "Select-Object Name,Default,WorkOffline,PrinterStatus | ConvertTo-Json -Compress",
      [],
      { timeoutMs: 8000 },
    );
    if (!out) return [];
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((p) => p && typeof p.Name === "string" && p.Name.trim())
      .sort((a, b) => Number(Boolean(b.Default)) - Number(Boolean(a.Default)))
      .map((p) => ({
        name: p.Name,
        channel: "spooler",
        status: p.Default ? "default" : (p.WorkOffline ? "offline" : `status:${p.PrinterStatus || "unknown"}`),
      }));
  } catch (e) {
    console.warn("[agent] spooler Windows indisponível:", e && e.message);
    return [];
  }
}

function printViaWindowsSpooler(printerName, payload) {
  const printers = listWindowsSpoolerPrinters();
  const exact = printerName ? printers.find((p) => p.name === printerName) : null;
  const target = (exact && exact.name) || (printers[0] && printers[0].name);
  if (!target) throw new Error("Nenhuma impressora instalada no Windows. Instale o driver EPSON e defina como padrão.");

  const tmp = path.join(os.tmpdir(), `bastion-escpos-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(tmp, Buffer.from(payload));
  try {
    const script = String.raw`
param([string]$PrinterName, [string]$FilePath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);
  public static void SendFile(string printerName, string filePath) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName.Normalize(), out hPrinter, IntPtr.Zero)) throw new Exception("OpenPrinter falhou: " + Marshal.GetLastWin32Error());
    try {
      DOCINFOA di = new DOCINFOA();
      di.pDocName = "Bastion POS ESC/POS";
      di.pDataType = "RAW";
      if (!StartDocPrinter(hPrinter, 1, di)) throw new Exception("StartDocPrinter falhou: " + Marshal.GetLastWin32Error());
      try {
        if (!StartPagePrinter(hPrinter)) throw new Exception("StartPagePrinter falhou: " + Marshal.GetLastWin32Error());
        byte[] bytes = File.ReadAllBytes(filePath);
        IntPtr unmanaged = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, unmanaged, bytes.Length);
          int written;
          if (!WritePrinter(hPrinter, unmanaged, bytes.Length, out written)) throw new Exception("WritePrinter falhou: " + Marshal.GetLastWin32Error());
          if (written != bytes.Length) throw new Exception("WritePrinter incompleto: " + written + "/" + bytes.Length);
        } finally { Marshal.FreeCoTaskMem(unmanaged); }
        EndPagePrinter(hPrinter);
      } finally { EndDocPrinter(hPrinter); }
    } finally { ClosePrinter(hPrinter); }
  }
}
'@
[RawPrinterHelper]::SendFile($PrinterName, $FilePath)
`;
    runPowerShell(script, [target, tmp], { timeoutMs: 30000 });
    return target;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function printViaSpooler(printerName, payload) {
  return new Promise((resolve, reject) => {
    if (!nodePrinter) {
      try { return resolve(printViaWindowsSpooler(printerName, payload)); }
      catch (e) { return reject(e); }
    }
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

  // 1. spooler / driver do sistema. No Windows, mesmo quando a UI selecionou
  //    um device USB bruto (Epson-04b8:xxxx), preferimos o spooler porque ele
  //    não depende de WinUSB e resolve LIBUSB_ERROR_NOT_SUPPORTED.
  if (!isUsbHint || process.platform === "win32") {
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
      channels: { spooler: !!nodePrinter || process.platform === "win32", usb: true },
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
    console.log(`[bastion-agent] http://127.0.0.1:${PORT} · v${VERSION} · spooler=${!!nodePrinter || process.platform === "win32"} usb=true`);
  });
  return server;
}

if (require.main === module) startAgent();
module.exports = { startAgent };
