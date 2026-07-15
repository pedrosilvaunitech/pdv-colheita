/**
 * Wrapper Electron do Bastion POS.
 *
 * Recursos:
 *  - Agente de Impressão Local embutido (127.0.0.1:9100)
 *  - Janela kiosk com URL do PDV configurável
 *  - Validação de config.json com relatório de problemas
 *  - Logs persistidos em %APPDATA%/BastionPOSAgent/logs/
 *  - Auto-criação de config.json ao lado do .exe na primeira execução
 *  - Fallback automático para URL secundária quando a primária falha
 *
 * Config (`config.json` ao lado do binário):
 *   {
 *     "url": "https://pdv-colheita.lovable.app/pdv?kiosk=1",
 *     "fallbackUrl": "https://pdv-colheita.lovable.app/pdv?kiosk=1&fb=1",
 *     "kiosk": true,
 *     "startMinimized": false
 *   }
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { startAgent } = require("./agent.cjs");

let mainWindow = null;
let tray = null;
let agentServer = null;
let currentCfg = null;
let usingFallback = false;

// ────────────────────────────────────────────────────────────────────
// LOGS: arquivo diário em %APPDATA%/BastionPOSAgent/logs/
// ────────────────────────────────────────────────────────────────────
function getLogDir() {
  const base = app.getPath("userData");
  const dir = path.join(base, "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function getLogFile() {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(getLogDir(), `app-${iso}.log`);
}
function fmtLog(level, args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => {
    if (a instanceof Error) return `${a.message}\n${a.stack || ""}`;
    if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(" ");
  return `[${ts}] [${level}] ${msg}\n`;
}
function installFileLogger() {
  const file = getLogFile();
  let stream;
  try { stream = fs.createWriteStream(file, { flags: "a" }); }
  catch (e) { console.warn("[main] não foi possível abrir arquivo de log:", e); return; }
  const wrap = (level, orig) => (...args) => {
    try { stream.write(fmtLog(level, args)); } catch {}
    orig.apply(console, args);
  };
  console.log = wrap("INFO", console.log);
  console.warn = wrap("WARN", console.warn);
  console.error = wrap("ERROR", console.error);
  console.log(`[main] logs em: ${file}`);
  process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
  process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
}

// ────────────────────────────────────────────────────────────────────
// CONFIG: parse tolerante + validação + auto-criação
// ────────────────────────────────────────────────────────────────────
function stripJsonComments(txt) {
  let out = "", i = 0, inStr = false, strCh = "", inBlock = false, inLine = false;
  while (i < txt.length) {
    const c = txt[i], n = txt[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } i++; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i += 2; } else { i++; } continue; }
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < txt.length) { out += txt[i + 1]; i += 2; continue; }
      if (c === strCh) inStr = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { inLine = true; i += 2; continue; }
    if (c === "/" && n === "*") { inBlock = true; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const DEFAULT_CONFIG = {
  url: "https://pdv-colheita.lovable.app/pdv?kiosk=1",
  fallbackUrl: "https://pdv-colheita.lovable.app/pdv?kiosk=1",
  kiosk: false,
  startMinimized: false,
};

/**
 * Valida o objeto de config, retornando { cfg, issues }.
 * `issues` = lista de problemas para exibir ao operador.
 */
function validateConfig(raw) {
  const issues = [];
  const cfg = { ...DEFAULT_CONFIG, ...(raw || {}) };

  if (typeof cfg.url !== "string" || !cfg.url.trim()) {
    issues.push("Campo 'url' ausente — usando URL padrão.");
    cfg.url = DEFAULT_CONFIG.url;
  } else {
    try {
      const u = new URL(cfg.url);
      if (!/^https?:$/.test(u.protocol)) issues.push(`Protocolo inválido em 'url' (${u.protocol}). Use http/https.`);
    } catch { issues.push(`URL malformada: ${cfg.url}. Usando padrão.`); cfg.url = DEFAULT_CONFIG.url; }
  }

  if (cfg.fallbackUrl) {
    try { new URL(cfg.fallbackUrl); }
    catch { issues.push(`fallbackUrl malformada: ${cfg.fallbackUrl}. Ignorada.`); cfg.fallbackUrl = null; }
  }

  if (typeof cfg.kiosk !== "boolean") { issues.push(`'kiosk' deveria ser boolean; recebido ${typeof cfg.kiosk}. Assumindo false.`); cfg.kiosk = false; }
  if (typeof cfg.startMinimized !== "boolean") cfg.startMinimized = false;

  return { cfg, issues };
}

/**
 * Cria config.json ao lado do binário se ainda não existir.
 * Facilita a primeira execução sem exigir intervenção manual.
 */
