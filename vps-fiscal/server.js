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
const nfce = require("./nfce"); // símile ao desktop/nfce.cjs, adaptado pra ler cfg via env

const PORT = Number(process.env.PORT || 3737);
const TOKEN = process.env.FISCAL_VPS_TOKEN;

if (!TOKEN) {
  console.error("FISCAL_VPS_TOKEN não configurado. Defina no ambiente antes de subir.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Timing-safe bearer check
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Missing bearer token" });
  const provided = Buffer.from(h.slice(7));
  const expected = Buffer.from(TOKEN);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: "Invalid token" });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: "1.1.0",
    engine_ready: nfce.isAvailable(),
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

app.listen(PORT, () => {
  console.log(`[bastion-fiscal] http://0.0.0.0:${PORT} · engine=${nfce.isAvailable() ? "ready" : "sem node-dfe"}`);
});
