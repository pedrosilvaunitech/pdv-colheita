/**
 * Gera instalador MSI para Windows usando electron-wix-msi.
 * Requer que `npm run pack:win` já tenha rodado (gera release/BastionPOSAgent-win32-x64/).
 * Uso:  node build-msi.cjs
 * Saída: release/msi/BastionPOSAgent.msi
 */
const { MSICreator } = require("electron-wix-msi");
const path = require("path");
const fs = require("fs");

const APP_DIR = path.resolve(__dirname, "release/BastionPOSAgent-win32-x64");
const OUT_DIR = path.resolve(__dirname, "release/msi");

if (!fs.existsSync(APP_DIR)) {
  console.error(`Pasta não encontrada: ${APP_DIR}\nExecute antes:  npm run pack:win`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const msi = new MSICreator({
  appDirectory: APP_DIR,
  outputDirectory: OUT_DIR,
  exe: "BastionPOSAgent",
  name: "Bastion POS Agent",
  manufacturer: "Bastion POS",
  version: "1.0.0",
  description: "Agente de impressao ESC/POS local + PDV desktop",
  ui: {
    chooseDirectory: true,
    images: {
      background: fs.existsSync(path.join(__dirname, "assets/wix-bg.bmp")) ? path.join(__dirname, "assets/wix-bg.bmp") : undefined,
    },
  },
  shortcutName: "Bastion POS",
  shortcutFolderName: "Bastion POS",
  programFilesFolderName: "Bastion POS",
  arch: "x64",
  features: { autoUpdate: false, autoLaunch: true },
});

(async () => {
  await msi.create();
  const { supportBinaries } = await msi.compile();
  console.log("MSI gerado:", supportBinaries);
})().catch((e) => { console.error(e); process.exit(1); });