function ensureConfigFile() {
  const target = path.join(path.dirname(app.getPath("exe")), "config.json");
  if (fs.existsSync(target)) return target;
  try {
    const tmpl = {
      url: DEFAULT_CONFIG.url,
      fallbackUrl: DEFAULT_CONFIG.fallbackUrl,
      kiosk: true,
      startMinimized: false,
      _comment: "Edite este arquivo para alterar a URL do PDV. Reinicie o app após salvar.",
    };
    fs.writeFileSync(target, JSON.stringify(tmpl, null, 2), "utf8");
    console.log("[main] config.json criado automaticamente em:", target);
    return target;
  } catch (e) {
    console.warn("[main] não foi possível criar config.json em", target, e && e.message);
    return null;
  }
}

function loadConfig() {
  const candidates = [
    path.join(path.dirname(app.getPath("exe")), "config.json"),
    path.join(process.resourcesPath || "", "config.json"),
    path.join(__dirname, "config.json"),
  ];
  let raw = null;
  const parseIssues = [];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const txt = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
        raw = JSON.parse(stripJsonComments(txt));
        console.log("[main] config carregado de:", p);
        break;
      }
    } catch (e) {
      const msg = `config.json em ${p} inválido: ${e && e.message}`;
      console.warn("[main]", msg);
      parseIssues.push(msg);
    }
  }
  if (!raw) {
    console.log("[main] nenhum config.json encontrado — criando padrão");
    ensureConfigFile();
  }
  const { cfg, issues } = validateConfig(raw);
  const allIssues = [...parseIssues, ...issues];
  if (allIssues.length) console.warn("[main] problemas de config:", allIssues);
  cfg.__issues = allIssues;
  cfg.__envUrl = process.env.BASTION_URL || null;
  if (cfg.__envUrl) { console.log("[main] BASTION_URL sobrescrevendo config:", cfg.__envUrl); cfg.url = cfg.__envUrl; }
  return cfg;
}

