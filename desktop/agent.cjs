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
const VERSION = "1.8.1";

// Motor NFC-e opcional (só carrega se node-dfe estiver instalado).
let nfce = null;
try { nfce = require("./nfce"); }
catch (e) { console.warn("[agent] nfce module indisponível:", e.message); }

// Módulo TEF (plugins carregados dinamicamente). Nunca derruba o agente.
let tef = null;
try { tef = require("./tef/manager.cjs"); }
catch (e) { console.warn("[agent] módulo TEF indisponível:", e.message); }

// Balança serial (Toledo Prix e compatíveis). Opcional: depende de `serialport`.
let scale = null;
try { scale = require("./scale.cjs"); scale.autoStart(); }
catch (e) { console.warn("[agent] módulo Balança indisponível:", e.message); }

// ── Helpers de diagnóstico ────────────────────────────────────────────────
const DATA_DIR_PATH = path.join(os.homedir(), ".bastion-pos");

// ── Identidade do agente / terminal (multi-caixa) ─────────────────────────
// Cada instalação recebe um `agent_id` fixo e pode ser vinculada a um
// `terminal_key` (o caixa no app web). O vínculo evita que dois PDVs
// compartilhem impressora, gaveta, balança ou pinpad por engano.
const IDENTITY_PATH = path.join(DATA_DIR_PATH, "identity.json");
let identityCache = null;

function readIdentity() {
  if (identityCache) return identityCache;
  let data = {};
  try {
    if (fs.existsSync(IDENTITY_PATH)) data = JSON.parse(fs.readFileSync(IDENTITY_PATH, "utf8")) || {};
  } catch (e) {
    console.warn("[agent] identity.json inválido, recriando:", e.message);
    data = {};
  }
  if (!data.agent_id) {
    data.agent_id = `agt-${os.hostname().replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toLowerCase()}-${require("crypto").randomBytes(4).toString("hex")}`;
    data.created_at = new Date().toISOString();
    writeIdentity(data);
  }
  identityCache = {
    agent_id: data.agent_id,
    terminal_key: data.terminal_key || null,
    terminal_name: data.terminal_name || null,
    store_id: data.store_id || null,
    bound_at: data.bound_at || null,
    hostname: os.hostname(),
  };
  return identityCache;
}

function writeIdentity(next) {
  try {
    if (!fs.existsSync(DATA_DIR_PATH)) fs.mkdirSync(DATA_DIR_PATH, { recursive: true });
    fs.writeFileSync(IDENTITY_PATH, JSON.stringify(next, null, 2), "utf8");
    identityCache = { ...next, hostname: os.hostname() };
  } catch (e) {
    console.warn("[agent] falha ao gravar identity.json:", e.message);
  }
}


