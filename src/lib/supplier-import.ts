/**
 * Importação de fornecedores em lote (CSV / texto delimitado).
 *
 * Por que um parser próprio: o arquivo do lojista vem do Excel brasileiro
 * (separador `;`, decimal com vírgula, acentos) e queremos validar linha por
 * linha antes de tocar o banco, mostrando um espelho do que será gravado. Um
 * parser genérico traria dependência e não resolveria a normalização local.
 */

import { supplierInputSchema, firstIssue, type SupplierInput } from "./supplier-validation";
import { PAYMENT_METHODS } from "@/components/suppliers/supplier-payment-fields";

/** Cabeçalhos aceitos por campo (case/acento-insensitive). */
const HEADER_ALIASES: Record<keyof SupplierInput | "ignore", string[]> = {
  name: ["nome", "razao social", "razao", "fornecedor", "name"],
  cnpj: ["cnpj", "documento", "cnpj/cpf"],
  phone: ["telefone", "fone", "celular", "whatsapp", "phone"],
  email: ["email", "e-mail", "mail"],
  contact_name: ["contato", "pessoa de contato", "vendedor", "contact"],
  city: ["cidade", "city", "municipio"],
  state: ["uf", "estado", "state"],
  address_line: ["endereco", "endereço", "logradouro", "address"],
  notes: ["observacoes", "observações", "obs", "notas", "notes"],
  payment_methods: ["formas de pagamento", "pagamento", "formas", "payment"],
  payment_day: ["dia de pagamento", "dia pagamento", "vencimento", "dia"],
  payment_term_days: ["prazo", "prazo dias", "prazo (dias)", "term"],
  payment_condition: ["condicao", "condição", "condicao de pagamento", "condicoes"],
  pix_key: ["pix", "chave pix", "pix key"],
  pix_key_type: ["tipo pix", "tipo da chave pix", "pix tipo"],
  lead_time_days: ["entrega", "entrega dias", "lead time", "prazo entrega"],
  ignore: [],
};

const METHOD_BY_LABEL = new Map<string, string>();
for (const m of PAYMENT_METHODS) {
  METHOD_BY_LABEL.set(normalize(m.value), m.value);
  METHOD_BY_LABEL.set(normalize(m.label), m.value);
}
METHOD_BY_LABEL.set("ted", "transencia_placeholder");
METHOD_BY_LABEL.set("ted", "transferencia");
METHOD_BY_LABEL.set("faturado", "prazo");
METHOD_BY_LABEL.set("cartao de credito", "cartao");

