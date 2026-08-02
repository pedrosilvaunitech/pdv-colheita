/**
 * Bastion POS — Motor Fiscal em VPS (referência)
 *
 * Servidor Express que expõe os mesmos endpoints do agente local:
 *   POST /nfce/emit
 *   POST /nfce/cancel
 *   POST /nfce/inutilizar
 *   GET  /nfce/status
 *   GET  /health
 *
 * Auth: Bearer token via env FISCAL_VPS_TOKEN. O PDV manda no header
 * `Authorization: Bearer <token>`.
 *
 * Deploy: Fly.io, Railway, Contabo, VPS própria. Rode `node server.js`.
 * Dockerfile incluso — `docker build -t bastion-fiscal .`
 *
 * Cert .pfx: monte via volume (`/certs/store.pfx`) e configure em FISCAL_PFX_PATH.
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const nfce = require("./nfce"); // símile ao desktop/nfce.cjs, adaptado pra ler cfg via env

const PORT = Number(process.env.PORT || 3737);
// Bind: por padrão escuta em todas as interfaces para o PDV de outro caixa
// alcançar o servidor pela rede local. Restrinja com FISCAL_BIND=127.0.0.1
// quando o motor rodar no MESMO PC do único caixa.
const HOST = process.env.FISCAL_BIND || "0.0.0.0";
const VERSION = "1.2.0";

/**
 * Token de acesso.
 *
 * Antes o servidor SAÍA com exit(1) quando `FISCAL_VPS_TOKEN` não estava
 * definido — na prática o lojista dava `node server.js`, a janela fechava e a
 * conclusão era "o servidor não funciona". Agora, sem token, geramos um e
 * gravamos em ~/.bastion-pos/fiscal-server-token.txt: o servidor sobe, imprime o
 * token no console e o operador cola no PDV. Segurança mantida (o token continua
 * obrigatório nas rotas), sem tela preta inexplicável.
 */
const TOKEN_DIR = path.join(os.homedir(), ".bastion-pos");
const TOKEN_FILE = path.join(TOKEN_DIR, "fiscal-server-token.txt");

function resolveToken() {
  const fromEnv = (process.env.FISCAL_VPS_TOKEN || "").trim();
  if (fromEnv) return { token: fromEnv, origin: "env" };
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const saved = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      if (saved) return { token: saved, origin: "arquivo" };
    }
    const generated = crypto.randomBytes(24).toString("hex");
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, generated, { mode: 0o600 });
    return { token: generated, origin: "gerado" };
  } catch (e) {
    // Sem disco gravável (container read-only): token só desta execução.
    console.warn(`[bastion-fiscal] não foi possível gravar o token (${e.message}); usando token temporário.`);
    return { token: crypto.randomBytes(24).toString("hex"), origin: "temporario" };
  }
}

const { token: TOKEN, origin: TOKEN_ORIGIN } = resolveToken();

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * CORS + Private Network Access.
 *
 * O PDV é uma página HTTPS e o motor fiscal roda em http://127.0.0.1 ou num IP
 * da rede local. Sem estes cabeçalhos o navegador barra o preflight e a
 * requisição falha com "Failed to fetch" — que na tela virava "servidor não
 * reconhecido". `Access-Control-Allow-Private-Network` é o que autoriza o
 * Chrome a sair de uma origem pública para um endereço privado.
 */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "Authorization, Content-Type, X-Terminal-Id, Accept, Origin",
  );
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Access-Control-Expose-Headers", "X-Fiscal-Server-Version");
  res.setHeader("X-Fiscal-Server-Version", VERSION);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Timing-safe bearer check
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Token ausente. Configure o mesmo token no PDV (Servidor fiscal → Token).",
    });
  }
  const provided = Buffer.from(h.slice(7).trim());
  const expected = Buffer.from(TOKEN);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: "Token inválido para este servidor fiscal." });
  }
  next();
}

// Página de cortesia: abrir o endereço no navegador mostra que está de pé.
app.get("/", (_req, res) => {
  res.type("text/plain").send(
    `Bastion POS — Motor Fiscal v${VERSION}\n` +
      `engine=${nfce.isAvailable() ? "pronto" : "sem node-dfe"}\n` +
      `Use /health para checagem e configure este endereço no PDV.\n`,
  );
});


// /health é público de propósito: o PDV precisa distinguir "não achei o
// servidor" de "achei mas o token está errado". Não devolve nada sensível.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "bastion-fiscal",
    version: VERSION,
    engine_ready: nfce.isAvailable(),
    environment: process.env.FISCAL_ENVIRONMENT || "homologacao",
    token_origin: TOKEN_ORIGIN,
    node: process.version,
    uptime_s: Math.floor(process.uptime()),
  });
});


/**
 * Rotina de validação do servidor fiscal central.
 * Devolve uma lista de checagens acionáveis (mesma forma do agente local),
 * para o app web mostrar exatamente o que falta antes de emitir em produção.
 */
