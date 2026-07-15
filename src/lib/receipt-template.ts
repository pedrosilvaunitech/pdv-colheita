// Modelo de template do cupom — blocos configuráveis por loja + tipo (fiscal/não-fiscal).
// Persistido em localStorage por (storeId, docType). Consumido por receipt.ts (HTML) e
// escpos.ts (raw), garantindo que a impressão bata com a prévia.

export type BlockAlign = "left" | "center" | "right";
export type BlockSize = "sm" | "md" | "lg";

export type BlockKind =
  | "store_badge"    // grande caixa "NFC-e" / "RECIBO" no topo esquerdo
  | "store_info"     // nome / cnpj / endereço / telefone
  | "header_msg"     // texto livre no topo (r.header ou override)
  | "doc_title"      // "DANFE NFC-e — ..." / "RECIBO DE VENDA — ..."
  | "sale_meta"      // Venda / Data / Operador
  | "customer"       // Cliente + doc
  | "items"          // tabela ITEM CÓDIGO DESC QTD VLR TOTAL
  | "totals"         // QTDE ITENS / DESCONTO / TOTAL / FORMA
  | "payments"       // lista de pagamentos + troco
  | "tributes"       // Lei 12.741 — FISCAL, travado
  | "nfce_info"      // NFC-e nº / série / emissão — FISCAL, travado
  | "consumer_via"   // "Via Consumidor" — FISCAL
  | "sefaz_link"     // "Consulta pela chave em ..." — FISCAL
  | "qr"             // QR code — FISCAL, travado
  | "chave"          // 44 dígitos — FISCAL, travado
  | "footer_msg"     // texto livre rodapé (r.footer ou override)
  | "brand"          // "Bastion POS"
  | "separator"      // linha tracejada
  | "custom_text";   // texto livre repetível

export interface ReceiptBlock {
  id: string;                    // uuid estável
  kind: BlockKind;
  enabled: boolean;
  align: BlockAlign;
  bold: boolean;
  size: BlockSize;
  text?: string;                 // usado por custom_text, header_msg, footer_msg (override)
  locked?: boolean;              // não pode ser desabilitado/removido/reordenado para fora
}

export interface ReceiptTemplate {
  version: 1;
  blocks: ReceiptBlock[];
}

const LOCKED_FISCAL: BlockKind[] = ["tributes", "nfce_info", "qr", "chave"];

