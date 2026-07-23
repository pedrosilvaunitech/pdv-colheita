/**
 * Utilitários fiscais: consulta CNPJ (BrasilAPI), sugestão de CRT,
 * validação de Inscrição Estadual e links SEFAZ por UF.
 */

export interface CnpjData {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  situacao: string;
  data_situacao: string | null;
  natureza_juridica: string;
  porte: string;
  regime_simples: boolean;
  regime_mei: boolean;
  data_exclusao_mei: string | null;
  cnae_principal: string;
  cnae_principal_desc: string;
  cnaes_secundarios: Array<{ codigo: string; descricao: string }>;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  municipio: string;
  uf: string;
  cep: string;
  telefone: string;
  email: string;
}

function formatCnaeCode(raw: number | string): string {
  // 4711302 -> 4711-3/02
  const s = String(raw).padStart(7, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 5)}/${s.slice(5, 7)}`;
}

function formatCnpj(raw: string): string {
  const d = raw.replace(/\D/g, "").padStart(14, "0");
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
}

function formatCep(raw: string): string {
  const d = raw.replace(/\D/g, "").padStart(8, "0");
  return `${d.slice(0, 5)}-${d.slice(5, 8)}`;
}

export async function lookupCnpj(cnpjRaw: string): Promise<CnpjData> {
  const cnpj = cnpjRaw.replace(/\D/g, "");
  if (cnpj.length !== 14) throw new Error("CNPJ inválido — precisa ter 14 dígitos.");

  const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    if (res.status === 404) throw new Error("CNPJ não encontrado na Receita Federal.");
    if (res.status === 429) throw new Error("Muitas consultas seguidas. Aguarde alguns segundos.");
    throw new Error(`Receita respondeu com HTTP ${res.status}.`);
  }
  const j = (await res.json()) as Record<string, unknown>;

  const isMEI = Boolean(j.opcao_pelo_mei);
  const dataExclusaoMEI = (j.data_exclusao_do_mei as string | null) ?? null;
  const stillMEI = isMEI && !dataExclusaoMEI;

  return {
    cnpj: formatCnpj(String(j.cnpj ?? cnpj)),
    razao_social: String(j.razao_social ?? ""),
    nome_fantasia: (j.nome_fantasia as string) || null,
    situacao: String(j.descricao_situacao_cadastral ?? ""),
    data_situacao: (j.data_situacao_cadastral as string) ?? null,
    natureza_juridica: String(j.natureza_juridica ?? ""),
    porte: String(j.porte ?? ""),
    regime_simples: Boolean(j.opcao_pelo_simples),
    regime_mei: stillMEI,
    data_exclusao_mei: dataExclusaoMEI,
    cnae_principal: j.cnae_fiscal ? formatCnaeCode(j.cnae_fiscal as number) : "",
    cnae_principal_desc: String(j.cnae_fiscal_descricao ?? ""),
    cnaes_secundarios: Array.isArray(j.cnaes_secundarios)
      ? (j.cnaes_secundarios as Array<{ codigo: number; descricao: string }>).map((c) => ({
          codigo: formatCnaeCode(c.codigo),
          descricao: c.descricao,
        }))
      : [],
    logradouro: String(j.logradouro ?? ""),
    numero: String(j.numero ?? ""),
    complemento: String(j.complemento ?? ""),
    bairro: String(j.bairro ?? ""),
    municipio: String(j.municipio ?? ""),
    uf: String(j.uf ?? ""),
    cep: j.cep ? formatCep(String(j.cep)) : "",
    telefone: String(j.ddd_telefone_1 ?? ""),
    email: String(j.email ?? ""),
  };
}

/** Sugere o CRT (Código de Regime Tributário) a partir dos dados da Receita. */
export function suggestCRT(data: Pick<CnpjData, "regime_mei" | "regime_simples">): {
  crt: "1" | "2" | "3" | "4";
  label: string;
  reason: string;
} {
  if (data.regime_mei) {
    return { crt: "4", label: "MEI (Simei)", reason: "Empresa optante pelo Simei ativo." };
  }
  if (data.regime_simples) {
    return { crt: "1", label: "Simples Nacional", reason: "Empresa optante pelo Simples Nacional." };
  }
  return { crt: "3", label: "Regime Normal", reason: "Empresa não optante pelo Simples — Lucro Presumido/Real." };
}

/** Validação cruzada CRT × Receita. Retorna aviso quando o CRT informado não bate. */
export function validateCRT(
  informed: string,
  data: Pick<CnpjData, "regime_mei" | "regime_simples">,
): { ok: boolean; message: string } | null {
  if (!informed) return null;
  const suggestion = suggestCRT(data);
  if (informed === suggestion.crt) {
    return { ok: true, message: `CRT bate com o cadastro na Receita (${suggestion.label}).` };
  }
  return {
    ok: false,
    message: `A Receita indica ${suggestion.label} (CRT ${suggestion.crt}). Você selecionou CRT ${informed}. Ajuste antes de emitir em produção.`,
  };
}

/** Portais SEFAZ por UF para gerar CSC/NFC-e e consultar Inscrição Estadual. */
export const SEFAZ_LINKS: Record<
  string,
  { name: string; csc: string; ie: string; ieLabel: string }
> = {
  AC: { name: "Acre",              csc: "https://sefaz.ac.gov.br/",                                     ie: "https://sefaznet.ac.gov.br/sefaznet/servlet/hwtcadger",           ieLabel: "SEFAZ-AC" },
  AL: { name: "Alagoas",           csc: "https://sfz-nfce.sefaz.al.gov.br/",                            ie: "http://www.sintegra.gov.br/",                                     ieLabel: "SINTEGRA" },
  AP: { name: "Amapá",             csc: "https://www.sefaz.ap.gov.br/",                                 ie: "https://www.sefaz.ap.gov.br/",                                    ieLabel: "SEFAZ-AP" },
  AM: { name: "Amazonas",          csc: "https://online.sefaz.am.gov.br/nfce/",                         ie: "https://online.sefaz.am.gov.br/",                                 ieLabel: "SEFAZ-AM" },
  BA: { name: "Bahia",             csc: "http://www.sefaz.ba.gov.br/scripts/nfce/",                     ie: "https://www.sefaz.ba.gov.br/scripts/cadastro/cadastroBa/",        ieLabel: "SEFAZ-BA" },
  CE: { name: "Ceará",             csc: "https://cfe.sefaz.ce.gov.br/mfe/",                             ie: "https://servicos.sefaz.ce.gov.br/",                               ieLabel: "SEFAZ-CE" },
  DF: { name: "Distrito Federal",  csc: "https://dec.fazenda.df.gov.br/",                               ie: "https://ww1.receita.fazenda.df.gov.br/cidadao/",                  ieLabel: "SEFAZ-DF" },
  ES: { name: "Espírito Santo",    csc: "https://internet.sefaz.es.gov.br/agenciavirtual/",             ie: "https://internet.sefaz.es.gov.br/informacao/cad/consultapublica.php", ieLabel: "SEFAZ-ES" },
  GO: { name: "Goiás",             csc: "https://www.sefaz.go.gov.br/nfce/",                            ie: "https://www.sefaz.go.gov.br/Post/ver/213756/",                    ieLabel: "SEFAZ-GO" },
  MA: { name: "Maranhão",          csc: "https://sistemas1.sefaz.ma.gov.br/portalsefaz/",               ie: "http://portal.sefaz.ma.gov.br/",                                  ieLabel: "SEFAZ-MA" },
  MT: { name: "Mato Grosso",       csc: "https://www.sefaz.mt.gov.br/nfce/",                            ie: "https://www.sefaz.mt.gov.br/",                                    ieLabel: "SEFAZ-MT" },
  MS: { name: "Mato Grosso do Sul",csc: "https://efazenda.sefaz.ms.gov.br/",                            ie: "https://efazenda.sefaz.ms.gov.br/",                               ieLabel: "SEFAZ-MS" },
  MG: { name: "Minas Gerais",      csc: "https://www2.fazenda.mg.gov.br/sol/",                          ie: "https://www2.fazenda.mg.gov.br/sol/",                             ieLabel: "SIARE/MG" },
  PA: { name: "Pará",              csc: "https://app.sefa.pa.gov.br/nfce/",                             ie: "https://app.sefa.pa.gov.br/",                                     ieLabel: "SEFA-PA" },
  PB: { name: "Paraíba",           csc: "https://www.sefaz.pb.gov.br/nfce",                             ie: "https://www.sefaz.pb.gov.br/servicos/",                           ieLabel: "SEFAZ-PB" },
  PR: { name: "Paraná",            csc: "https://receita.pr.gov.br/servico/Emitir-NFC-e",               ie: "https://www.cad.fazenda.pr.gov.br/cad/pages/publico/",            ieLabel: "SEFAZ-PR" },
  PE: { name: "Pernambuco",        csc: "https://www.sefaz.pe.gov.br/servicos/pages/nfc-e.aspx",        ie: "https://www.sefaz.pe.gov.br/",                                    ieLabel: "SEFAZ-PE" },
  PI: { name: "Piauí",             csc: "https://webas.sefaz.pi.gov.br/",                               ie: "https://webas.sefaz.pi.gov.br/",                                  ieLabel: "SEFAZ-PI" },
  RJ: { name: "Rio de Janeiro",    csc: "https://www.fazenda.rj.gov.br/sefaz/faces/",                   ie: "https://www.fazenda.rj.gov.br/",                                  ieLabel: "SEFAZ-RJ" },
  RN: { name: "Rio Grande do Norte",csc:"https://uvt2.set.rn.gov.br/",                                   ie: "https://uvt.set.rn.gov.br/",                                      ieLabel: "SEFAZ-RN" },
  RS: { name: "Rio Grande do Sul", csc: "https://www.sefaz.rs.gov.br/NFE/NFE-COM.aspx",                 ie: "https://www.sefaz.rs.gov.br/",                                    ieLabel: "SEFAZ-RS" },
  RO: { name: "Rondônia",          csc: "https://portalcontribuinte.sefin.ro.gov.br/",                  ie: "https://portalcontribuinte.sefin.ro.gov.br/",                     ieLabel: "SEFIN-RO" },
  RR: { name: "Roraima",           csc: "https://www.sefaz.rr.gov.br/",                                 ie: "https://www.sefaz.rr.gov.br/",                                    ieLabel: "SEFAZ-RR" },
  SC: { name: "Santa Catarina",    csc: "https://sat.sef.sc.gov.br/tax.NET/tax.NFCe.web/",              ie: "https://sat.sef.sc.gov.br/tax.NET/Sat.CCICMS.Consulta.Publica/", ieLabel: "SAT/SC" },
  SP: { name: "São Paulo",         csc: "https://portal.fazenda.sp.gov.br/servicos/nfce/",              ie: "https://www.cadesp.fazenda.sp.gov.br/",                           ieLabel: "CADESP/SP" },
  SE: { name: "Sergipe",           csc: "https://www.sefaz.se.gov.br/",                                 ie: "https://www.sefaz.se.gov.br/",                                    ieLabel: "SEFAZ-SE" },
  TO: { name: "Tocantins",         csc: "https://www.sefaz.to.gov.br/",                                 ie: "https://www.sefaz.to.gov.br/",                                    ieLabel: "SEFAZ-TO" },
};

/** Regras básicas de tamanho da IE por UF (validação formal, não fiscal). */
const IE_LENGTH: Record<string, number[]> = {
  AC: [13], AL: [9], AP: [9], AM: [9], BA: [8, 9], CE: [9], DF: [13], ES: [9],
  GO: [9], MA: [9], MT: [11], MS: [9], MG: [13], PA: [9], PB: [9], PR: [10],
  PE: [9, 14], PI: [9], RJ: [8], RN: [9, 10], RS: [10], RO: [14], RR: [9],
  SC: [9], SP: [12], SE: [9], TO: [9, 11],
};

export function validateIE(ie: string, uf: string): { ok: boolean; message: string } {
  const clean = ie.replace(/\D/g, "");
  if (!clean) return { ok: false, message: "Informe a Inscrição Estadual." };
  if (clean.toUpperCase() === "ISENTO") return { ok: true, message: "Isento (aceito para MEI em alguns estados)." };
  const lens = IE_LENGTH[uf?.toUpperCase()];
  if (!lens) return { ok: true, message: `IE com ${clean.length} dígitos (UF ${uf || "?"} sem regra local aplicada).` };
  if (!lens.includes(clean.length)) {
    return {
      ok: false,
      message: `IE de ${uf} deve ter ${lens.join(" ou ")} dígitos. Você digitou ${clean.length}.`,
    };
  }
  return { ok: true, message: `Formato de IE compatível com ${uf}.` };
}
