/**
 * Motor NFC-e para VPS — lê configuração a partir de variáveis de ambiente.
 *
 * Env obrigatórias:
 *   FISCAL_PFX_PATH        Caminho para o .pfx (ex.: /certs/store.pfx)
 *   FISCAL_PFX_PASSWORD    Senha do certificado
 *   FISCAL_CSC_ID          ID do CSC (SEFAZ)
 *   FISCAL_CSC_TOKEN       Token do CSC
 *   FISCAL_UF              UF (ex.: MG)
 *   FISCAL_ENVIRONMENT     homologacao | producao
 *   FISCAL_CNPJ            CNPJ da empresa (só dígitos)
 *   FISCAL_IE              Inscrição Estadual
 *   FISCAL_RAZAO_SOCIAL    Razão Social
 *   FISCAL_CRT             1=Simples · 3=Regime Normal
 *   FISCAL_SERIE           Série NFC-e (padrão 1)
 */

const fs = require("fs");
const crypto = require("crypto");

let NodeDfe = null;
try { NodeDfe = require("node-dfe"); }
catch { console.warn("[vps-nfce] node-dfe não instalado."); }

let qrcode = null;
try { qrcode = require("qrcode"); }
catch {}

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
};

function envCfg() {
  return {
    pfx_path: process.env.FISCAL_PFX_PATH,
    pfx_password: process.env.FISCAL_PFX_PASSWORD,
    csc_id: process.env.FISCAL_CSC_ID,
    csc_token: process.env.FISCAL_CSC_TOKEN,
    uf: process.env.FISCAL_UF,
    environment: process.env.FISCAL_ENVIRONMENT || "homologacao",
    cnpj: (process.env.FISCAL_CNPJ || "").replace(/\D/g, ""),
    ie: process.env.FISCAL_IE,
    razao_social: process.env.FISCAL_RAZAO_SOCIAL,
    crt: Number(process.env.FISCAL_CRT || 1),
    serie: Number(process.env.FISCAL_SERIE || 1),
  };
}

function getEndpoints(uf, environment) {
  const uv = SEFAZ_ENDPOINTS[String(uf).toUpperCase()];
  return uv ? uv[environment === "producao" ? "producao" : "homologacao"] : null;
}

function buildQRUrl({ chave, ambiente, csc_id, csc_token, portal }) {
  if (!chave || !csc_id || !csc_token || !portal) return null;
  const versaoQR = "2";
  const concat = `${chave}|${versaoQR}|${ambiente}|${csc_id}${csc_token}`;
  const hash = crypto.createHash("sha1").update(concat).digest("hex").toUpperCase();
  const p = `${chave}|${versaoQR}|${ambiente}|${csc_id}|${hash}`;
  return `${portal}?p=${encodeURIComponent(p)}`;
}

