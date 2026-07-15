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
const VERSION = "1.3.1";

// Modelos conhecidos e sua largura padrão. Usado para inferir paperWidth
// quando o driver não reporta e para exibir o modelo real na UI.
const MODEL_HINTS = [
  { re: /TM-T20/i, model: "Epson TM-T20", paperWidth: 80 },
  { re: /TM-T88/i, model: "Epson TM-T88", paperWidth: 80 },
  { re: /TM-U220/i, model: "Epson TM-U220", paperWidth: 76 },
  { re: /TM-T81/i, model: "Epson TM-T81", paperWidth: 80 },
  { re: /MP-4200/i, model: "Bematech MP-4200", paperWidth: 80 },
  { re: /MP-100/i, model: "Bematech MP-100", paperWidth: 58 },
  { re: /i9|i8|i7/i, model: "Elgin i9", paperWidth: 80 },
  { re: /XP-58|XP58/i, model: "Xprinter XP-58", paperWidth: 58 },
  { re: /XP-80|XP80/i, model: "Xprinter XP-80", paperWidth: 80 },
];

function guessModel(name) {
  for (const h of MODEL_HINTS) if (h.re.test(name)) return h;
  return null;
}

// Mapa Win32_Printer.PrinterStatus → estado normalizado
const WIN_STATUS = {
  1: { s: "error",   m: "Outro" },
  2: { s: "offline", m: "Desconhecido" },
  3: { s: "online",  m: "Pronta" },
  4: { s: "online",  m: "Imprimindo" },
  5: { s: "online",  m: "Aquecendo" },
  6: { s: "error",   m: "Impressão parada" },
  7: { s: "offline", m: "Offline" },
};

// Win32_Printer.DetectedErrorState → mensagem
const WIN_ERROR = {
  3: "Papel baixo", 4: "Sem papel", 5: "Toner baixo", 6: "Sem toner",
  7: "Tampa aberta", 8: "Papel atolado", 9: "Serviço requerido",
  10: "Bandeja cheia", 11: "Problema no papel", 12: "Não pode imprimir",
  13: "Requer intervenção", 14: "Sem memória",
};

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
  // No Windows, sempre use CIM (retorna default/status/errorState).
  if (process.platform === "win32") return listWindowsSpoolerPrinters();
  if (!nodePrinter) return [];
  try {
    const def = nodePrinter.getDefaultPrinterName && nodePrinter.getDefaultPrinterName();
    return nodePrinter.getPrinters().map((p) => {
      const isDefault = def && p.name === def;
      const hint = guessModel(p.name);
      const offline = /offline|paused|error/i.test(p.status || (p.attributes || []).join(","));
      return {
        name: p.name,
        source: "windows",
        channel: "spooler",
        status: offline ? "offline" : "online",
        statusMessage: p.status || (p.attributes || []).join(",") || "Pronta",
        isDefault: !!isDefault,
        model: hint ? hint.model : undefined,
        paperWidth: hint ? hint.paperWidth : undefined,
      };
    });
  } catch (e) {
    console.warn("[agent] getPrinters falhou:", e && e.message);
    return [];
  }
}