function uid(): string {
  try { return (crypto as Crypto).randomUUID ? crypto.randomUUID() : `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
  catch { return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
}

function block(kind: BlockKind, over: Partial<ReceiptBlock> = {}): ReceiptBlock {
  const defaults: Record<BlockKind, Partial<ReceiptBlock>> = {
    store_badge:  { align: "left",   bold: true,  size: "lg" },
    store_info:   { align: "left",   bold: false, size: "md" },
    header_msg:   { align: "center", bold: false, size: "sm" },
    doc_title:    { align: "center", bold: true,  size: "md" },
    sale_meta:    { align: "center", bold: false, size: "sm" },
    customer:     { align: "center", bold: false, size: "sm" },
    items:        { align: "left",   bold: false, size: "md" },
    totals:       { align: "right",  bold: true,  size: "md" },
    payments:     { align: "right",  bold: false, size: "sm" },
    tributes:     { align: "center", bold: false, size: "sm" },
    nfce_info:    { align: "center", bold: true,  size: "sm" },
    consumer_via: { align: "center", bold: false, size: "sm" },
    sefaz_link:   { align: "center", bold: false, size: "sm" },
    qr:           { align: "center", bold: false, size: "md" },
    chave:        { align: "center", bold: false, size: "sm" },
    footer_msg:   { align: "center", bold: false, size: "md" },
    brand:        { align: "center", bold: false, size: "sm" },
    separator:    { align: "left",   bold: false, size: "sm" },
    custom_text:  { align: "center", bold: false, size: "md" },
  };
  return { id: uid(), kind, enabled: true, align: "left", bold: false, size: "md", ...defaults[kind], ...over };
}

export function defaultTemplate(docType: "fiscal" | "nao_fiscal"): ReceiptTemplate {
  const common: ReceiptBlock[] = [
    block("store_badge"),
    block("store_info"),
    block("header_msg"),
    block("separator"),
    block("doc_title"),
    block("separator"),
    block("items"),
    block("totals"),
    block("separator"),
    block("payments"),
    block("separator"),
  ];
  if (docType === "fiscal") {
    return {
      version: 1,
      blocks: [
        ...common,
        block("tributes", { locked: true }),
        block("separator"),
        block("nfce_info", { locked: true }),
        block("consumer_via"),
        block("sefaz_link"),
        block("separator"),
        block("qr", { locked: true }),
        block("separator"),
        block("chave", { locked: true }),
        block("separator"),
        block("footer_msg", { text: "Este documento é uma representação simplificada da NFC-e." }),
        block("brand"),
      ],
    };
  }
  return {
    version: 1,
    blocks: [
      ...common,
      block("sale_meta"),
      block("customer"),
      block("separator"),
      block("footer_msg", { text: "Obrigado pela preferência!" }),
      block("brand"),
    ],
  };
}

// ─── persistência ────────────────────────────────────────────
const KEY_PREFIX = "receipt.template.v1";
function storageKey(storeId: string | null, docType: "fiscal" | "nao_fiscal"): string {
  return `${KEY_PREFIX}.${storeId ?? "no-store"}.${docType}`;
}

export function loadTemplate(storeId: string | null, docType: "fiscal" | "nao_fiscal"): ReceiptTemplate {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey(storeId, docType)) : null;
    if (!raw) return defaultTemplate(docType);
    const parsed = JSON.parse(raw) as ReceiptTemplate;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.blocks)) return defaultTemplate(docType);
    // Garante que blocos legais obrigatórios existam no fiscal
    if (docType === "fiscal") {
      const kinds = new Set(parsed.blocks.map((b) => b.kind));
      for (const k of LOCKED_FISCAL) {
        if (!kinds.has(k)) parsed.blocks.push(block(k, { locked: true }));
      }
      // Força enabled=true e locked=true nos blocos legais
      parsed.blocks = parsed.blocks.map((b) =>
        LOCKED_FISCAL.includes(b.kind) ? { ...b, enabled: true, locked: true } : b,
      );
    }
    return parsed;
  } catch { return defaultTemplate(docType); }
}

export function saveTemplate(storeId: string | null, docType: "fiscal" | "nao_fiscal", tpl: ReceiptTemplate): void {
  try { localStorage.setItem(storageKey(storeId, docType), JSON.stringify(tpl)); } catch { /* noop */ }
}

export function resetTemplate(storeId: string | null, docType: "fiscal" | "nao_fiscal"): ReceiptTemplate {
  try { localStorage.removeItem(storageKey(storeId, docType)); } catch { /* noop */ }
  return defaultTemplate(docType);
}

// ─── manipulação (usado pelo editor) ─────────────────────────
export function moveBlock(tpl: ReceiptTemplate, id: string, dir: -1 | 1): ReceiptTemplate {
  const idx = tpl.blocks.findIndex((b) => b.id === id);
  if (idx < 0) return tpl;
  const j = idx + dir;
  if (j < 0 || j >= tpl.blocks.length) return tpl;
  const arr = [...tpl.blocks];
  [arr[idx], arr[j]] = [arr[j], arr[idx]];
  return { ...tpl, blocks: arr };
}

export function updateBlock(tpl: ReceiptTemplate, id: string, patch: Partial<ReceiptBlock>): ReceiptTemplate {
  return {
    ...tpl,
    blocks: tpl.blocks.map((b) => {
      if (b.id !== id) return b;
      // Blocos travados não podem ser desabilitados
      if (b.locked && patch.enabled === false) return b;
      return { ...b, ...patch };
    }),
  };
}

export function removeBlock(tpl: ReceiptTemplate, id: string): ReceiptTemplate {
  return { ...tpl, blocks: tpl.blocks.filter((b) => !(b.id === id && !b.locked)) };
}

export function addCustomTextBlock(tpl: ReceiptTemplate, text = "Texto personalizado"): ReceiptTemplate {
  return { ...tpl, blocks: [...tpl.blocks, block("custom_text", { text })] };
}

export function addSeparatorBlock(tpl: ReceiptTemplate): ReceiptTemplate {
  return { ...tpl, blocks: [...tpl.blocks, block("separator")] };
}

export function isLockedKind(kind: BlockKind): boolean {
  return LOCKED_FISCAL.includes(kind);
}

export const BLOCK_LABEL: Record<BlockKind, string> = {
  store_badge: "Selo NFC-e / RECIBO",
  store_info: "Dados da loja",
  header_msg: "Mensagem de cabeçalho",
  doc_title: "Título do documento",
  sale_meta: "Info da venda (nº, data, operador)",
  customer: "Cliente",
  items: "Tabela de itens",
  totals: "Totais",
  payments: "Pagamentos e troco",
  tributes: "Tributos (Lei 12.741)",
  nfce_info: "NFC-e nº / série / emissão",
  consumer_via: "Via Consumidor",
  sefaz_link: "Link SEFAZ",
  qr: "QR Code SEFAZ",
  chave: "Chave de acesso (44 dígitos)",
  footer_msg: "Mensagem de rodapé",
  brand: "Marca Bastion POS",
  separator: "── Linha separadora ──",
  custom_text: "Texto livre",
};