/** Escrita no diretório de configuração (falha típica em perfil roaming/GPO). */
function isDataDirWritable() {
  try {
    if (!fs.existsSync(DATA_DIR_PATH)) fs.mkdirSync(DATA_DIR_PATH, { recursive: true });
    const probe = path.join(DATA_DIR_PATH, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * O agente está rodando como administrador? No Windows isso decide se o
 * acesso USB bruto (WinUSB) e a instalação de driver vão funcionar.
 */
function isElevated() {
  try {
    if (process.platform === "win32") {
      // `net session` só retorna 0 em processo elevado.
      const r = spawnSync("net", ["session"], { windowsHide: true, timeout: 3000 });
      return r.status === 0;
    }
    return typeof process.getuid === "function" && process.getuid() === 0;
  } catch {
    return false;
  }
}

/** libusb carregado e capaz de enumerar (falha sem WinUSB instalado). */
function hasUsbModule() {
  try { return Array.isArray(usb.getDeviceList()); }
  catch { return false; }
}




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

function pickSpoolerFallbackName() {
  const printers = listSpoolerPrinters();
  const preferred = printers.find((p) => /TM[-\s]?T20X/i.test(`${p.name} ${p.model || ""}`))
    || printers.find((p) => /TM[-\s]?T20|TM[-\s]?T88|Epson/i.test(`${p.name} ${p.model || ""}`))
    || printers.find((p) => p.isDefault)
    || printers[0];
  return preferred && preferred.name;
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
  let claimed = false;
  try {
    dev.open();
  } catch (e) {
    const m = e && e.message ? e.message : String(e);
    if (/ACCESS/i.test(m)) {
      throw new Error("LIBUSB_ERROR_ACCESS — acesso negado ao USB bruto. A impressora está presa pelo driver/spooler do sistema ou por outro processo; o agente tentará o spooler do Windows quando disponível.");
    }
    throw e;
  }
  const iface =
    dev.interfaces.find((i) => i.descriptor && i.descriptor.bInterfaceClass === 7) ||
    dev.interfaces[0];
  try {
    if (!iface) throw new Error("Interface USB de impressora não encontrada.");
    if (typeof iface.isKernelDriverActive === "function") {
      try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch {}
    }
    iface.claim();
    claimed = true;
    const endpoint = iface.endpoints.find((e) => e.direction === "out");
    if (!endpoint) throw new Error("Endpoint OUT não encontrado.");
    await new Promise((resolve, reject) => {
      endpoint.transfer(Buffer.from(payload), (err) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    const m = e && e.message ? e.message : String(e);
    if (/NOT_SUPPORTED/i.test(m)) {
      throw new Error("LIBUSB_ERROR_NOT_SUPPORTED — driver de impressora do Windows travou a interface. Use o canal spooler/Windows ou substitua o driver por WinUSB via Zadig.");
    }
    if (/ACCESS/i.test(m)) {
      throw new Error("LIBUSB_ERROR_ACCESS — acesso negado ao USB bruto. Feche outros programas ou use o canal Windows pelo Agente Local.");
    }
    throw e;
  } finally {
    if (claimed) { try { iface.release(true, () => {}); } catch {} }
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
        try { const name = await printViaSpooler(pickSpoolerFallbackName(), payload); return { channel: "spooler", printer: name, source: "windows" }; }
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
function startAgent(options = {}) {
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
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type, X-Printer, X-Printer-Source, X-Terminal-Id, Accept, Origin");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("Access-Control-Expose-Headers", "X-Agent-Version, X-Agent-Id");
    res.setHeader("X-Agent-Version", VERSION);
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  app.use(express.raw({ type: "application/octet-stream", limit: "10mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Agent-Version", VERSION);
    res.setHeader("X-Agent-Id", readIdentity().agent_id);
    next();
  });

  // Isolamento multi-caixa: quando o agente está vinculado a um terminal,
  // comandos de hardware vindos de OUTRO terminal são recusados. Assim o
  // Caixa 2 nunca imprime na impressora ou abre a gaveta do Caixa 1.
  const GUARDED = [/^\/print/, /^\/open-drawer/, /^\/scale\//, /^\/tef\//, /^\/nfce\//];
  app.use((req, res, next) => {
    if (req.method === "OPTIONS") return next();
    if (!GUARDED.some((re) => re.test(req.path))) return next();
    const id = readIdentity();
    if (!id.terminal_key) return next(); // agente livre — aceita o primeiro caixa
    const sent = req.headers["x-terminal-id"];
    if (!sent || sent === id.terminal_key) return next();
    return res.status(409).json({
      ok: false,
      error:
        `Este agente está vinculado ao terminal "${id.terminal_name || id.terminal_key}". ` +
        "Abra Configurações → Hardware → Caixas e vincule este PC ao caixa correto.",
      bound_terminal: id.terminal_key,
      bound_name: id.terminal_name,
    });
  });

  const respondPrinters = (res) => {
    const printers = listAllPrinters();
    const id = readIdentity();
    res.json({
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      agent_id: id.agent_id,
      terminal_key: id.terminal_key,
      terminal_name: id.terminal_name,
      channels: { spooler: !!nodePrinter || process.platform === "win32", usb: true },
      printers,
      generatedAt: new Date().toISOString(),
    });
  };

  app.get("/status", (_req, res) => respondPrinters(res));
  app.get("/printers", (_req, res) => respondPrinters(res));

  // ── Identidade do terminal (multi-caixa) ──────────────────────
  app.get("/identity", (_req, res) => {
    res.json({ ok: true, version: VERSION, ...readIdentity() });
  });

  app.post("/identity", (req, res) => {
    try {
      const body = req.body || {};
      const current = readIdentity();
      const next = {
        ...current,
        terminal_key: body.terminal_key ? String(body.terminal_key) : null,
        terminal_name: body.terminal_name ? String(body.terminal_name) : null,
        store_id: body.store_id ? String(body.store_id) : null,
        bound_at: body.terminal_key ? new Date().toISOString() : null,
      };
      writeIdentity(next);
      res.json({ ok: true, ...next });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Ponte para o servidor fiscal Node (local ou na rede) ──────
  //
  // Por que existe: o PDV é uma página HTTPS. Ela NÃO consegue chamar
  // http://192.168.0.50:3737 (conteúdo misto) nem um endereço privado a partir
  // da nuvem (o backend publicado não enxerga a rede da loja). O agente já roda
  // no PC do caixa e é alcançável pelo navegador, então ele faz a ponte: o PDV
  // fala com o agente em 127.0.0.1 e o agente fala com o motor fiscal.
  //
  // O token do servidor fiscal fica guardado AQUI, no PC, e não é devolvido nas
  // consultas — a página nunca precisa carregar o segredo.
  const FISCAL_SERVER_FILE = path.join(DATA_DIR_PATH, "fiscal-server.json");

  function readFiscalServer() {
    try {
      if (!fs.existsSync(FISCAL_SERVER_FILE)) return { url: null, token: null, updated_at: null };
      const raw = JSON.parse(fs.readFileSync(FISCAL_SERVER_FILE, "utf8"));
      return {
        url: typeof raw.url === "string" ? raw.url : null,
        token: typeof raw.token === "string" ? raw.token : null,
        updated_at: raw.updated_at || null,
      };
    } catch (e) {
      console.warn("[agent] fiscal-server.json ilegível:", e.message);
      return { url: null, token: null, updated_at: null };
    }
  }

  function writeFiscalServer(next) {
    fs.mkdirSync(DATA_DIR_PATH, { recursive: true });
    fs.writeFileSync(FISCAL_SERVER_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  }

  /** Normaliza o que o lojista digita: "192.168.0.50:3737" → URL completa. */
  function normalizeFiscalUrl(input) {
    let value = String(input || "").trim();
    if (!value) return null;
    if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
    value = value.replace(/\/+$/, "");
    try {
      const u = new URL(value);
      if (!u.port && u.protocol === "http:") u.port = "3737";
      return u.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  app.get("/fiscal/server", (_req, res) => {
    const cfg = readFiscalServer();
    res.json({
      ok: true,
      version: VERSION,
      url: cfg.url,
      token_set: !!cfg.token,
      updated_at: cfg.updated_at,
    });
  });

  app.post("/fiscal/server", (req, res) => {
    try {
      const body = req.body || {};
      const current = readFiscalServer();
      const url = body.url === null ? null : normalizeFiscalUrl(body.url ?? current.url);
      if (body.url && !url) {
        return res.status(400).json({ ok: false, error: "Endereço inválido. Exemplo: 192.168.0.50:3737" });
      }
      // token ausente no corpo = manter o atual; string vazia = apagar.
      const token =
        body.token === undefined ? current.token : body.token ? String(body.token).trim() : null;
      const next = { url, token, updated_at: new Date().toISOString() };
      writeFiscalServer(next);
      res.json({ ok: true, url: next.url, token_set: !!next.token, updated_at: next.updated_at });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * Repassa uma chamada para o motor fiscal.
   *
   * Corpo: { path: "/health" | "/nfce/emit" | ..., method?, body?, url?, token?, timeoutMs? }
   * `url`/`token` no corpo servem para TESTAR um endereço antes de salvar.
   */
  app.post("/fiscal/proxy", async (req, res) => {
    const body = req.body || {};
    const saved = readFiscalServer();
    const base = normalizeFiscalUrl(body.url || saved.url);
    const token = body.token !== undefined && body.token !== null ? String(body.token) : saved.token;
    const route = typeof body.path === "string" && body.path.startsWith("/") ? body.path : "/health";
    const method = String(body.method || "GET").toUpperCase();
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 20000, 2000), 120000);

    if (!base) {
      return res.status(400).json({
        ok: false,
        error: "Endereço do servidor fiscal não configurado neste PC. Informe o IP e a porta no PDV.",
      });
    }
    if (typeof fetch !== "function") {
      return res.status(501).json({
        ok: false,
        error: "Este agente roda em uma versão antiga do Node. Atualize o Bastion POS Agent.",
      });
    }

    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { Accept: "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (method !== "GET" && body.body !== undefined) headers["Content-Type"] = "application/json";
      const upstream = await fetch(`${base}${route}`, {
        method,
        headers,
        body: method === "GET" || body.body === undefined ? undefined : JSON.stringify(body.body),
        signal: ctrl.signal,
      });
      const text = await upstream.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      res.status(200).json({
        ok: upstream.ok,
        status: upstream.status,
        elapsed_ms: Date.now() - started,
        target: `${base}${route}`,
        data: parsed,
        raw: parsed ? undefined : text.slice(0, 2000),
      });
    } catch (e) {
      // Mensagens de rede do Node não dizem nada ao lojista: traduzimos.
      const msg = String((e && e.message) || e);
      let friendly = msg;
      if (/aborted|timeout/i.test(msg)) {
        friendly = `O servidor fiscal em ${base} não respondeu em ${Math.round(timeoutMs / 1000)}s.`;
      } else if (/ECONNREFUSED/i.test(msg)) {
        friendly = `Nada escutando em ${base}. Rode \`node server.js\` na pasta vps-fiscal (ou inicie o serviço).`;
      } else if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
        friendly = `Não foi possível alcançar ${base}. Confira o IP e se o PC está na mesma rede.`;
      } else if (/ETIMEDOUT/i.test(msg)) {
        friendly = `Conexão com ${base} expirou — normalmente é o Firewall do Windows bloqueando a porta.`;
      }
      res.status(200).json({
        ok: false,
        status: 0,
        elapsed_ms: Date.now() - started,
        target: `${base}${route}`,
        error: friendly,
      });
    } finally {
      clearTimeout(timer);
    }
  });




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

  app.post("/print-html", async (req, res) => {
    try {
      if (typeof options.printHtml !== "function") {
        return res.status(501).send("Este Agente não suporta impressão HTML silenciosa. Atualize o Agente Desktop.");
      }
      const hint = req.headers["x-printer"];
      const source = req.headers["x-printer-source"];
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const html = typeof body.html === "string" ? body.html : "";
      if (!html.trim()) return res.status(400).send("HTML vazio.");
      const printerName = typeof hint === "string"
        ? hint
        : (typeof body.printerName === "string" ? body.printerName : undefined);
      await options.printHtml({
        html,
        printerName,
        source: typeof source === "string" ? source : (typeof body.source === "string" ? body.source : null),
      });
      res.status(200).json({ ok: true, channel: "electron-html", printer: printerName || null, source: "windows" });
    } catch (e) {
      console.error("[agent] print-html error:", e);
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

  // ────────────────────────────────────────────────────────────────
  // NFC-e — Emissão direta SEFAZ (via node-dfe)
  // ────────────────────────────────────────────────────────────────
  /** Log estruturado de configuração fiscal — nunca imprime senha/CSC completos. */
  function logFiscal(event, detail) {
    const stamp = new Date().toISOString();
    console.log(`[agent][nfce:${event}] ${stamp} ${detail}`);
  }

  app.get("/nfce/config", (req, res) => {
    const from = req.headers["x-terminal-id"] || req.ip || "desconhecido";
    if (!nfce) {
      logFiscal("config:get", `terminal=${from} FALHA módulo NFC-e não carregado`);
      return res.status(501).json({ ok: false, error: "Módulo NFC-e não carregado no agente." });
    }
    const ready = nfce.isAvailable();
    const cfg = nfce.loadFiscalConfig();
    const validation = nfce.validateEngine ? nfce.validateEngine() : null;
    const failed = validation ? validation.checks.filter((c) => c.status === "fail").map((c) => c.key) : [];
    logFiscal(
      "config:get",
      `terminal=${from} engine_ready=${ready} cnpj=${cfg?.cnpj || "—"} uf=${cfg?.uf || "—"} ` +
        `ambiente=${cfg?.environment || "—"} cert=${cfg?.pfx_path ? "sim" : "não"} ` +
        `falhas=[${failed.join(",") || "nenhuma"}]`,
    );
    res.json({
      ok: true,
      engine_ready: ready,
      error: ready ? undefined : (nfce.engineError ? nfce.engineError() : "Motor NFC-e não carregado."),
      config: nfce.maskFiscalConfig(cfg),
      validation,
    });
  });

  app.post("/nfce/config", (req, res) => {
    const from = req.headers["x-terminal-id"] || req.ip || "desconhecido";
    if (!nfce) {
      logFiscal("config:post", `terminal=${from} FALHA motor NFC-e não carregado`);
      return res.status(501).json({ ok: false, error: "Motor NFC-e não carregado." });
    }
    try {
      const body = req.body || {};
      const current = nfce.loadFiscalConfig() || {};
      // Não sobrescreve senha com máscara vazia se o cliente não mandou nova.
      const merged = { ...current, ...body };
      if (!body.pfx_password) merged.pfx_password = current.pfx_password;
      // Campos alterados (sem valores sensíveis) — rastreabilidade de quem mudou o quê.
      const changed = Object.keys(body).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(body[k]));
      nfce.saveFiscalConfig(merged);
      logFiscal(
        "config:post",
        `terminal=${from} salvo cnpj=${merged.cnpj || "—"} uf=${merged.uf || "—"} ` +
          `ambiente=${merged.environment || "—"} campos=[${changed.join(",") || "nenhum"}] arquivo=${nfce.CONFIG_FILE}`,
      );
      const validation = nfce.validateEngine ? nfce.validateEngine() : null;
      res.json({ ok: true, config: nfce.maskFiscalConfig(merged), validation });
    } catch (e) {
      logFiscal("config:post", `terminal=${from} ERRO ${e.message}`);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Validação profunda do motor fiscal (node-dfe, certificado, config, UF).
  app.get("/nfce/engine", (_req, res) => {
    if (!nfce) return res.status(501).json({ ok: false, error: "Módulo NFC-e não carregado no agente." });
    try { res.json({ ok: true, ...nfce.validateEngine() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Instalação assistida do node-dfe (equivale a `npm run install:fiscal`).
  app.post("/nfce/engine/install", (_req, res) => {
    if (!nfce || !nfce.startEngineInstall) {
      return res.status(501).json({ ok: false, error: "Módulo NFC-e não carregado no agente." });
    }
    try {
      const r = nfce.startEngineInstall();
      logFiscal("engine:install", `iniciado alreadyRunning=${!!r.alreadyRunning}`);
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/nfce/engine/install", (_req, res) => {
    if (!nfce || !nfce.getInstallState) {
      return res.status(501).json({ ok: false, error: "Módulo NFC-e não carregado no agente." });
    }
    res.json({ ok: true, state: nfce.getInstallState() });
  });

  // Recarrega o node-dfe sem reiniciar o agente.
  app.post("/nfce/engine/reload", (_req, res) => {
    if (!nfce || !nfce.reloadEngine) {
      return res.status(501).json({ ok: false, error: "Módulo NFC-e não carregado no agente." });
    }
    const r = nfce.reloadEngine();
    logFiscal("engine:reload", `ok=${r.ok} ${r.error || ""}`);
    res.json({ ...r, validation: nfce.validateEngine() });
  });


  app.get("/nfce/certificate", (_req, res) => {
    if (!nfce) return res.status(501).json({ ok: false, error: "Motor NFC-e não carregado." });
    const cfg = nfce.loadFiscalConfig();
    if (!cfg?.pfx_path || !cfg?.pfx_password) return res.status(400).json({ ok: false, error: "Certificado não configurado." });
    res.json(nfce.inspectCertificate(cfg.pfx_path, cfg.pfx_password));
  });

  app.get("/nfce/status", async (_req, res) => {
    if (!nfce) return res.status(501).json({ ok: false, error: "Motor NFC-e não carregado." });
    try { res.json(await nfce.statusServico()); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/nfce/emit", async (req, res) => {
    if (!nfce) return res.status(501).json({ ok: false, error: "Motor NFC-e não carregado. Instale node-dfe na pasta do agente." });
    try {
      const started = Date.now();
      const result = await nfce.emitNFCe(req.body || {});
      res.status(result.ok ? 200 : 502).json({ ...result, elapsed_ms: Date.now() - started });
    } catch (e) {
      console.error("[agent] nfce/emit:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/nfce/cancel", async (req, res) => {
    if (!nfce) return res.status(501).json({ ok: false, error: "Motor NFC-e não carregado." });
    try { res.json(await nfce.cancelNFCe(req.body || {})); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/nfce/inutilizar", async (req, res) => {
    if (!nfce) return res.status(501).json({ ok: false, error: "Motor NFC-e não carregado." });
    try { res.json(await nfce.inutilizarFaixa(req.body || {})); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ────────────────────────────────────────────────────────────────
  // TEF — pagamento com cartão via PIN Pad (multiprovedor por plugins)
  // O PDV nunca acessa USB/DLL: só fala com estes endpoints.
  // ────────────────────────────────────────────────────────────────
  const requireTef = (res) => {
    if (!tef) { res.status(501).json({ ok: false, error: "Módulo TEF não carregado no agente." }); return false; }
    return true;
  };

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      platform: process.platform,
      nfce: nfce?.isAvailable() ? "ready" : "off",
      tef: tef ? tef.getStatus() : { ok: false, error: "off" },
      scale: scale ? { available: scale.isAvailable(), connected: scale.getStatus().connected } : { available: false },
      uptime_s: Math.floor(process.uptime()),
    });
  });

  app.get("/devices", async (_req, res) => {
    const printers = listAllPrinters();
    const tefDevices = tef ? await tef.getDevices() : { devices: [] };
    res.json({ ok: true, printers, tef: tefDevices.devices ?? [], drawer: { available: printers.length > 0 } });
  });

  // ────────────────────────────────────────────────────────────────
  // BALANÇA SERIAL — Toledo Prix e compatíveis (Filizola, Urano, Elgin…)
  // ────────────────────────────────────────────────────────────────
  const requireScale = (res) => {
    if (!scale) { res.status(501).json({ ok: false, error: "Módulo de balança não carregado no agente." }); return false; }
    return true;
  };

  app.get("/scale/ports", async (_req, res) => {
    if (!requireScale(res)) return;
    res.json({
      ok: true,
      available: scale.isAvailable(),
      reason: scale.unavailableReason(),
      ports: await scale.listPorts(),
      presets: scale.PRESETS,
      config: scale.loadConfig(),
    });
  });

  app.get("/scale/config", (_req, res) => {
    if (!requireScale(res)) return;
    res.json({ ok: true, config: scale.loadConfig(), presets: scale.PRESETS });
  });

  app.post("/scale/config", (req, res) => {
    if (!requireScale(res)) return;
    try { res.json({ ok: true, config: scale.saveConfig(req.body || {}) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/scale/status", (_req, res) => {
    if (!requireScale(res)) return;
    res.json(scale.getStatus());
  });

  app.post("/scale/connect", async (req, res) => {
    if (!requireScale(res)) return;
    try { res.json(await scale.connect(req.body || {})); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/scale/disconnect", (_req, res) => {
    if (!requireScale(res)) return;
    res.json(scale.disconnect());
  });

  app.get("/scale/read", async (req, res) => {
    if (!requireScale(res)) return;
    try {
      const reading = await scale.readWeight({ timeoutMs: Number(req.query.timeout) || undefined });
      res.json({ ok: true, ...reading });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/scale/test", async (req, res) => {
    if (!requireScale(res)) return;
    res.json(await scale.test(req.body || {}));
  });

  // Varredura automática de portas COM/tty procurando a balança.
  // Pode demorar (n portas × combinações); o cliente usa timeout alto.
  app.post("/scale/autodetect", async (req, res) => {
    if (!requireScale(res)) return;
    try { res.json(await scale.autodetect(req.body || {})); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ────────────────────────────────────────────────────────────────
  // DIAGNÓSTICO — visão única do ambiente para suporte no caixa
  // ────────────────────────────────────────────────────────────────
  app.get("/diagnostics", async (_req, res) => {
    const printers = listAllPrinters();
    let scaleInfo = { loaded: false };
    if (scale) {
      const st = scale.getStatus();
      scaleInfo = {
        loaded: true,
        driverInstalled: scale.isAvailable(),
        reason: scale.unavailableReason(),
        connected: st.connected,
        config: st.config,
        lastError: st.lastError,
        ports: await scale.listPorts(),
      };
    }

    res.json({
      ok: true,
      version: VERSION,
      system: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        hostname: os.hostname(),
        node: process.versions.node,
        elevated: isElevated(),
        uptime_s: Math.floor(process.uptime()),
        dataDir: DATA_DIR_PATH,
        dataDirWritable: isDataDirWritable(),
      },
      modules: {
        spooler: !!nodePrinter || process.platform === "win32",
        usb: hasUsbModule(),
        scale: scale ? scale.isAvailable() : false,
        nfce: nfce ? nfce.isAvailable() : false,
        tef: !!tef,
      },
      printers,
      scale: scaleInfo,
      tef: tef ? tef.getStatus() : { ok: false, error: "Módulo TEF não carregado." },
      nfce: nfce
        ? {
            available: nfce.isAvailable(),
            config: nfce.maskFiscalConfig(nfce.loadFiscalConfig()),
            validation: nfce.validateEngine ? nfce.validateEngine() : null,
            install: nfce.getInstallState ? nfce.getInstallState() : null,
          }
        : { available: false },
    });
  });



  app.get("/tef/providers", (_req, res) => {
    if (!requireTef(res)) return;
    res.json({ ok: true, providers: tef.listProviders(), config: tef.loadConfig() });
  });

  app.get("/tef/config", (_req, res) => {
    if (!requireTef(res)) return;
    res.json({ ok: true, config: tef.loadConfig() });
  });

  app.post("/tef/config", (req, res) => {
    if (!requireTef(res)) return;
    try { res.json({ ok: true, config: tef.saveConfig(req.body || {}) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/tef/status", (_req, res) => {
    if (!requireTef(res)) return;
    res.json(tef.getStatus());
  });

  app.get("/tef/log", (req, res) => {
    if (!requireTef(res)) return;
    res.json({ ok: true, entries: tef.readLog(Number(req.query.limit || 100)) });
  });

  // Stream de eventos do fluxo (SSE — funciona no navegador e no PWA).
  app.get("/tef/events", (req, res) => {
    if (!requireTef(res)) return;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* noop */ } };
    send({ state: "idle", at: new Date().toISOString(), hello: true });
    tef.bus.on("event", send);
    const ka = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch { /* noop */ } }, 15000);
    req.on("close", () => { clearInterval(ka); tef.bus.off("event", send); });
  });

  app.post("/tef/sale", async (req, res) => {
    if (!requireTef(res)) return;
    try {
      const body = req.body || {};
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "Valor inválido." });
      const paymentType = body.paymentType === "credit" ? "credit" : "debit";
      const installments = Math.max(1, Math.trunc(Number(body.installments || 1)));
      const result = await tef.startSale({ ...body, amount, paymentType, installments });
      res.status(result.success ? 200 : 402).json({ ok: result.success, ...result });
    } catch (e) {
      console.error("[agent] tef/sale:", e.message);
      res.status(500).json({ ok: false, status: "ERROR", error: e.message, code: e.code || null });
    }
  });

  app.post("/tef/cancel", async (req, res) => {
    if (!requireTef(res)) return;
    try { res.json({ ok: true, ...(await tef.cancelSale(req.body || {})) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/tef/reprint", async (req, res) => {
    if (!requireTef(res)) return;
    try { res.json(await tef.reprintReceipt(req.body || {})); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`[bastion-agent] http://127.0.0.1:${PORT} · v${VERSION} · spooler=${!!nodePrinter || process.platform === "win32"} usb=true nfce=${nfce?.isAvailable() ? "ready" : "off"} tef=${tef ? tef.loadConfig().provider : "off"}`);
  });

  return server;
}

if (require.main === module) startAgent();
module.exports = { startAgent };