function runPowerShell(script, args = [], opts = {}) {
  if (process.platform !== "win32") throw new Error("PowerShell spooler disponível apenas no Windows");
  const exe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const scriptFile = path.join(os.tmpdir(), `bastion-pos-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
  fs.writeFileSync(scriptFile, script, "utf8");
  try {
    const r = spawnSync(exe, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptFile,
      ...args,
    ], { encoding: "utf8", windowsHide: true, timeout: opts.timeoutMs || 15000 });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || `PowerShell saiu com código ${r.status}`).trim();
      throw new Error(msg);
    }
    return (r.stdout || "").trim();
  } finally {
    try { fs.unlinkSync(scriptFile); } catch {}
  }
}

function listWindowsSpoolerPrinters() {
  if (process.platform !== "win32") return [];
  try {
    const out = runPowerShell(
      "Get-CimInstance Win32_Printer | " +
      "Select-Object Name,Default,WorkOffline,PrinterStatus,DetectedErrorState,DriverName,PortName | ConvertTo-Json -Compress",
      [],
      { timeoutMs: 8000 },
    );
    if (!out) return [];
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((p) => p && typeof p.Name === "string" && p.Name.trim())
      .sort((a, b) => Number(Boolean(b.Default)) - Number(Boolean(a.Default)))
      .map((p) => {
        const isDefault = Boolean(p.Default);
        const winStat = WIN_STATUS[Number(p.PrinterStatus)] || { s: "offline", m: "Sem status" };
        const errMsg = WIN_ERROR[Number(p.DetectedErrorState)];
        const status = errMsg ? "error" : (p.WorkOffline ? "offline" : winStat.s);
        const statusMessage = errMsg || (p.WorkOffline ? "Trabalhando offline" : winStat.m);
        const hint = guessModel(p.Name) || guessModel(p.DriverName || "");
        return {
          name: p.Name,
          source: "windows",
          channel: "spooler",
          status,
          statusMessage,
          isDefault,
          model: hint ? hint.model : (p.DriverName || undefined),
          paperWidth: hint ? hint.paperWidth : undefined,
        };
      });
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
    const spoolerPrinters = listSpoolerPrinters();
    const hasExactTarget = printerName && spoolerPrinters.some((p) => p.name === printerName);
    const target = (hasExactTarget ? printerName : null)
      || (nodePrinter.getDefaultPrinterName && nodePrinter.getDefaultPrinterName())
      || (spoolerPrinters[0] && spoolerPrinters[0].name);
    if (!target) return reject(new Error("Nenhuma impressora cadastrada no spooler do sistema"));
    nodePrinter.printDirect({
      data: Buffer.from(payload),
      printer: target,
      type: "RAW",
      success: () => resolve(target),
      error: (err) => {
        if (process.platform === "win32") {
          try { return resolve(printViaWindowsSpooler(target, payload)); }
          catch (fallbackErr) {
            const original = err instanceof Error ? err.message : String(err);
            const fallback = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            return reject(new Error(`${original} | windows-spooler: ${fallback}`));
          }
        }
        return reject(err instanceof Error ? err : new Error(String(err)));
      },
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
      const vendor = KNOWN_VENDORS[d.idVendor];
      const printerIface = hasPrinterInterface(dev);
      if (vendor !== undefined || printerIface) {
        const name = `${vendor || "USB"}-${hex4(d.idVendor)}:${hex4(d.idProduct)}`;
        const hint = guessModel(name) || guessModel(vendor || "");
        out.push({
          name,
          source: "agent",
          channel: "usb",
          vendorId: d.idVendor,
          productId: d.idProduct,
          status: "online",
          statusMessage: printerIface ? "USB pronta" : "USB reservada",
          isDefault: false,
          model: hint ? hint.model : (vendor ? `${vendor} genérica` : "USB genérica"),
          paperWidth: hint ? hint.paperWidth : undefined,
        });
      }
    } catch { /* noop */ }
  }
  return out;
}

/**
 * União ordenada: primeiro a impressora default do Windows, depois demais
 * do spooler, depois USB brutas. Dedup por (source|name).
 */
function listAllPrinters() {
  const spooler = (() => { try { return listSpoolerPrinters(); } catch { return []; } })();
  const usbList = (() => { try { return listUsbPrinters(); } catch { return []; } })();
  const seen = new Set();
  const push = (arr, out) => {
    for (const p of arr) {
      const k = `${p.source}|${p.name.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  };
  const merged = [];
  push(spooler, merged);
  push(usbList, merged);
  return merged;
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
// Envio unificado. Se o cliente indicar `source` via X-Printer-Source,
// respeitamos o roteamento pedido. Fallback: spooler antes de USB (como
// hoje) para evitar LIBUSB_ERROR_NOT_SUPPORTED no Windows.
// ────────────────────────────────────────────────────────────────────
async function printSmart(hint, payload, opts = {}) {
  const source = typeof opts.source === "string" ? opts.source.toLowerCase() : null;
  const isUsbHint = typeof hint === "string" && /^[^-]+-[0-9a-f]{4}:[0-9a-f]{4}$/i.test(hint);
  const errors = [];

  // Roteamento explícito (novo cliente da UI passa source)
  if (source === "windows") {
    try { const name = await printViaSpooler(hint, payload); return { channel: "spooler", printer: name, source: "windows" }; }
    catch (e) { throw new Error(`spooler: ${e.message}`); }
  }
  if (source === "agent") {
    try {
      const { dev, meta } = pickUsbDevice(isUsbHint ? hint : undefined);
      await writeUsbRaw(dev, payload);
      return { channel: "usb", printer: meta.name, source: "agent" };
    } catch (e) {
      errors.push(`usb: ${e.message}`);
      // Em Windows, a Epson TM-T20X normalmente fica reservada pelo driver.
      // Nesse caso o canal USB bruto falha, mas o spooler RAW imprime sem
      // trocar driver/WinUSB. Mantém a seleção antiga funcionando no PWA.
      if (process.platform === "win32") {
        try { const name = await printViaSpooler(undefined, payload); return { channel: "spooler", printer: name, source: "windows" }; }
        catch (spoolerErr) { errors.push(`spooler: ${spoolerErr.message}`); }
      }
      throw new Error(errors.join(" | "));
    }
  }

  // Comportamento legado (sem source explícito)
  if (!isUsbHint || process.platform === "win32") {
    try { const name = await printViaSpooler(hint, payload); return { channel: "spooler", printer: name, source: "windows" }; }
    catch (e) { errors.push(`spooler: ${e.message}`); }
  }
  try {
    const { dev, meta } = pickUsbDevice(isUsbHint ? hint : undefined);
    await writeUsbRaw(dev, payload);
    return { channel: "usb", printer: meta.name, source: "agent" };
  } catch (e) { errors.push(`usb: ${e.message}`); }

  throw new Error(errors.join(" | "));
}

// ────────────────────────────────────────────────────────────────────
// HTTP
// ────────────────────────────────────────────────────────────────────
function startAgent() {
  const app = express();
  // CORS/PNA explícito: PWAs publicados em HTTPS fazem preflight para
  // http://127.0.0.1. Sem Access-Control-Allow-Private-Network o Chrome
  // consegue consultar /status em alguns cenários, mas bloqueia POST /print.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    else res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Vary", "Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type, X-Printer, X-Printer-Source, Accept, Origin");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("Access-Control-Expose-Headers", "X-Agent-Version");
    res.setHeader("X-Agent-Version", VERSION);
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  app.use(express.raw({ type: "application/octet-stream", limit: "10mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => { res.setHeader("X-Agent-Version", VERSION); next(); });

  const respondPrinters = (res) => {
    const printers = listAllPrinters();
    res.json({
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      channels: { spooler: !!nodePrinter || process.platform === "win32", usb: true },
      printers,
      generatedAt: new Date().toISOString(),
    });
  };

  app.get("/status", (_req, res) => respondPrinters(res));
  app.get("/printers", (_req, res) => respondPrinters(res));

  app.post("/print", async (req, res) => {
    try {
      const hint = req.headers["x-printer"];
      const source = req.headers["x-printer-source"];
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
      if (!body.length) return res.status(400).send("Payload vazio.");
      const r = await printSmart(
        typeof hint === "string" ? hint : undefined,
        body,
        { source: typeof source === "string" ? source : null },
      );
      res.status(200).json({ ok: true, ...r });
    } catch (e) {
      console.error("[agent] print error:", e);
      res.status(500).send(e && e.message ? e.message : String(e));
    }
  });

  app.post("/open-drawer", async (req, res) => {
    try {
      const hint = req.headers["x-printer"];
      const source = req.headers["x-printer-source"];
      const pulse = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
      const r = await printSmart(
        typeof hint === "string" ? hint : undefined,
        pulse,
        { source: typeof source === "string" ? source : null },
      );
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
