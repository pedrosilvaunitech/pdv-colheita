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
    version: "1.0.0",
    engine_ready: nfce.isAvailable(),
    node: process.version,
    uptime_s: Math.floor(process.uptime()),
  });
});

app.get("/nfce/status", auth, async (_req, res) => {
  try { res.json(await nfce.statusServico()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/nfce/emit", auth, async (req, res) => {
  try {
    const result = await nfce.emitNFCe(req.body);
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
