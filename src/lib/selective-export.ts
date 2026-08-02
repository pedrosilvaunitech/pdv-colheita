/**
 * Exportação seletiva de configuração.
 *
 * O backup "tudo ou nada" atrapalha nos dois extremos: quem só quer levar o
 * endereço do servidor fiscal para a segunda loja acaba carregando o layout do
 * cupom da primeira, e quem quer clonar o PC do caixa 2 não deveria levar a
 * numeração fiscal (que é única por loja e, duplicada, gera rejeição na SEFAZ).
 *
 * Por isso a exportação é por SEÇÃO, e cada seção declara seu escopo:
 *
 *  - `cloud`: vive no banco, vale para a loja inteira;
 *  - `local`: vive no navegador/PC deste caixa (impressora, layout salvo).
 *
 * Nenhum segredo é exportado: do servidor fiscal sai apenas o NOME do segredo,
 * e as credenciais fiscais (CSC token, senha do certificado) ficam de fora por
 * construção — o coletor só lê colunas explicitamente listadas.
 */

import { supabase } from "@/integrations/supabase/client";
import { buildBackup, downloadBackup, type BackupEnvelope } from "@/lib/config-backup";
import { getTerminalId, getTerminalLabel } from "@/lib/print-agent";

/** Identificador do envelope. Importações checam este valor. */
export const SELECTIVE_BACKUP_KIND = "bastion-pos.config";

export type SectionScope = "cloud" | "local";

export type SectionId =
  | "fiscal_server"
  | "fiscal_numbering"
  | "receipt_settings"
  | "receipt_templates"
  | "printers";

export interface SectionMeta {
  id: SectionId;
  label: string;
  description: string;
  scope: SectionScope;
  /** Marcadas por padrão na tela. */
  defaultOn: boolean;
}

/** Catálogo apresentado ao lojista, na ordem em que aparece na tela. */
export const EXPORT_SECTIONS: SectionMeta[] = [
  {
    id: "fiscal_server",
    label: "Servidor fiscal",
    description: "Motor, endereço principal, servidor reserva e nome do segredo (sem o valor do token).",
    scope: "cloud",
    defaultOn: true,
  },
  {
    id: "fiscal_numbering",
    label: "Numeração e regime fiscal",
    description: "Série/próximo número de NFC-e e NF-e, ambiente, CRT e CNAE. Não replique em outra loja.",
    scope: "cloud",
    defaultOn: false,
  },
  {
    id: "receipt_settings",
    label: "Cupom — preferências",
    description: "Largura do papel, cabeçalho, rodapé, o que aparece no cupom e regras da gaveta.",
    scope: "cloud",
    defaultOn: true,
  },
  {
    id: "receipt_templates",
    label: "Cupom — layout editado",
    description: "Blocos e ordem do cupom fiscal e não fiscal salvos neste computador.",
    scope: "local",
    defaultOn: true,
  },
  {
    id: "printers",
    label: "Impressoras deste terminal",
    description: "Impressora escolhida, largura do papel e codepage por impressora.",
    scope: "local",
    defaultOn: false,
  },
];

export interface SelectivePayload {
  store_id: string;
  terminal: { id: string; label: string } | null;
  sections: Partial<Record<SectionId, unknown>>;
}

// ── coletores ────────────────────────────────────────────────────────────────

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Chaves de layout do cupom salvas neste navegador (prefixo `receipt.template.v1`). */
function collectReceiptTemplates(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("receipt.template.v1")) continue;
      out[key] = readJson(key);
    }
  } catch {
    /* navegador sem storage: seção sai vazia */
  }
  return out;
}

function collectPrinters(): Record<string, unknown> {
  return {
    selection: readJson("printer.selection.v2"),
    paper_width: readJson("printer_paper_width_v1"),
    codepage: readJson("printer_codepage_v1"),
  };
}

