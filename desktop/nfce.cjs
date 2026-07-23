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
try { NodeDfe = require("node-dfe"); }
catch { console.warn("[nfce] node-dfe não instalado — emissão direta indisponível até rodar `npm install node-dfe` no agente."); }

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
  isAvailable: () => !!NodeDfe,
  CONFIG_FILE,
};
