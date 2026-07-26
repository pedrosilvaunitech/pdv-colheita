/**
 * TEF Driver Manager — carrega plugins dinamicamente, mantém o provedor ativo,
 * publica eventos de fluxo e registra log de auditoria de cada transação.
 *
 * O agente e o PDV nunca importam um plugin diretamente: tudo passa por aqui.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const PLUGINS_DIR = path.join(__dirname, "plugins");
const DATA_DIR = path.join(os.homedir(), ".bastion-pos");
const CONFIG_FILE = path.join(DATA_DIR, "tef-config.json");
const LOG_FILE = path.join(DATA_DIR, "tef-transactions.log");

const DEFAULT_CONFIG = {
  provider: "generic",
  timeout: 120000,
  autoReconnect: true,
  log: true,
  mode: "homologacao", // homologacao | producao
  simulateStepMs: 900,
  saleDefaults: {},
};

const bus = new EventEmitter();
bus.setMaxListeners(50);

let plugins = null;
let activeDriver = null;
let activeProviderId = null;
let currentTransaction = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(patch) {
  ensureDataDir();
  const merged = { ...loadConfig(), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  // Troca de provedor invalida o driver ativo.
  if (patch && patch.provider && patch.provider !== activeProviderId) disposeDriver();
  return merged;
}

/** Carrega todos os plugins da pasta `plugins/` (plug-and-play). */
function loadPlugins() {
  if (plugins) return plugins;
  plugins = new Map();
  let files = [];
  try { files = fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".cjs")); }
  catch { files = []; }
  for (const file of files) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(path.join(PLUGINS_DIR, file));
      if (mod && mod.meta && typeof mod.createDriver === "function") plugins.set(mod.meta.id, mod);
    } catch (e) {
      console.warn(`[tef] plugin ${file} falhou ao carregar:`, e.message);
    }
  }
  return plugins;
}

function emit(event) {
  bus.emit("event", event);
  if (currentTransaction) currentTransaction.states.push({ state: event.state, at: event.at });
}

function getDriver() {
  const cfg = loadConfig();
  if (activeDriver && activeProviderId === cfg.provider) return activeDriver;
  disposeDriver();
  const plugin = loadPlugins().get(cfg.provider);
  if (!plugin) throw new Error(`Provedor TEF "${cfg.provider}" não encontrado em plugins/.`);
  activeDriver = plugin.createDriver(cfg, emit);
  activeProviderId = cfg.provider;
  return activeDriver;
}

function disposeDriver() {
  try { if (activeDriver && typeof activeDriver.dispose === "function") activeDriver.dispose(); }
  catch { /* noop */ }
  activeDriver = null;
  activeProviderId = null;
}

function auditLog(entry) {
  if (!loadConfig().log) return;
  try {
    ensureDataDir();
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* log nunca derruba a venda */ }
}

/** Lista provedores + disponibilidade real do SDK. */
function listProviders() {
  const cfg = loadConfig();
  return [...loadPlugins().values()].map((p) => {
    let health = { available: false, reason: "Não avaliado" };
    try { health = p.createDriver(cfg, () => {}).healthCheck(); }
    catch (e) { health = { available: false, reason: e.message }; }
    return { ...p.meta, ...health, active: p.meta.id === cfg.provider };
  });
}

async function startSale(req) {
  const cfg = loadConfig();
  const driver = getDriver();
  const health = driver.healthCheck();
  if (!health.available) { auditLog({ kind: "sale", ok: false, provider: cfg.provider, error: health.reason }); throw new Error(health.reason); }

  currentTransaction = { orderId: req.orderId, startedAt: Date.now(), states: [] };
  const timeoutMs = Number(req.timeout ?? cfg.timeout);

  try {
    await driver.initialize();
    const result = await withTimeout(driver.startSale(req), timeoutMs, driver);
    auditLog({ kind: "sale", ok: result.success, provider: cfg.provider, result, operator: req.operator ?? null, terminal: req.terminal ?? null });
    return result;
  } catch (e) {
    auditLog({ kind: "sale", ok: false, provider: cfg.provider, orderId: req.orderId, error: e.message });
    throw e;
  } finally {
    currentTransaction = null;
  }
}

function withTimeout(promise, ms, driver) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(async () => {
      emit({ provider: activeProviderId, state: "timeout", at: new Date().toISOString() });
      try { await driver.cancelSale({ reason: "timeout" }); } catch { /* noop */ }
      reject(new Error("Tempo esgotado aguardando o PIN Pad."));
    }, ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function cancelSale(req) {
  const result = await getDriver().cancelSale(req || {});
  auditLog({ kind: "cancel", provider: activeProviderId, result });
  return result;
}

async function reprintReceipt(req) { return getDriver().reprintReceipt(req || {}); }

function getStatus() {
  const cfg = loadConfig();
  try {
    const driver = getDriver();
    return { ok: true, provider: cfg.provider, mode: cfg.mode, health: driver.healthCheck(), ...driver.getStatus() };
  } catch (e) {
    return { ok: false, provider: cfg.provider, mode: cfg.mode, state: "error", error: e.message };
  }
}

async function getDevices() {
  try { return await getDriver().getDevices(); }
  catch (e) { return { provider: activeProviderId, devices: [], error: e.message }; }
}

function readLog(limit = 100) {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

module.exports = {
  bus, loadConfig, saveConfig, listProviders, startSale, cancelSale,
  reprintReceipt, getStatus, getDevices, readLog, disposeDriver, DEFAULT_CONFIG,
};