app.get("/nfce/validate", auth, async (_req, res) => {
  const fs = require("fs");
  const checks = [];
  const push = (key, label, status, detail, fix) => checks.push({ key, label, status, detail, fix: fix || null });

  const major = Number(process.versions.node.split(".")[0]);
  push("node_runtime", "Runtime Node.js", major >= 18 ? "ok" : "fail", `Node ${process.version}`,
    major >= 18 ? null : "Atualize a imagem do servidor para Node 18+.");

  push("engine", "Biblioteca node-dfe", nfce.isAvailable() ? "ok" : "fail",
    nfce.isAvailable() ? "carregada" : "não instalada",
    nfce.isAvailable() ? null : "Rode `npm install node-dfe node-forge qrcode` no servidor e reinicie.");

  const required = ["FISCAL_CNPJ", "FISCAL_UF", "FISCAL_CSC_ID", "FISCAL_CSC_TOKEN", "FISCAL_PFX_PATH", "FISCAL_PFX_PASSWORD"];
  const missing = required.filter((k) => !process.env[k]);
  push("env", "Variáveis de ambiente", missing.length ? "fail" : "ok",
    missing.length ? `Faltando: ${missing.join(", ")}` : required.join(", "),
    missing.length ? "Defina as variáveis no ambiente do container e reinicie." : null);

  const pfx = process.env.FISCAL_PFX_PATH;
  const certOk = !!pfx && fs.existsSync(pfx);
  push("certificate", "Certificado A1", certOk ? "ok" : "fail",
    certOk ? `${pfx} (${fs.statSync(pfx).size} bytes)` : `Arquivo não encontrado em ${pfx || "—"}`,
    certOk ? null : "Monte o .pfx como volume em /certs/store.pfx.");

  push("environment", "Ambiente fiscal", "ok", process.env.FISCAL_ENVIRONMENT || "homologacao",
    (process.env.FISCAL_ENVIRONMENT || "homologacao") === "producao" ? null : "Ambiente de homologação: notas não têm valor fiscal.");

  let sefaz = null;
  if (nfce.isAvailable() && certOk && !missing.length) {
    const t0 = Date.now();
    try {
      sefaz = await nfce.statusServico();
      push("sefaz", "Conexão SEFAZ", sefaz.ok ? "ok" : "fail",
        `${sefaz.xMotivo || sefaz.error || "sem resposta"} (${Date.now() - t0}ms)`,
        sefaz.ok ? null : "Verifique certificado, UF e conectividade de saída do servidor.");
    } catch (e) {
      push("sefaz", "Conexão SEFAZ", "fail", e.message, "Verifique firewall de saída (portas 443) do servidor.");
    }
  } else {
    push("sefaz", "Conexão SEFAZ", "warn", "Não testada — corrija os itens acima primeiro.", null);
  }

  const failed = checks.filter((c) => c.status === "fail");
  res.json({
    ok: failed.length === 0,
    version: "1.1.0",
    node: process.version,
    uptime_s: Math.floor(process.uptime()),
    summary: failed.length ? `${failed.length} problema(s) bloqueando a emissão.` : "Servidor fiscal pronto para emitir.",
    checks,
  });
});


app.get("/nfce/status", auth, async (_req, res) => {
  try { res.json(await nfce.statusServico()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/nfce/emit", auth, async (req, res) => {
  // Multi-caixa: o PDV envia `terminal: { id, name }` no DTO. Registramos a
  // origem para auditoria e devolvemos junto do resultado.
  const terminal = (req.body && req.body.terminal) || null;
  const started = Date.now();
  try {
    const result = await nfce.emitNFCe(req.body);
    console.log(
      `[bastion-fiscal] emit terminal=${terminal?.name || terminal?.id || "desconhecido"} ` +
        `serie=${req.body?.series} numero=${req.body?.number} ok=${result.ok} ${Date.now() - started}ms`,
    );
    res.status(result.ok ? 200 : 502).json({ ...result, terminal, elapsed_ms: Date.now() - started });
  } catch (e) {
    console.error(`[bastion-fiscal] emit falhou terminal=${terminal?.id || "?"}:`, e.message);
    res.status(500).json({ ok: false, error: e.message, terminal, elapsed_ms: Date.now() - started });
  }
});


app.post("/nfce/cancel", auth, async (req, res) => {
  try { res.json(await nfce.cancelNFCe(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/nfce/inutilizar", auth, async (req, res) => {
  try { res.json(await nfce.inutilizarFaixa(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/** Endereços que o lojista pode digitar no PDV (IPv4 da máquina). */
function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const server = app.listen(PORT, HOST, () => {
  const urls = ["127.0.0.1", ...localAddresses()].map((h) => `http://${h}:${PORT}`);
  console.log("");
  console.log(`[bastion-fiscal] v${VERSION} de pé · engine=${nfce.isAvailable() ? "pronto" : "SEM node-dfe"}`);
  console.log(`[bastion-fiscal] escutando em ${HOST}:${PORT}`);
  console.log(`[bastion-fiscal] use no PDV um destes endereços: ${urls.join("  |  ")}`);
  console.log(`[bastion-fiscal] token (${TOKEN_ORIGIN}): ${TOKEN}`);
  if (TOKEN_ORIGIN !== "env") console.log(`[bastion-fiscal] token salvo em ${TOKEN_FILE}`);
  if (!nfce.isAvailable()) {
    console.log("[bastion-fiscal] ATENÇÃO: rode `npm install` nesta pasta — sem node-dfe não emite nota.");
  }
  console.log("");
});

// Porta ocupada é o erro mais comum ao rodar no PC do caixa (duas instâncias).
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `[bastion-fiscal] a porta ${PORT} já está em uso. ` +
        "Provavelmente o servidor já está rodando (confira a bandeja/serviço) " +
        `ou rode com outra porta: PORT=3738 node server.js`,
    );
    process.exit(1);
  }
  console.error("[bastion-fiscal] falha ao subir:", err.message);
  process.exit(1);
});

