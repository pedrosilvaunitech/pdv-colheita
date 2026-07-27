/**
 * Balança serial (Toledo Prix e compatíveis) no Agente Local.
 *
 * O navegador só consegue falar com balança serial via Web Serial (Chromium
 * desktop, com prompt de porta e HTTPS). No caixa isso é frágil: PWA em modo
 * kiosk, conversores USB-Serial e Windows costumam bloquear. Por isso o
 * agente expõe a balança por HTTP local — funciona em qualquer navegador.
 *
 * Protocolos suportados:
 *   prix3     → fluxo contínuo (STX ..... ETX ou linha CR/LF)
 *   prix4-p0  → host envia ENQ (0x05) e recebe STX PPPPP ETX
 *   prix4-p1  → ENQ com resposta estendida (peso + tara + status)
 *   generic   → heurística: primeira sequência de 5-6 dígitos
 *
 * A dependência `serialport` é OPCIONAL: se não estiver instalada o módulo
 * reporta indisponibilidade com instrução, sem derrubar o agente.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

let SerialPortLib = null;
let loadError = null;
try {
  // eslint-disable-next-line global-require
  SerialPortLib = require("serialport").SerialPort;
} catch (e) {
  loadError = e;
}

const DATA_DIR = path.join(os.homedir(), ".bastion-pos");
const CONFIG_FILE = path.join(DATA_DIR, "scale-config.json");

const STX = 0x02;
const ETX = 0x03;
const ENQ = 0x05;

const DEFAULT_CONFIG = {
  enabled: false,
  path: "", // COM3, /dev/ttyUSB0, …
  protocol: "prix4-p0", // prix3 | prix4-p0 | prix4-p1 | generic
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: "none", // none | even | odd
  requestTimeoutMs: 2000,
  autoConnect: true,
};

/** Modelos comuns no varejo brasileiro e seus presets de porta. */
const PRESETS = [
  { id: "toledo-prix-4", label: "Toledo Prix 4 / 5 (Protocolo 0)", protocol: "prix4-p0", baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none" },
  { id: "toledo-prix-4-p1", label: "Toledo Prix 4 / 5 (Protocolo 1)", protocol: "prix4-p1", baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none" },
  { id: "toledo-prix-3", label: "Toledo Prix 3 (contínuo)", protocol: "prix3", baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none" },
  { id: "filizola", label: "Filizola / Platina (contínuo)", protocol: "prix3", baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none" },
  { id: "urano", label: "Urano POP / UDC", protocol: "generic", baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none" },
  { id: "elgin-dp", label: "Elgin DP / SA110", protocol: "generic", baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none" },
  { id: "micheletti", label: "Micheletti MIC", protocol: "generic", baudRate: 4800, dataBits: 8, stopBits: 1, parity: "none" },
  { id: "welmy", label: "Welmy W200", protocol: "generic", baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none" },
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(patch) {
  ensureDataDir();
  const merged = { ...loadConfig(), ...(patch || {}) };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  // Qualquer mudança de porta/protocolo derruba a conexão atual.
  closePort();
  return merged;
}

function isAvailable() {
  return !!SerialPortLib;
}

function unavailableReason() {
  if (SerialPortLib) return null;
  return `Driver serial não instalado no agente (npm i serialport). Detalhe: ${loadError ? loadError.message : "módulo ausente"}`;
}

async function listPorts() {
  if (!SerialPortLib) return [];
  try {
    const ports = await SerialPortLib.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || null,
      serialNumber: p.serialNumber || null,
      vendorId: p.vendorId || null,
      productId: p.productId || null,
      friendly: p.friendlyName || p.pnpId || p.path,
    }));
  } catch {
    return [];
  }
}

/* ------------------------------- parsing -------------------------------- */

function parseWeightBlock(block) {
  const trimmed = String(block || "").trim();
  if (/^[I?]{4,6}$/.test(trimmed)) return { kg: 0, status: "overload" };
  if (/^[-S]{4,6}$/.test(trimmed)) return { kg: 0, status: "unstable" };
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 5) return { kg: 0, status: "unknown" };
  const grams = Number(digits.slice(0, digits.length >= 6 ? 6 : 5));
  if (!Number.isFinite(grams)) return { kg: 0, status: "unknown" };
  const kg = grams / 1000;
  return { kg, status: kg === 0 ? "zero" : "ok" };
}

function parseFrame(buf, protocol) {
  let start = -1;
  let end = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === STX && start === -1) start = i + 1;
    else if (buf[i] === ETX && start !== -1) { end = i; break; }
  }
  let payload;
  if (start !== -1 && end !== -1) payload = buf.slice(start, end).toString("latin1");
  else payload = buf.toString("latin1").replace(/[\r\n\x00-\x1f]/g, " ").trim();
  if (!payload) return null;

  if (protocol === "prix4-p0" || protocol === "prix4-p1") {
    const r = parseWeightBlock(payload.slice(0, protocol === "prix4-p1" ? 6 : 5));
    return { weightKg: r.kg, status: r.status, raw: payload, at: Date.now() };
  }
  const m = payload.match(/([I?]{4,6}|[-S]{4,6}|\d{5,6})/);
  if (!m) return null;
  const r = parseWeightBlock(m[1]);
  return { weightKg: r.kg, status: r.status, raw: payload, at: Date.now() };
}

/* ------------------------------ conexão --------------------------------- */

let port = null;
let buffer = Buffer.alloc(0);
let lastReading = null;
let lastError = null;
let pending = [];

function emitReading(reading) {
  lastReading = reading;
  const waiting = pending;
  pending = [];
  for (const resolve of waiting) resolve(reading);
}

function drain(protocol) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const stx = buffer.indexOf(STX);
    const etx = stx >= 0 ? buffer.indexOf(ETX, stx) : -1;
    if (stx === -1 || etx === -1) {
      const nl = buffer.findIndex((b) => b === 0x0a || b === 0x0d);
      if (nl === -1) return;
      const frame = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (frame.length >= 5) {
        const r = parseFrame(frame, protocol);
        if (r) emitReading(r);
      }
      continue;
    }
    const frame = buffer.slice(stx, etx + 1);
    buffer = buffer.slice(etx + 1);
    const r = parseFrame(frame, protocol);
    if (r) emitReading(r);
  }
}