// ────────────────────────────────────────────────────────────────────
// UI: telas de erro / info
// ────────────────────────────────────────────────────────────────────
function showErrorPage(win, url, code, description, opts = {}) {
  const { hasFallback, triedFallback } = opts;
  const fbBtn = hasFallback && !triedFallback
    ? `<button onclick="location.href='bastion://fallback'">Tentar URL de fallback</button>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bastion POS</title>
  <style>
    body{margin:0;background:#0a0a0a;color:#e5e5e5;font-family:system-ui,Segoe UI,sans-serif;
      display:flex;align-items:center;justify-content:center;height:100vh;padding:24px;box-sizing:border-box}
    .card{max-width:640px;background:#141414;border:1px solid #262626;border-radius:12px;padding:32px}
    h1{margin:0 0 8px;font-size:20px;color:#f87171}
    code{background:#1f1f1f;padding:2px 6px;border-radius:4px;color:#fbbf24}
    p{line-height:1.6;color:#a3a3a3}
    button{margin:12px 8px 0 0;background:#3b82f6;color:#fff;border:0;padding:10px 18px;border-radius:8px;
      font-size:13px;cursor:pointer}
    button:hover{background:#2563eb}
    .muted{background:#262626}
  </style></head><body>
  <div class="card">
    <h1>Falha ao carregar o PDV${triedFallback ? " (fallback também falhou)" : ""}</h1>
    <p><b>URL:</b> <code>${url}</code></p>
    <p><b>Erro (${code}):</b> ${description || "desconhecido"}</p>
    <p>Verifique a conexão de internet ou edite <code>config.json</code> ao lado do executável.
    Pressione <b>F5</b> para tentar novamente, <b>F12</b> para o DevTools ou <b>F9</b> para abrir os logs.</p>
    <button onclick="location.reload()">Tentar novamente</button>
    ${fbBtn}
  </div></body></html>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

function showConfigIssuesDialog(issues) {
  if (!issues || !issues.length) return;
  dialog.showMessageBox({
    type: "warning",
    title: "Bastion POS · Config",
    message: "Foram encontrados problemas na configuração",
    detail: issues.join("\n\n") + "\n\nO app continuou usando valores padrão.",
    buttons: ["OK"],
  }).catch(() => {});
}

// ────────────────────────────────────────────────────────────────────
// JANELA + FALLBACK
// ────────────────────────────────────────────────────────────────────
function loadUrlWithFallback(url) {
  console.log("[main] carregando URL:", url, usingFallback ? "(fallback)" : "");
  return mainWindow.loadURL(url).catch((e) => {
    console.error("[main] loadURL falhou:", e);
    triggerFallback(url, "load", String(e && e.message || e));
  });
}

function triggerFallback(failedUrl, code, desc) {
  if (!currentCfg) return;
  if (!usingFallback && currentCfg.fallbackUrl && currentCfg.fallbackUrl !== failedUrl) {
    console.warn("[main] alternando para fallback:", currentCfg.fallbackUrl);
    usingFallback = true;
    loadUrlWithFallback(currentCfg.fallbackUrl);
    return;
  }
  showErrorPage(mainWindow, failedUrl, code, desc, {
    hasFallback: !!currentCfg.fallbackUrl,
    triedFallback: usingFallback,
  });
}

function createWindow(cfg) {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1024, minHeight: 700,
    kiosk: !!cfg.kiosk,
    autoHideMenuBar: true,
    show: !cfg.startMinimized,
    backgroundColor: "#0a0a0a",
    icon: path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  loadUrlWithFallback(cfg.url);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, validatedURL) => {
    if (code === -3) return; // aborted
    console.error("[main] did-fail-load:", code, desc, validatedURL);
    triggerFallback(validatedURL || cfg.url, code, desc);
  });

  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("bastion://fallback") && currentCfg?.fallbackUrl) {
      e.preventDefault();
      usingFallback = true;
      loadUrlWithFallback(currentCfg.fallbackUrl);
    }
  });

  mainWindow.webContents.on("before-input-event", (_e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F12") mainWindow.webContents.toggleDevTools();
    if (input.key === "F5") { usingFallback = false; loadUrlWithFallback(currentCfg?.url || cfg.url); }
    if (input.key === "F11") mainWindow.setKiosk(!mainWindow.isKiosk());
    if (input.key === "F9") shell.openPath(getLogDir());
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("close", (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

function printHtmlSilently(job) {
  return new Promise((resolve, reject) => {
    const html = job && typeof job.html === "string" ? job.html : "";
    if (!html.trim()) return reject(new Error("HTML vazio."));
    const printerName = job && typeof job.printerName === "string" && job.printerName.trim()
      ? job.printerName.trim()
      : undefined;
    const win = new BrowserWindow({
      width: 420,
      height: 900,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let finished = false;
    const done = (err) => {
      if (finished) return;
      finished = true;
      try { win.close(); } catch {}
      if (err) reject(err);
      else resolve();
    };
    const timeout = setTimeout(() => done(new Error("Tempo esgotado ao renderizar a prévia para impressão.")), 25000);
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        win.webContents.print({
          silent: true,
          printBackground: true,
          deviceName: printerName,
          margins: { marginType: "none" },
        }, (success, failureReason) => {
          clearTimeout(timeout);
          if (!success) done(new Error(failureReason || "Falha na impressão HTML silenciosa."));
          else done(null);
        });
      }, 300);
    });
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html)).catch((e) => {
      clearTimeout(timeout);
      done(e);
    });
  });
}

// ────────────────────────────────────────────────────────────────────
// TRAY
// ────────────────────────────────────────────────────────────────────
function createTray() {
  try {
    const iconPath = path.join(__dirname, "assets", process.platform === "win32" ? "tray.ico" : "tray.png");
    const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    tray = new Tray(image);
    tray.setToolTip("Bastion POS Agent · Impressão local em 127.0.0.1:9100");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Abrir PDV", click: () => mainWindow?.show() },
      { label: "Sair do modo kiosk (F11)", click: () => mainWindow?.setKiosk(!mainWindow.isKiosk()) },
      { type: "separator" },
      { label: "Recarregar URL primária", click: () => {
        usingFallback = false;
        if (currentCfg) loadUrlWithFallback(currentCfg.url);
      }},
      { label: "Forçar URL de fallback", enabled: !!currentCfg?.fallbackUrl, click: () => {
        usingFallback = true;
        if (currentCfg?.fallbackUrl) loadUrlWithFallback(currentCfg.fallbackUrl);
      }},
      { type: "separator" },
      { label: "Abrir pasta de logs (F9)", click: () => shell.openPath(getLogDir()) },
      { label: "Abrir config.json", click: () => {
        const p = path.join(path.dirname(app.getPath("exe")), "config.json");
        if (fs.existsSync(p)) shell.openPath(p);
        else dialog.showErrorBox("config.json", `Não encontrado em:\n${p}`);
      }},
      { label: "Diagnóstico do agente", click: async () => {
        try {
          const res = await fetch("http://127.0.0.1:9100/status");
          const j = await res.json();
          dialog.showMessageBox({ type: "info", title: "Agente", message: JSON.stringify(j, null, 2) });
        } catch (e) { dialog.showErrorBox("Agente offline", String(e)); }
      }},
      { type: "separator" },
      { label: "Sair", click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on("click", () => mainWindow?.show());
  } catch (e) { console.warn("[main] tray falhou:", e); }
}

// ────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  installFileLogger();
  currentCfg = loadConfig();
  try { agentServer = startAgent({ printHtml: printHtmlSilently }); }
  catch (e) { console.error("[main] falha ao iniciar agente:", e); dialog.showErrorBox("Falha ao iniciar agente", String(e)); }
  createWindow(currentCfg);
  createTray();
  if (currentCfg.__issues?.length) showConfigIssuesDialog(currentCfg.__issues);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(currentCfg);
    else mainWindow?.show();
  });
});

app.on("window-all-closed", (e) => { e.preventDefault(); /* mantém tray */ });
app.on("before-quit", () => {
  app.isQuitting = true;
  try { agentServer?.close(); } catch {}
});