function normalize(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/** Detecta o separador dominante da primeira linha. */
function detectDelimiter(headerLine: string): string {
  const candidates = [";", ",", "\t", "|"];
  let best = ";";
  let bestCount = -1;
  for (const c of candidates) {
    const count = headerLine.split(c).length - 1;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return bestCount <= 0 ? ";" : best;
}

/** Split respeitando campos entre aspas duplas. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((v) => v.trim());
}

function toInt(raw: string): number | null {
  const digits = raw.replace(/[^\d-]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function parseMethods(raw: string): string[] {
  if (!raw.trim()) return [];
  const parts = raw.split(/[,/|+]/).map((p) => normalize(p)).filter(Boolean);
  const out = new Set<string>();
  for (const p of parts) {
    const hit = METHOD_BY_LABEL.get(p);
    if (hit) out.add(hit);
  }
  return Array.from(out);
}

export interface ImportRow {
  /** Linha no arquivo original (1 = cabeçalho). */
  line: number;
  data: SupplierInput | null;
  raw: Record<string, string>;
  errors: string[];
  /** Já existe fornecedor com mesmo CNPJ ou nome na loja. */
  duplicate?: "cnpj" | "nome" | null;
}

export interface ParsedImport {
  delimiter: string;
  mappedColumns: string[];
  unknownColumns: string[];
  rows: ImportRow[];
  validCount: number;
}

/** Converte o conteúdo do arquivo em linhas validadas, sem gravar nada. */
export function parseSupplierCsv(content: string): ParsedImport {
  const clean = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { delimiter: ";", mappedColumns: [], unknownColumns: [], rows: [], validCount: 0 };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headerCells = splitLine(lines[0], delimiter).map(normalize);

  const columnField: Array<keyof SupplierInput | null> = headerCells.map((cell) => {
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (field === "ignore") continue;
      if (aliases.some((a) => normalize(a) === cell)) return field as keyof SupplierInput;
    }
    return null;
  });

  const mappedColumns = headerCells.filter((_, i) => columnField[i] !== null);
  const unknownColumns = headerCells.filter((_, i) => columnField[i] === null && headerCells[i]);

  const rows: ImportRow[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitLine(lines[i], delimiter);
    const raw: Record<string, string> = {};
    headerCells.forEach((h, idx) => {
      if (h) raw[h] = cells[idx] ?? "";
    });

    const pick = (field: keyof SupplierInput): string => {
      const idx = columnField.findIndex((f) => f === field);
      return idx >= 0 ? cells[idx] ?? "" : "";
    };

    const candidate = {
      name: pick("name"),
      cnpj: pick("cnpj"),
      phone: pick("phone"),
      email: pick("email"),
      contact_name: pick("contact_name"),
      city: pick("city"),
      state: pick("state").toUpperCase().slice(0, 2),
      address_line: pick("address_line"),
      notes: pick("notes"),
      payment_methods: parseMethods(pick("payment_methods")),
      payment_day: toInt(pick("payment_day")),
      payment_term_days: toInt(pick("payment_term_days")) ?? 0,
      payment_condition: pick("payment_condition"),
      pix_key: pick("pix_key"),
      pix_key_type: normalize(pick("pix_key_type")),
      lead_time_days: toInt(pick("lead_time_days")) ?? 0,
    };

    const parsed = supplierInputSchema.safeParse(candidate);
    if (parsed.success) {
      rows.push({ line: i + 1, data: parsed.data, raw, errors: [] });
    } else {
      rows.push({
        line: i + 1,
        data: null,
        raw,
        errors: parsed.error.issues.map((issue) =>
          `${issue.path.join(".") || "linha"}: ${issue.message}`,
        ),
      });
    }
  }

  return {
    delimiter,
    mappedColumns,
    unknownColumns,
    rows,
    validCount: rows.filter((r) => r.data && r.errors.length === 0).length,
  };
}

/** Marca duplicidades contra os fornecedores já cadastrados na loja. */
export function markDuplicates(
  parsed: ParsedImport,
  existing: Array<{ name: string; cnpj: string | null }>,
): ParsedImport {
  const byCnpj = new Set(
    existing.map((s) => (s.cnpj ?? "").replace(/\D/g, "")).filter((v) => v.length === 14),
  );
  const byName = new Set(existing.map((s) => normalize(s.name)));

  const rows = parsed.rows.map((row) => {
    if (!row.data) return row;
    const cnpjDigits = (row.data.cnpj ?? "").replace(/\D/g, "");
    if (cnpjDigits.length === 14 && byCnpj.has(cnpjDigits)) {
      return { ...row, duplicate: "cnpj" as const };
    }
    if (byName.has(normalize(row.data.name))) return { ...row, duplicate: "nome" as const };
    return { ...row, duplicate: null };
  });

  return { ...parsed, rows };
}

/** Payload pronto para o insert em `suppliers`. */
export function toSupplierInsert(storeId: string, input: SupplierInput) {
  return {
    store_id: storeId,
    name: input.name,
    cnpj: input.cnpj || null,
    phone: input.phone || null,
    email: input.email || null,
    contact_name: input.contact_name || null,
    city: input.city || null,
    state: input.state ? input.state.toUpperCase() : null,
    address_line: input.address_line || null,
    notes: input.notes || null,
    payment_methods: input.payment_methods,
    payment_day: input.payment_day,
    payment_term_days: input.payment_term_days,
    payment_condition: input.payment_condition || null,
    pix_key: input.payment_methods.includes("pix") ? input.pix_key || null : null,
    pix_key_type: input.payment_methods.includes("pix") ? input.pix_key_type || null : null,
    lead_time_days: input.lead_time_days,
  };
}

/** Modelo de planilha para o lojista preencher. */
export const SUPPLIER_CSV_TEMPLATE = [
  "nome;cnpj;telefone;email;contato;cidade;uf;endereco;formas de pagamento;dia de pagamento;prazo;entrega;pix;tipo pix;condicao;observacoes",
  "Distribuidora Exemplo LTDA;11.222.333/0001-81;(11) 98888-7777;vendas@exemplo.com.br;Marcos;São Paulo;SP;Rua das Palmeiras, 120;Pix, Boleto;10;28;3;11222333000181;cnpj;28/35/42 dias;Entrega às segundas",
].join("\n");

export { firstIssue };