function closePort() {
  try { if (port && port.isOpen) port.close(); } catch { /* noop */ }
  port = null;
  buffer = Buffer.alloc(0);
}

function openPort(cfgOverride) {
  const cfg = { ...loadConfig(), ...(cfgOverride || {}) };
  if (!SerialPortLib) throw new Error(unavailableReason());
  if (!cfg.path) throw new Error("Nenhuma porta serial configurada para a balança.");
  if (port && port.isOpen) return Promise.resolve(cfg);

  return new Promise((resolve, reject) => {
    const p = new SerialPortLib(
      {
        path: cfg.path,
        baudRate: Number(cfg.baudRate) || 9600,
        dataBits: Number(cfg.dataBits) || 8,
        stopBits: Number(cfg.stopBits) || 1,
        parity: cfg.parity || "none",
        autoOpen: false,
      },
    );
    p.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) buffer = buffer.slice(-1024);
      drain(cfg.protocol);
    });
    p.on("error", (e) => { lastError = e.message; });
    p.on("close", () => { port = null; });
    p.open((err) => {
      if (err) { lastError = err.message; reject(new Error(friendlyOpenError(err.message, cfg.path))); return; }
      port = p;
      lastError = null;
      resolve(cfg);
    });
  });
}

function friendlyOpenError(message, portPath) {
  if (/access denied|EACCES/i.test(message)) {
    return `Acesso negado à porta ${portPath}. Feche outros programas que usam a balança (software da balança, PDV antigo) e no Linux adicione o usuário ao grupo "dialout".`;
  }
  if (/no such file|ENOENT|cannot open/i.test(message)) {
    return `Porta ${portPath} não existe. Verifique o cabo USB-Serial e o driver (Prolific/FTDI/CH340) no Gerenciador de Dispositivos.`;
  }
  return `Falha ao abrir ${portPath}: ${message}`;
}

async function connect(cfgOverride) {
  const cfg = await openPort(cfgOverride);
  return { ok: true, path: cfg.path, protocol: cfg.protocol, baudRate: cfg.baudRate };
}

function disconnect() {
  closePort();
  return { ok: true };
}

function getStatus() {
  const cfg = loadConfig();
  return {
    ok: true,
    available: isAvailable(),
    reason: unavailableReason(),
    connected: !!(port && port.isOpen),
    config: cfg,
    lastReading,
    lastError,
  };
}