async function emitNFCe(sale) {
  if (!NodeDfe) throw new Error("node-dfe não instalado no container. Rode `npm install`.");
  const cfg = envCfg();
  if (!cfg.pfx_path || !fs.existsSync(cfg.pfx_path)) throw new Error(`.pfx não encontrado em ${cfg.pfx_path}`);
  if (!cfg.pfx_password) throw new Error("FISCAL_PFX_PASSWORD ausente");
  if (!cfg.csc_id || !cfg.csc_token) throw new Error("FISCAL_CSC_ID/FISCAL_CSC_TOKEN ausentes");

  const endpoints = getEndpoints(cfg.uf, sale.environment || cfg.environment);
  if (!endpoints) throw new Error(`UF ${cfg.uf} não mapeada`);

  const payload = {
    empresa: {
      cnpj: cfg.cnpj,
      inscricaoEstadual: cfg.ie,
      razaoSocial: cfg.razao_social,
      crt: cfg.crt,
      endereco: sale.emitente?.endereco || {},
      certificado: { pfx: fs.readFileSync(cfg.pfx_path), senha: cfg.pfx_password },
    },
    nota: {
      modelo: "65",
      serie: sale.series ?? cfg.serie,
      numero: sale.number,
      dataEmissao: sale.dataEmissao || new Date().toISOString(),
      naturezaOperacao: "Venda ao consumidor",
      finalidade: "1", indPresenca: "1", consumidorFinal: "1", indPag: "0",
      ambiente: (sale.environment || cfg.environment) === "producao" ? "1" : "2",
      itens: (sale.itens || []).map((it, idx) => ({
        numeroItem: idx + 1, codigo: it.codigo || String(idx + 1),
        descricao: it.descricao, ncm: it.ncm || "00000000",
        cfop: it.cfop || "5102", unidade: it.unidade || "UN",
        quantidade: Number(it.quantidade), valorUnitario: Number(it.valorUnitario),
        valorTotal: Number(it.valorTotal), indTot: "1",
        icms: it.icms || { cst: "00", origem: "0", aliquota: 0 },
        pis: it.pis || { cst: "07" }, cofins: it.cofins || { cst: "07" },
      })),
      pagamentos: (sale.pagamentos || []).map((p) => ({ tipo: p.tipo, valor: Number(p.valor) })),
      destinatario: sale.destinatario || null,
      csc: { id: cfg.csc_id, token: cfg.csc_token },
    },
    endpoints, uf: cfg.uf,
  };

  const engine = new NodeDfe.NFeProcessor(payload);
  const result = await engine.processarNFe();
  const chave = result.chave || result.chNFe || null;
  const protocolo = result.protocolo || result.nProt || null;
  const xml = result.xmlAutorizado || result.xml || null;

  const qr_url = buildQRUrl({
    chave, ambiente: payload.nota.ambiente,
    csc_id: cfg.csc_id, csc_token: cfg.csc_token, portal: endpoints.consulta_url,
  });

  let qr_png = null;
  if (qrcode && qr_url) { try { qr_png = await qrcode.toDataURL(qr_url); } catch {} }

  return {
    ok: !!chave && !!protocolo, chave, protocolo, xml, qr_url, qr_png,
    ambiente: payload.nota.ambiente === "1" ? "producao" : "homologacao",
    consulta_url: endpoints.consulta_url, raw: result,
  };
}

async function cancelNFCe({ chave, justificativa, protocolo }) {
  if (!NodeDfe) throw new Error("node-dfe não instalado.");
  const cfg = envCfg();
  const endpoints = getEndpoints(cfg.uf, cfg.environment);
  const engine = new NodeDfe.NFeEvento({
    empresa: { cnpj: cfg.cnpj, certificado: { pfx: fs.readFileSync(cfg.pfx_path), senha: cfg.pfx_password } },
    chave, protocolo, justificativa, tipo: "cancelamento", endpoints, uf: cfg.uf,
  });
  return await engine.processarEvento();
}

async function statusServico() {
  if (!NodeDfe) return { ok: false, error: "node-dfe não instalado" };
  const cfg = envCfg();
  const endpoints = getEndpoints(cfg.uf, cfg.environment);
  if (!endpoints) return { ok: false, error: `UF ${cfg.uf} não mapeada` };
  try {
    const engine = new NodeDfe.NFeStatus({
      empresa: { cnpj: cfg.cnpj, certificado: { pfx: fs.readFileSync(cfg.pfx_path), senha: cfg.pfx_password } },
      endpoints, uf: cfg.uf,
    });
    return { ok: true, ...(await engine.consultarStatus()) };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function inutilizarFaixa(input) {
  if (!NodeDfe) throw new Error("node-dfe não instalado.");
  const cfg = envCfg();
  const endpoints = getEndpoints(cfg.uf, cfg.environment);
  const engine = new NodeDfe.NFeInutilizacao({
    empresa: { cnpj: cfg.cnpj, certificado: { pfx: fs.readFileSync(cfg.pfx_path), senha: cfg.pfx_password } },
    ...input, endpoints, uf: cfg.uf,
  });
  return await engine.processarInutilizacao();
}

module.exports = { emitNFCe, cancelNFCe, statusServico, inutilizarFaixa, isAvailable: () => !!NodeDfe };
