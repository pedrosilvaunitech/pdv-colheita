/**
 * Motor de emissão NFC-e — Bastion POS Agent v1.4.0
 *
 * Wrapper Node que:
 *   1) Lê a configuração fiscal LOCAL (config.json) com caminho do .pfx e senha.
 *   2) Constrói o XML NFC-e (mod. 65) via `node-dfe` (biblioteca madura em Node).
 *   3) Assina com XML-DSig usando o certificado A1.
 *   4) Envia à SEFAZ da UF via SOAP + mutual TLS.
 *   5) Devolve { chave, protocolo, xml_autorizado, qr_url } para o PDV.
 *
 * Certificado NUNCA trafega pela nuvem. Fica na máquina do caixa (ou VPS).
 *
 * IMPORTANTE — dependências opcionais:
 *   - `node-dfe` é uma dep pesada (~30 MB). Se não estiver instalada, o
 *     endpoint /nfce/emit responde com instruções claras de instalação.
 *   - `qrcode` é usado apenas para gerar o QR Code em PNG opcional.
 *   - `node-forge` decodifica o .pfx pra ler CN e data de expiração.
 *
 * Instalação:
 *   cd desktop && npm install node-dfe qrcode node-forge
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

// ────────────────────────────────────────────────────────────────────
// Dependências opcionais
// ────────────────────────────────────────────────────────────────────
let NodeDfe = null;
/** Motivo exato da indisponibilidade — exposto no /nfce/config para diagnóstico. */
let engineError = null;
/** Candidatos de motor fiscal, em ordem de preferência. */
const ENGINE_CANDIDATES = ["node-dfe"];
for (const mod of ENGINE_CANDIDATES) {
  try {
    NodeDfe = require(mod);
    engineError = null;
    break;
  } catch (e) {
    // MODULE_NOT_FOUND => não instalado. Outro erro => instalado porém quebrado.
    engineError =
      e && e.code === "MODULE_NOT_FOUND"
        ? `Dependência "${mod}" não instalada. Rode \`npm run install:fiscal\` na pasta do agente e reinicie.`
        : `Falha ao carregar "${mod}": ${e && e.message ? e.message : String(e)}`;
  }
}
if (!NodeDfe) console.warn("[nfce] motor indisponível —", engineError);

let forge = null;
try { forge = require("node-forge"); }
catch { /* opcional */ }

let qrcode = null;
try { qrcode = require("qrcode"); }
catch { /* opcional */ }

// ────────────────────────────────────────────────────────────────────
// Configuração local (config.json ao lado do agent.cjs)
// ────────────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(
  process.env.BASTION_CONFIG_DIR || path.join(os.homedir(), ".bastion-pos"),
  "fiscal.json"
);

function loadFiscalConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[nfce] erro lendo fiscal.json:", e.message);
    return null;
  }
}

function saveFiscalConfig(cfg) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// Máscara pra UI (nunca devolver senha em resposta HTTP)
function maskFiscalConfig(cfg) {
  if (!cfg) return null;
  return {
    ...cfg,
    pfx_password: cfg.pfx_password ? "•".repeat(8) : "",
    csc_token: cfg.csc_token ? cfg.csc_token.slice(0, 4) + "…" : "",
    _hasPassword: !!cfg.pfx_password,
    _hasCert: !!cfg.pfx_path && fs.existsSync(cfg.pfx_path || ""),
  };
}