/** Solicita uma pesagem. Em prix4 envia ENQ; nos contínuos aguarda o frame. */
async function readWeight(opts = {}) {
  const cfg = { ...loadConfig(), ...(opts.config || {}) };
  if (!port || !port.isOpen) await openPort(cfg);
  const timeoutMs = Number(opts.timeoutMs || cfg.requestTimeoutMs) || 2000;

  if (cfg.protocol === "prix4-p0" || cfg.protocol === "prix4-p1") {
    await new Promise((resolve, reject) => {
      port.write(Buffer.from([ENQ]), (err) => (err ? reject(new Error(err.message)) : resolve(null)));
    });
  }

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending = pending.filter((fn) => fn !== onRead);
      reject(new Error(
        "A balança não respondeu no tempo esperado. Confira protocolo, baud rate e o cabo serial.",
      ));
    }, timeoutMs);
    const onRead = (reading) => { clearTimeout(timer); resolve(reading); };
    pending.push(onRead);
  });
}

/** Diagnóstico: tenta abrir, ler e devolver um relatório legível. */
async function test(cfgOverride) {
  const started = Date.now();
  try {
    await connect(cfgOverride);
    const reading = await readWeight({ config: cfgOverride, timeoutMs: 3000 });
    return { ok: true, elapsedMs: Date.now() - started, reading };
  } catch (e) {
    return { ok: false, elapsedMs: Date.now() - started, error: e.message };
  }
}

function autoStart() {
  const cfg = loadConfig();
  if (!cfg.enabled || !cfg.autoConnect || !cfg.path || !SerialPortLib) return;
  openPort(cfg).catch((e) => console.warn("[scale] auto-connect falhou:", e.message));
}

/* --------------------------- auto-detecção ------------------------------ */

/**
 * Combinações testadas na varredura. A ordem importa: começamos pelo que é
 * mais comum no varejo brasileiro (Toledo Prix 4 @ 9600 8N1) para encerrar a
 * varredura o mais cedo possível — cada tentativa custa ~1,2s por porta.
 */
const PROBE_MATRIX = [
  { protocol: "prix4-p0", baudRate: 9600, parity: "none", dataBits: 8, stopBits: 1 },
  { protocol: "prix3", baudRate: 9600, parity: "none", dataBits: 8, stopBits: 1 },
  { protocol: "prix4-p1", baudRate: 9600, parity: "none", dataBits: 8, stopBits: 1 },
  { protocol: "generic", baudRate: 9600, parity: "none", dataBits: 8, stopBits: 1 },
  { protocol: "prix4-p0", baudRate: 4800, parity: "none", dataBits: 8, stopBits: 1 },
  { protocol: "generic", baudRate: 4800, parity: "none", dataBits: 8, stopBits: 1 },
  { protocol: "prix4-p0", baudRate: 19200, parity: "none", dataBits: 8, stopBits: 1 },
  { protocol: "prix3", baudRate: 2400, parity: "none", dataBits: 7, stopBits: 1 },
  { protocol: "prix4-p0", baudRate: 9600, parity: "even", dataBits: 7, stopBits: 1 },
];

/** Fabricantes típicos de conversor USB-Serial usados em balanças. */
const SERIAL_HINTS = /prolific|ftdi|ch340|ch341|cp210|silicon labs|pl2303|usb.?serial|toledo|filizola|urano|elgin/i;

function scorePort(p) {
  let score = 0;
  const hay = `${p.manufacturer || ""} ${p.friendly || ""} ${p.path || ""}`;
  if (SERIAL_HINTS.test(hay)) score += 10;
  if (p.vendorId) score += 2; // porta física USB > porta virtual (bluetooth)
  if (/bluetooth|virtual/i.test(hay)) score -= 8;
  return score;
}

/**
 * Abre uma instância isolada da porta (não mexe na conexão global) e tenta
 * obter UMA leitura válida. Resolve `null` quando não houver resposta —
 * falha de sondagem NÃO é erro fatal, apenas descarta a combinação.
 */
function probeCombo(portPath, combo, timeoutMs) {
  if (!SerialPortLib) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    let p = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (p && p.isOpen) p.close(() => {}); } catch { /* noop */ }
      resolve(result);
    };

    try {
      p = new SerialPortLib({
        path: portPath,
        baudRate: Number(combo.baudRate),
        dataBits: Number(combo.dataBits) || 8,
        stopBits: Number(combo.stopBits) || 1,
        parity: combo.parity || "none",
        autoOpen: false,
      });
    } catch (e) {
      finish({ error: e.message });
      return;
    }

    p.on("error", (e) => finish({ error: e.message }));
    p.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 2048) buf = buf.slice(-512);
      const reading = parseFrame(buf, combo.protocol);
      // Só aceitamos leituras plausíveis: descarta lixo de porta errada.
      if (reading && reading.status !== "unknown" && reading.weightKg < 500) {
        finish({ reading });
      }
    });

    p.open((err) => {
      if (err) { finish({ error: friendlyOpenError(err.message, portPath) }); return; }
      if (combo.protocol === "prix4-p0" || combo.protocol === "prix4-p1") {
        // Protocolo por requisição: precisa do ENQ, repetido para o caso de
        // a balança estar iniciando o firmware.
        const poll = () => { try { p.write(Buffer.from([ENQ])); } catch { /* noop */ } };
        poll();
        setTimeout(poll, 400);
        setTimeout(poll, 800);
      }
      timer = setTimeout(() => finish(null), timeoutMs);
    });
  });
}

