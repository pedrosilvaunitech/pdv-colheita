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

function loadConfig() {
  const defaults = {
    url: process.env.BASTION_URL || "https://app.bastion-pos.com/pdv?kiosk=1",
    kiosk: true,
    startMinimized: false,
  };
  try {
    const p = path.join(path.dirname(app.getPath("exe")), "config.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      return { ...defaults, ...j };
    }
  } catch (e) { console.warn("[main] config.json inválido:", e); }
  return defaults;
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

  mainWindow.loadURL(cfg.url);

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