// ────────────────────────────────────────────────────────────────────
// Lê metadados do certificado (CN + data de expiração)
// ────────────────────────────────────────────────────────────────────
function inspectCertificate(pfxPath, password) {
  if (!forge) return { ok: false, error: "node-forge não instalado" };
  if (!fs.existsSync(pfxPath)) return { ok: false, error: "Arquivo .pfx não encontrado" };
  try {
    const pfxBytes = fs.readFileSync(pfxPath, { encoding: "binary" });
    const p12Asn1 = forge.asn1.fromDer(pfxBytes);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
    const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const cert = bags[forge.pki.oids.certBag][0].cert;
    return {
      ok: true,
      subject: cert.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(", "),
      issuer: cert.issuer.attributes.map((a) => `${a.shortName}=${a.value}`).join(", "),
      valid_from: cert.validity.notBefore.toISOString(),
      valid_to: cert.validity.notAfter.toISOString(),
      days_left: Math.floor((cert.validity.notAfter - new Date()) / 86400000),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ────────────────────────────────────────────────────────────────────
// Endpoints SEFAZ (produção e homologação) — foco em MG (NFC-e mod 65)
// ────────────────────────────────────────────────────────────────────
const SEFAZ_ENDPOINTS = {
  MG: {
    homologacao: {
      autorizacao: "https://hnfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4",
      retautorizacao: "https://hnfce.fazenda.mg.gov.br/nfce/services/NFeRetAutorizacao4",
      status: "https://hnfce.fazenda.mg.gov.br/nfce/services/NFeStatusServico4",
      cancelamento: "https://hnfce.fazenda.mg.gov.br/nfce/services/NFeRecepcaoEvento4",
      inutilizacao: "https://hnfce.fazenda.mg.gov.br/nfce/services/NFeInutilizacao4",
      consulta_url: "https://hnfce.fazenda.mg.gov.br/portalnfce",
    },
    producao: {
      autorizacao: "https://nfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4",
      retautorizacao: "https://nfce.fazenda.mg.gov.br/nfce/services/NFeRetAutorizacao4",
      status: "https://nfce.fazenda.mg.gov.br/nfce/services/NFeStatusServico4",
      cancelamento: "https://nfce.fazenda.mg.gov.br/nfce/services/NFeRecepcaoEvento4",
      inutilizacao: "https://nfce.fazenda.mg.gov.br/nfce/services/NFeInutilizacao4",
      consulta_url: "https://nfce.fazenda.mg.gov.br/portalnfce",
    },
  },
  // Outras UFs podem ser adicionadas aqui. node-dfe já conhece a maioria.
};

function getEndpoints(uf, environment) {
  const uv = SEFAZ_ENDPOINTS[String(uf).toUpperCase()];
  if (!uv) return null;
  return uv[environment === "producao" ? "producao" : "homologacao"] || null;
}

// ────────────────────────────────────────────────────────────────────
// Emissão principal
// ────────────────────────────────────────────────────────────────────
async function emitNFCe(sale) {
  if (!NodeDfe) {
    throw new Error(
      "Motor NFC-e indisponível: instale a dependência node-dfe rodando " +
      "`npm install node-dfe qrcode node-forge` na pasta do agente e reinicie."
    );
  }

  const cfg = loadFiscalConfig();
  if (!cfg) throw new Error("Configuração fiscal local ausente. Configure em POST /nfce/config.");
  if (!cfg.pfx_path || !fs.existsSync(cfg.pfx_path)) {
    throw new Error(`Arquivo .pfx não encontrado em: ${cfg.pfx_path}`);
  }
  if (!cfg.pfx_password) throw new Error("Senha do certificado não configurada.");
  if (!cfg.csc_id || !cfg.csc_token) throw new Error("CSC ID/Token não configurados.");
  if (!cfg.uf) throw new Error("UF não configurada.");

  const endpoints = getEndpoints(cfg.uf, sale.environment || cfg.environment || "homologacao");
  if (!endpoints) throw new Error(`Endpoints SEFAZ não mapeados para UF ${cfg.uf}. Suportadas: ${Object.keys(SEFAZ_ENDPOINTS).join(", ")}`);

  // Monta payload no formato esperado por node-dfe.
  // A biblioteca faz: build XML → sign → SOAP + mTLS → parse retorno.
  const payload = {
    empresa: {
      cnpj: (sale.emitente?.cnpj || cfg.cnpj || "").replace(/\D/g, ""),
      inscricaoEstadual: sale.emitente?.ie || cfg.ie || "",
      razaoSocial: sale.emitente?.razaoSocial || cfg.razao_social || "",
      nomeFantasia: sale.emitente?.nomeFantasia || cfg.nome_fantasia || "",
      crt: Number(sale.emitente?.crt || cfg.crt || 1), // 1=Simples, 3=Regime Normal
      endereco: sale.emitente?.endereco || cfg.endereco || {},
      certificado: {
        pfx: fs.readFileSync(cfg.pfx_path),
        senha: cfg.pfx_password,
      },
    },
    nota: {
      modelo: "65", // NFC-e
      serie: sale.series ?? cfg.serie ?? 1,
      numero: sale.number,
      dataEmissao: sale.dataEmissao || new Date().toISOString(),
      naturezaOperacao: "Venda ao consumidor",
      finalidade: "1", // 1=Normal
      indPresenca: "1", // 1=Presencial
      consumidorFinal: "1",
      indPag: "0", // à vista
      ambiente: (sale.environment || cfg.environment) === "producao" ? "1" : "2",
      itens: (sale.itens || []).map((it, idx) => ({
        numeroItem: idx + 1,
        codigo: it.codigo || String(idx + 1),
        descricao: it.descricao,
        ncm: it.ncm || "00000000",
        cfop: it.cfop || "5102",
        unidade: it.unidade || "UN",
        quantidade: Number(it.quantidade),
        valorUnitario: Number(it.valorUnitario),
        valorTotal: Number(it.valorTotal),
        indTot: "1",
        icms: it.icms || { cst: "00", origem: "0", aliquota: 0 },
        pis: it.pis || { cst: "07" },
        cofins: it.cofins || { cst: "07" },
      })),
      pagamentos: (sale.pagamentos || []).map((p) => ({
        tipo: p.tipo, // "01"=Dinheiro, "03"=Cartão Crédito, "04"=Débito, "17"=PIX
        valor: Number(p.valor),
      })),
      destinatario: sale.destinatario || null, // CPF opcional
      csc: { id: cfg.csc_id, token: cfg.csc_token },
    },
    endpoints,
    uf: cfg.uf,
  };

  // Delegado ao node-dfe. A API exata pode variar por versão — ver README.
  const engine = new NodeDfe.NFeProcessor(payload);
  const result = await engine.processarNFe();

  // Espera-se: { chave, protocolo, xml, xmlAssinado, status }
  const chave = result.chave || result.chNFe || null;
  const protocolo = result.protocolo || result.nProt || null;
  const xml = result.xmlAutorizado || result.xml || null;

  // Monta URL do QR Code NFC-e
  const qr_url = buildQRUrl({
    chave,
    ambiente: payload.nota.ambiente,
    csc_id: cfg.csc_id,
    csc_token: cfg.csc_token,
    portal: endpoints.consulta_url,
  });

  let qr_png = null;
  if (qrcode && qr_url) {
    try { qr_png = await qrcode.toDataURL(qr_url); }
    catch (e) { console.warn("[nfce] falha ao gerar PNG do QR:", e.message); }
  }

  return {
    ok: !!chave && !!protocolo,
    chave,
    protocolo,
    xml,
    qr_url,
    qr_png,
    ambiente: payload.nota.ambiente === "1" ? "producao" : "homologacao",
    consulta_url: endpoints.consulta_url,
    raw: result,
  };
}

// URL de consulta NFC-e no portal SEFAZ.
// Formato oficial: <portal>?p=<chave>|<versaoQR>|<tpAmb>|<idCSC>|<hashCSC>
function buildQRUrl({ chave, ambiente, csc_id, csc_token, portal }) {
  if (!chave || !csc_id || !csc_token || !portal) return null;
  const versaoQR = "2";
  const concat = `${chave}|${versaoQR}|${ambiente}|${csc_id}${csc_token}`;
  const hash = crypto.createHash("sha1").update(concat).digest("hex").toUpperCase();
  const p = `${chave}|${versaoQR}|${ambiente}|${csc_id}|${hash}`;
  return `${portal}?p=${encodeURIComponent(p)}`;
}

// ────────────────────────────────────────────────────────────────────
// Cancelamento
// ────────────────────────────────────────────────────────────────────
async function cancelNFCe({ chave, justificativa, protocolo }) {
  if (!NodeDfe) throw new Error("node-dfe não instalado.");
  const cfg = loadFiscalConfig();
  if (!cfg) throw new Error("Configuração fiscal ausente.");
  if (!justificativa || justificativa.length < 15) throw new Error("Justificativa precisa de pelo menos 15 caracteres.");

  const endpoints = getEndpoints(cfg.uf, cfg.environment);
  const engine = new NodeDfe.NFeEvento({
    empresa: { cnpj: cfg.cnpj, certificado: { pfx: fs.readFileSync(cfg.pfx_path), senha: cfg.pfx_password } },
    chave,
    protocolo,
    justificativa,
    tipo: "cancelamento",
    endpoints,
    uf: cfg.uf,
  });
  return await engine.processarEvento();
}

// ────────────────────────────────────────────────────────────────────
// Status do serviço SEFAZ
// ────────────────────────────────────────────────────────────────────
async function statusServico() {
  if (!NodeDfe) return { ok: false, error: "node-dfe não instalado" };
  const cfg = loadFiscalConfig();
  if (!cfg) return { ok: false, error: "Configuração ausente" };
  const endpoints = getEndpoints(cfg.uf, cfg.environment);
  if (!endpoints) return { ok: false, error: `UF ${cfg.uf} não mapeada` };
  try {
    const engine = new NodeDfe.NFeStatus({
      empresa: { cnpj: cfg.cnpj, certificado: { pfx: fs.readFileSync(cfg.pfx_path), senha: cfg.pfx_password } },
      endpoints,
      uf: cfg.uf,
    });
    const r = await engine.consultarStatus();
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ────────────────────────────────────────────────────────────────────
// Inutilização de faixa
// ────────────────────────────────────────────────────────────────────
async function inutilizarFaixa({ serie, numeroInicial, numeroFinal, justificativa }) {
  if (!NodeDfe) throw new Error("node-dfe não instalado.");
  const cfg = loadFiscalConfig();
  if (!cfg) throw new Error("Configuração ausente.");
  const endpoints = getEndpoints(cfg.uf, cfg.environment);
  const engine = new NodeDfe.NFeInutilizacao({
    empresa: { cnpj: cfg.cnpj, certificado: { pfx: fs.readFileSync(cfg.pfx_path), senha: cfg.pfx_password } },
    serie, numeroInicial, numeroFinal, justificativa,
    endpoints, uf: cfg.uf,
  });
  return await engine.processarInutilizacao();
}

// ────────────────────────────────────────────────────────────────────
// Validação do motor (node-dfe) — diagnóstico acionável no caixa
// ────────────────────────────────────────────────────────────────────

/** Classes que o wrapper usa; se faltar alguma, a versão instalada é incompatível. */
const REQUIRED_EXPORTS = ["NFeProcessor", "NFeStatus", "NFeCancelamento", "NFeInutilizacao"];

function moduleMeta(name) {
  try {
    const pkgPath = require.resolve(`${name}/package.json`, { paths: [__dirname] });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return { installed: true, version: pkg.version || null, path: path.dirname(pkgPath) };
  } catch (e) {
    return { installed: false, version: null, path: null, error: e && e.message ? e.message : String(e) };
  }
}

/** Recarrega o node-dfe sem reiniciar o agente (após instalar a dependência). */
function reloadEngine() {
  for (const mod of ENGINE_CANDIDATES) {
    try {
      const resolved = require.resolve(mod, { paths: [__dirname] });
      delete require.cache[resolved];
      NodeDfe = require(resolved);
      engineError = null;
      return { ok: true, module: mod };
    } catch (e) {
      engineError =
        e && e.code === "MODULE_NOT_FOUND"
          ? `Dependência "${mod}" não instalada. Rode \`npm run install:fiscal\` na pasta do agente.`
          : `Falha ao carregar "${mod}": ${e && e.message ? e.message : String(e)}`;
    }
  }
  NodeDfe = null;
  return { ok: false, error: engineError };
}

/**
 * Bateria de checagens do motor fiscal local. Cada item traz
 * { key, label, status: "ok" | "warn" | "fail", detail, fix }.
 * Nunca lança — é usado tanto pelo /nfce/engine quanto pelo /diagnostics.
 */
function validateEngine() {
  const checks = [];
  const push = (key, label, status, detail, fix) => checks.push({ key, label, status, detail, fix: fix || null });

  // 1. Runtime Node
  const major = Number(process.versions.node.split(".")[0]);
  push(
    "node_runtime",
    "Runtime Node.js",
    major >= 18 ? "ok" : "fail",
    `Node ${process.versions.node} (${process.platform}/${process.arch})`,
    major >= 18 ? null : "O motor NFC-e exige Node 18+. Reinstale o agente com o instalador oficial.",
  );

  // 2. node-dfe instalado
  const dfe = moduleMeta("node-dfe");
  push(
    "node_dfe",
    "Biblioteca node-dfe",
    dfe.installed ? "ok" : "fail",
    dfe.installed ? `v${dfe.version} em ${dfe.path}` : dfe.error || "não encontrada",
    dfe.installed ? null : "Rode `npm run install:fiscal` na pasta do agente (ou clique em Instalar motor).",
  );

  // 3. Motor carregado em memória
  push(
    "engine_loaded",
    "Motor carregado",
    NodeDfe ? "ok" : "fail",
    NodeDfe ? "node-dfe carregado no processo do agente." : engineError || "Motor não carregado.",
    NodeDfe ? null : "Reinicie o Bastion POS Agent após instalar a dependência.",
  );

  // 4. API compatível
  if (NodeDfe) {
    const missing = REQUIRED_EXPORTS.filter((k) => typeof NodeDfe[k] !== "function");
    push(
      "engine_api",
      "API compatível",
      missing.length ? "fail" : "ok",
      missing.length ? `Classes ausentes: ${missing.join(", ")}` : REQUIRED_EXPORTS.join(", "),
      missing.length ? "Versão incompatível do node-dfe. Rode `npm run install:fiscal` para atualizar." : null,
    );
  }

  // 5. Dependências auxiliares
  const forgeMeta = moduleMeta("node-forge");
  push(
    "node_forge",
    "Leitor de certificado (node-forge)",
    forgeMeta.installed ? "ok" : "warn",
    forgeMeta.installed ? `v${forgeMeta.version}` : "não instalada — validade do A1 não será exibida",
    forgeMeta.installed ? null : "Rode `npm run install:fiscal`.",
  );
  const qrMeta = moduleMeta("qrcode");
  push(
    "qrcode",
    "Gerador de QR Code",
    qrMeta.installed ? "ok" : "warn",
    qrMeta.installed ? `v${qrMeta.version}` : "não instalada — cupom sai sem QR em PNG",
    qrMeta.installed ? null : "Rode `npm run install:fiscal`.",
  );

  // 6. Configuração fiscal local
  const cfg = loadFiscalConfig();
  const missingCfg = [];
  if (!cfg) missingCfg.push("fiscal.json");
  else {
    if (!cfg.cnpj) missingCfg.push("CNPJ");
    if (!cfg.uf) missingCfg.push("UF");
    if (!cfg.csc_id) missingCfg.push("CSC ID");
    if (!cfg.csc_token) missingCfg.push("CSC Token");
    if (!cfg.environment) missingCfg.push("ambiente");
  }
  push(
    "fiscal_config",
    "Configuração fiscal local",
    missingCfg.length ? "fail" : "ok",
    missingCfg.length ? `Faltando: ${missingCfg.join(", ")}` : `${cfg.cnpj} · ${cfg.uf} · ${cfg.environment}`,
    missingCfg.length ? "Preencha em Configurações → Fiscal e clique em Sincronizar com o agente." : null,
  );

  // 7. Endpoints da UF
  if (cfg && cfg.uf) {
    const eps = getEndpoints(cfg.uf, cfg.environment);
    push(
      "uf_endpoints",
      "Endpoints da SEFAZ",
      eps ? "ok" : "fail",
      eps ? `UF ${cfg.uf} mapeada (${cfg.environment})` : `UF ${cfg.uf} sem endpoints mapeados`,
      eps ? null : "Confirme a UF da loja em Configurações → Fiscal.",
    );
  }

  // 8. Certificado A1
  if (cfg && cfg.pfx_path) {
    const cert = inspectCertificate(cfg.pfx_path, cfg.pfx_password);
    if (!cert.ok) {
      push("certificate", "Certificado A1", "fail", cert.error, "Reinstale o .pfx e confirme a senha no agente.");
    } else {
      const expired = cert.days_left <= 0;
      push(
        "certificate",
        "Certificado A1",
        expired ? "fail" : cert.days_left < 30 ? "warn" : "ok",
        `${cert.subject} · vence em ${cert.days_left} dia(s)`,
        expired ? "Certificado vencido. Emita um novo A1 e reinstale no caixa." : null,
      );
    }
  } else {
    push("certificate", "Certificado A1", "fail", "Nenhum .pfx configurado.", "Instale o certificado A1 no agente.");
  }

  const failed = checks.filter((c) => c.status === "fail");
  return {
    ok: failed.length === 0,
    ready: !!NodeDfe && failed.length === 0,
    engine_error: engineError,
    versions: { agent_node: process.versions.node, node_dfe: dfe.version, node_forge: forgeMeta.version, qrcode: qrMeta.version },
    checks,
    summary: failed.length ? `${failed.length} problema(s) bloqueando a emissão.` : "Motor fiscal pronto para emitir.",
  };
}

// ────────────────────────────────────────────────────────────────────
// Instalação assistida do motor (equivale a `npm run install:fiscal`)
// ────────────────────────────────────────────────────────────────────
let installState = { running: false, startedAt: null, finishedAt: null, ok: null, log: [], error: null };

function getInstallState() {
  return { ...installState, log: installState.log.slice(-200) };
}

/**
 * Executa a instalação das dependências fiscais na pasta do agente.
 * Roda em background: o cliente faz polling em /nfce/engine/install.
 */
function startEngineInstall() {
  if (installState.running) return { ok: true, alreadyRunning: true, state: getInstallState() };

  const { spawn } = require("child_process");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "node-dfe@^0.0.25", "node-forge@^1.3.1", "qrcode@^1.5.4", "--no-audit", "--no-fund"];

  installState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null, log: [], error: null };
  const line = (s) => {
    installState.log.push(s);
    console.log("[nfce:install]", s);
  };
  line(`$ ${npm} ${args.join(" ")} (cwd=${__dirname})`);

  let child;
  try {
    child = spawn(npm, args, { cwd: __dirname, shell: process.platform === "win32", windowsHide: true });
  } catch (e) {
    installState.running = false;
    installState.ok = false;
    installState.error = `Não foi possível executar o npm: ${e.message}. Instale o Node.js no caixa.`;
    installState.finishedAt = new Date().toISOString();
    return { ok: false, state: getInstallState() };
  }

  child.stdout.on("data", (b) => String(b).split(/\r?\n/).filter(Boolean).forEach(line));
  child.stderr.on("data", (b) => String(b).split(/\r?\n/).filter(Boolean).forEach(line));
  child.on("error", (e) => {
    installState.error = e.message;
    line(`erro: ${e.message}`);
  });
  child.on("close", (code) => {
    installState.running = false;
    installState.finishedAt = new Date().toISOString();
    installState.ok = code === 0;
    if (code !== 0 && !installState.error) installState.error = `npm saiu com código ${code}.`;
    line(`npm finalizou com código ${code}`);
    if (code === 0) {
      const reloaded = reloadEngine();
      line(reloaded.ok ? "motor node-dfe recarregado com sucesso." : `motor ainda indisponível: ${reloaded.error}`);
      installState.ok = reloaded.ok;
      if (!reloaded.ok) installState.error = reloaded.error;
    }
  });

  return { ok: true, state: getInstallState() };
}

module.exports = {
  emitNFCe,
  cancelNFCe,
  statusServico,
  inutilizarFaixa,
  loadFiscalConfig,
  saveFiscalConfig,
  maskFiscalConfig,
  inspectCertificate,
  getEndpoints,
  buildQRUrl,
  validateEngine,
  reloadEngine,
  startEngineInstall,
  getInstallState,
  isAvailable: () => !!NodeDfe,
  engineError: () => engineError,
  CONFIG_FILE,
};