/**
 * Varre todas as portas seriais tentando descobrir onde está a balança e com
 * qual protocolo/baud ela fala. Retorna candidatos ordenados; `applied: true`
 * quando a melhor combinação foi persistida na configuração.
 */
async function autodetect(opts = {}) {
  if (!SerialPortLib) {
    return { ok: false, available: false, error: unavailableReason(), candidates: [], attempts: [] };
  }

  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 1200, 400), 4000);
  const apply = opts.apply !== false;
  const all = await listPorts();
  const only = Array.isArray(opts.ports) && opts.ports.length ? opts.ports : null;
  const ports = (only ? all.filter((p) => only.includes(p.path)) : all)
    .sort((a, b) => scorePort(b) - scorePort(a));

  if (!ports.length) {
    return {
      ok: false,
      available: true,
      error: "Nenhuma porta serial encontrada. Conecte o cabo USB-Serial e instale o driver (Prolific/FTDI/CH340).",
      candidates: [],
      attempts: [],
    };
  }

  // Sondar exige a porta livre: derruba a conexão atual e reabre no fim.
  const previous = loadConfig();
  const wasConnected = !!(port && port.isOpen);
  closePort();

  const attempts = [];
  const candidates = [];

  try {
    for (const p of ports) {
      let portFailed = null;
      for (const combo of PROBE_MATRIX) {
        // eslint-disable-next-line no-await-in-loop
        const r = await probeCombo(p.path, combo, timeoutMs);
        const label = `${p.path} · ${combo.protocol} · ${combo.baudRate} ${combo.dataBits}${(combo.parity || "none")[0].toUpperCase()}${combo.stopBits}`;
        if (r && r.reading) {
          attempts.push({ ...combo, path: p.path, label, ok: true, weightKg: r.reading.weightKg, raw: r.reading.raw });
          candidates.push({
            path: p.path,
            friendly: p.friendly,
            manufacturer: p.manufacturer,
            protocol: combo.protocol,
            baudRate: combo.baudRate,
            dataBits: combo.dataBits,
            stopBits: combo.stopBits,
            parity: combo.parity,
            reading: r.reading,
            score: scorePort(p) + (combo.protocol === "prix4-p0" ? 2 : 0),
          });
          break; // achou nesta porta: não testa mais combinações nela
        }
        attempts.push({ ...combo, path: p.path, label, ok: false, error: r?.error || "sem resposta" });
        if (r && r.error && /acesso negado|access denied|em uso|busy/i.test(r.error)) {
          portFailed = r.error;
          break; // porta ocupada: nenhuma combinação vai funcionar
        }
      }
      if (portFailed) continue;
    }
  } finally {
    // Restaura a conexão anterior se a varredura não vai aplicar nada.
    if (wasConnected && previous.path && !candidates.length) {
      openPort(previous).catch(() => {});
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] || null;

  let config = previous;
  if (best && apply) {
    config = saveConfig({
      enabled: true,
      path: best.path,
      protocol: best.protocol,
      baudRate: best.baudRate,
      dataBits: best.dataBits,
      stopBits: best.stopBits,
      parity: best.parity,
    });
    try { await openPort(config); } catch { /* usuário conecta manualmente */ }
  }

  return {
    ok: !!best,
    available: true,
    applied: !!best && apply,
    scannedPorts: ports.length,
    candidates,
    attempts,
    config,
    error: best
      ? null
      : "Nenhuma balança respondeu. Verifique se ela está ligada, se o cabo é serial (não é apenas alimentação) e se nenhum outro programa está usando a porta.",
  };
}

module.exports = {
  DEFAULT_CONFIG, PRESETS, PROBE_MATRIX,
  isAvailable, unavailableReason, listPorts, loadConfig, saveConfig,
  connect, disconnect, getStatus, readWeight, test, autoStart, parseFrame,
  autodetect,
};

