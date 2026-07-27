/**
 * Gera instalador MSI para Windows usando electron-wix-msi.
 *
 * Pré-requisito real do electron-wix-msi: os binários `candle.exe` e `light.exe`
 * do WiX Toolset v3 precisam estar no PATH. Como isso é a causa de falha mais
 * comum ("Could not find light.exe or candle.exe"), este script agora:
 *
 *   1. procura o WiX nos caminhos padrão de instalação do Windows;
 *   2. se não achar, baixa os binários oficiais (wix311-binaries.zip) para
 *      `desktop/.wix/` — sem instalar nada no sistema;
 *   3. injeta a pasta no PATH do processo antes de compilar.
 *
 * Uso:   npm run pack:win  &&  npm run msi:win
 * Saída: release/msi/BastionPOSAgent.msi
 *
 * Offline / rede bloqueada: instale o WiX 3.14 manualmente
 * (https://github.com/wixtoolset/wix3/releases) e rode de novo — o passo 1
 * encontra a instalação sozinho. Ou defina WIX_BIN=C:\caminho\para\bin.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { execFileSync } = require("child_process");

const APP_DIR = path.resolve(__dirname, "release/BastionPOSAgent-win32-x64");
const OUT_DIR = path.resolve(__dirname, "release/msi");
const WIX_DIR = path.resolve(__dirname, ".wix");
const WIX_URL = "https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip";

const pkg = require("./package.json");

/** true se a pasta contém os dois binários exigidos pelo electron-wix-msi. */
function isWixBin(dir) {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, "candle.exe")) && fs.existsSync(path.join(dir, "light.exe"));
}

/** Varre os locais padrão de instalação do WiX v3 no Windows. */
function findInstalledWix() {
  const candidates = [];
  if (process.env.WIX_BIN) candidates.push(process.env.WIX_BIN);
  // Variável criada pelo instalador oficial do WiX (aponta para a raiz).
  if (process.env.WIX) candidates.push(path.join(process.env.WIX, "bin"), process.env.WIX);
  const roots = [
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    process.env.ProgramFiles || "C:\\Program Files",
  ];
  for (const root of roots) {
    const wixRoot = path.join(root, "WiX Toolset v3.14");
    candidates.push(path.join(wixRoot, "bin"));
    // Versões antigas (3.11, 3.10...) — descobre dinamicamente.
    try {
      for (const entry of fs.readdirSync(root)) {
        if (/^WiX Toolset v3\./i.test(entry)) candidates.push(path.join(root, entry, "bin"));
      }
    } catch {
      /* raiz inexistente: ignora */
    }
  }
  // PATH atual (caso o usuário já tenha configurado).
  for (const p of (process.env.PATH || "").split(path.delimiter)) candidates.push(p);
  return candidates.find(isWixBin) || null;
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Muitos redirecionamentos ao baixar o WiX"));
    https
      .get(url, { headers: { "User-Agent": "bastion-pos-agent" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} ao baixar ${url}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(dest)));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

/** Extrai um .zip usando o tar.exe nativo do Windows 10+ (fallback: PowerShell). */
function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execFileSync("tar", ["-xf", zipPath, "-C", destDir], { stdio: "ignore" });
    return;
  } catch {
    /* tenta PowerShell */
  }
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ],
    { stdio: "inherit" },
  );
}

/** Garante candle.exe/light.exe disponíveis e devolve a pasta bin. */
async function ensureWix() {
  const installed = findInstalledWix();
  if (installed) return installed;

  if (isWixBin(WIX_DIR)) return WIX_DIR;

  console.log("WiX Toolset não encontrado. Baixando binários oficiais (~35 MB)...");
  fs.mkdirSync(WIX_DIR, { recursive: true });
  const zip = path.join(os.tmpdir(), "wix314-binaries.zip");
  await download(WIX_URL, zip);
  unzip(zip, WIX_DIR);
  try {
    fs.unlinkSync(zip);
  } catch {
    /* arquivo temporário: falha ao remover não é crítica */
  }
  if (!isWixBin(WIX_DIR)) {
    throw new Error(
      "Download concluído mas candle.exe/light.exe não foram encontrados em " +
        WIX_DIR +
        ".\nBaixe manualmente https://github.com/wixtoolset/wix3/releases (wix314-binaries.zip),\n" +
        "extraia numa pasta e rode:  set WIX_BIN=C:\\caminho\\da\\pasta  &&  npm run msi:win",
    );
  }
  return WIX_DIR;
}

(async () => {
  if (process.platform !== "win32") {
    console.error("O MSI só pode ser compilado no Windows (candle.exe/light.exe são binários Windows).");
    process.exit(1);
  }

  if (!fs.existsSync(APP_DIR)) {
    console.error(`Pasta não encontrada: ${APP_DIR}\nExecute antes:  npm run pack:win`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const wixBin = await ensureWix();
  // electron-wix-msi procura os binários apenas no PATH do processo.
  process.env.PATH = `${wixBin}${path.delimiter}${process.env.PATH || ""}`;
  console.log("WiX Toolset:", wixBin);

  const { MSICreator } = require("electron-wix-msi");

  const bgPath = path.join(__dirname, "assets/wix-bg.bmp");
  const msi = new MSICreator({
    appDirectory: APP_DIR,
    outputDirectory: OUT_DIR,
    exe: "BastionPOSAgent",
    name: "Bastion POS Agent",
    manufacturer: "Bastion POS",
    // Mantém o MSI alinhado à versão publicada do agente (evita instalar
    // por cima sem atualizar, já que o Windows compara a versão do produto).
    version: pkg.version || "1.0.0",
    description: "Agente de impressao ESC/POS local + NFC-e + TEF",
    ui: {
      chooseDirectory: true,
      images: fs.existsSync(bgPath) ? { background: bgPath } : undefined,
    },
    shortcutName: "Bastion POS",
    shortcutFolderName: "Bastion POS",
    programFilesFolderName: "Bastion POS",
    arch: "x64",
    features: { autoUpdate: false, autoLaunch: true },
  });

  await msi.create();
  await msi.compile();

  const msiPath = path.join(OUT_DIR, "BastionPOSAgent.msi");
  console.log("\nMSI gerado com sucesso:", fs.existsSync(msiPath) ? msiPath : OUT_DIR);
})().catch((e) => {
  console.error("\nErro ao gerar MSI:", e.message || e);
  console.error(
    "\nSe o download do WiX falhar (proxy/firewall), instale o WiX Toolset v3.14 manualmente:\n" +
      "  https://github.com/wixtoolset/wix3/releases  →  wix314.exe (instalador) ou wix314-binaries.zip\n" +
      "Depois rode:  set WIX_BIN=C:\\caminho\\para\\bin  &&  npm run msi:win",
  );
  process.exit(1);
});
