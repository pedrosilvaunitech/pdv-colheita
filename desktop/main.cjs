/**
 * Wrapper Electron do Bastion POS.
 *
 * - Sobe o Agente de Impressão Local em 127.0.0.1:9100 (embutido).
 * - Abre uma janela em modo kiosk carregando a URL publicada do PDV.
 * - Registra ícone na tray para iniciar minimizado com o sistema.
 *
 * Configuração via env / arquivo `config.json` ao lado do binário:
 *   { "url": "https://seuprojeto.lovable.app/pdv?kiosk=1", "kiosk": true }
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { startAgent } = require("./agent.cjs");

let mainWindow = null;
let tray = null;
let agentServer = null;

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

function loadConfig() {
  const defaults = {
    url: process.env.BASTION_URL || "https://pdv-colheita.lovable.app/pdv?kiosk=1",
    kiosk: false,
    startMinimized: false,
  };
  // Procura config.json em vários locais (dev, portátil, instalado)
  const candidates = [
    path.join(path.dirname(app.getPath("exe")), "config.json"),
    path.join(process.resourcesPath || "", "config.json"),
    path.join(__dirname, "config.json"),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
        const j = JSON.parse(stripJsonComments(raw));
        console.log("[main] config carregado de:", p);
        return { ...defaults, ...j };
      }
    } catch (e) { console.warn("[main] config.json inválido em", p, e && e.message); }
  }
  console.log("[main] usando URL padrão:", defaults.url);
  return defaults;
}

function showErrorPage(win, url, code, description) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bastion POS</title>
  <style>
    body{margin:0;background:#0a0a0a;color:#e5e5e5;font-family:system-ui,Segoe UI,sans-serif;
      display:flex;align-items:center;justify-content:center;height:100vh;padding:24px;box-sizing:border-box}
    .card{max-width:640px;background:#141414;border:1px solid #262626;border-radius:12px;padding:32px}
    h1{margin:0 0 8px;font-size:20px;color:#f87171}
    code{background:#1f1f1f;padding:2px 6px;border-radius:4px;color:#fbbf24}
    p{line-height:1.6;color:#a3a3a3}
    button{margin-top:16px;background:#3b82f6;color:#fff;border:0;padding:10px 20px;border-radius:8px;
      font-size:14px;cursor:pointer}
    button:hover{background:#2563eb}
  </style></head><body>
  <div class="card">
    <h1>Falha ao carregar o PDV</h1>
    <p><b>URL:</b> <code>${url}</code></p>
    <p><b>Erro (${code}):</b> ${description || "desconhecido"}</p>
    <p>Verifique a conexão de internet ou edite <code>config.json</code> ao lado do executável
    com a URL correta do PDV. Pressione <b>F5</b> para tentar novamente ou <b>F12</b> para abrir o DevTools.</p>
    <button onclick="location.reload()">Tentar novamente</button>
  </div></body></html>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

function createWindow(cfg) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    kiosk: !!cfg.kiosk,
    autoHideMenuBar: true,
    show: !cfg.startMinimized,
    backgroundColor: "#0a0a0a",
    icon: path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  console.log("[main] carregando URL:", cfg.url);
  mainWindow.loadURL(cfg.url).catch((e) => {
    console.error("[main] loadURL falhou:", e);
    showErrorPage(mainWindow, cfg.url, "load", String(e && e.message || e));
  });

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, validatedURL) => {
    if (code === -3) return; // aborted
    console.error("[main] did-fail-load:", code, desc, validatedURL);
    showErrorPage(mainWindow, validatedURL || cfg.url, code, desc);
  });

  // Atalhos de debug
  mainWindow.webContents.on("before-input-event", (_e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F12") mainWindow.webContents.toggleDevTools();
    if (input.key === "F5") mainWindow.reload();
    if (input.key === "F11") mainWindow.setKiosk(!mainWindow.isKiosk());
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("close", (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}


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

app.whenReady().then(() => {
  const cfg = loadConfig();
  try { agentServer = startAgent(); }
  catch (e) { dialog.showErrorBox("Falha ao iniciar agente", String(e)); }
  createWindow(cfg);
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(cfg);
    else mainWindow?.show();
  });
});

app.on("window-all-closed", (e) => { e.preventDefault(); /* mantém tray */ });
app.on("before-quit", () => {
  app.isQuitting = true;
  try { agentServer?.close(); } catch {}
});