async function collectFiscalServer(storeId: string): Promise<unknown> {
  const { data, error } = await supabase
    .from("fiscal_configs")
    .select("direct_engine, vps_url, vps_fallback_url, vps_auth_secret_name, fallback_enabled, fallback_order")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function collectFiscalNumbering(storeId: string): Promise<unknown> {
  const { data, error } = await supabase
    .from("fiscal_configs")
    .select("environment, provider, nfce_series, nfce_next_number, nfe_series, nfe_next_number, crt, cnae")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function collectReceiptSettings(storeId: string): Promise<unknown> {
  const { data, error } = await supabase
    .from("receipt_settings")
    .select(
      "default_document, paper_width, header_text, footer_text, print_auto, ask_customer, show_logo, show_cnpj, show_address, show_operator, show_customer, show_item_code, show_qrcode, font_size, thank_you_text, extra_info, drawer_auto, drawer_cash_only, drawer_pulse_pin",
    )
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

/**
 * Monta o payload apenas com as seções pedidas.
 * Seção que falha na leitura NÃO invalida o backup inteiro: ela sai como
 * `null` — melhor um backup parcial e honesto do que erro genérico.
 */
export async function collectSections(storeId: string, ids: SectionId[]): Promise<SelectivePayload> {
  const sections: Partial<Record<SectionId, unknown>> = {};
  const wantsLocal = ids.some((id) => EXPORT_SECTIONS.find((s) => s.id === id)?.scope === "local");

  for (const id of ids) {
    try {
      if (id === "fiscal_server") sections[id] = await collectFiscalServer(storeId);
      else if (id === "fiscal_numbering") sections[id] = await collectFiscalNumbering(storeId);
      else if (id === "receipt_settings") sections[id] = await collectReceiptSettings(storeId);
      else if (id === "receipt_templates") sections[id] = collectReceiptTemplates();
      else if (id === "printers") sections[id] = collectPrinters();
    } catch (e) {
      console.warn(`[selective-export] seção "${id}" não pôde ser lida:`, e);
      sections[id] = null;
    }
  }

  return {
    store_id: storeId,
    terminal: wantsLocal ? { id: getTerminalId(), label: getTerminalLabel() } : null,
    sections,
  };
}

export interface SelectiveExportResult {
  envelope: BackupEnvelope<SelectivePayload>;
  /** Seções que vieram vazias — a tela avisa em vez de fingir que exportou. */
  empty: SectionId[];
}

/** Coleta, empacota (versão + hash SHA-256) e devolve o envelope. */
export async function buildSelectiveBackup(
  storeId: string,
  ids: SectionId[],
): Promise<SelectiveExportResult> {
  if (ids.length === 0) throw new Error("Escolha ao menos uma seção para exportar.");
  const payload = await collectSections(storeId, ids);
  const empty = ids.filter((id) => {
    const value = payload.sections[id];
    if (value === null || value === undefined) return true;
    return typeof value === "object" && Object.keys(value as object).length === 0;
  });
  return { envelope: await buildBackup(SELECTIVE_BACKUP_KIND, payload), empty };
}

/** Nome do arquivo: data + seções, para achar o backup certo depois. */
export function backupBaseName(ids: SectionId[]): string {
  const day = new Date().toISOString().slice(0, 10);
  const tag = ids.length === EXPORT_SECTIONS.length ? "completo" : ids.length === 1 ? ids[0] : `${ids.length}secoes`;
  return `bastion-config-${tag}-${day}`;
}

/** Exporta e dispara o download em um passo. */
export async function exportSelectiveBackup(
  storeId: string,
  ids: SectionId[],
): Promise<SelectiveExportResult> {
  const result = await buildSelectiveBackup(storeId, ids);
  downloadBackup(result.envelope, backupBaseName(ids));
  return result;
}

export function sectionLabel(id: SectionId): string {
  return EXPORT_SECTIONS.find((s) => s.id === id)?.label ?? id;
}
