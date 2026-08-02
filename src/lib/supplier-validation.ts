/**
 * Validação de fornecedores e dos vínculos produto ⇄ fornecedor.
 *
 * Motivação: o banco garante apenas unicidade do par (product_id, supplier_id).
 * Regras de negócio — custo coerente, prazo plausível, exatamente um
 * preferencial por produto, Pix declarado quando a forma de pagamento é Pix —
 * precisam ser checadas na aplicação, tanto no momento da escrita (schemas Zod)
 * quanto em auditoria posterior (`auditSupplierLinks`), porque dados antigos
 * foram criados antes das regras existirem.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Schemas de escrita                                                 */
/* ------------------------------------------------------------------ */

const onlyDigits = (v: string) => v.replace(/\D/g, "");

/** CNPJ com dígitos verificadores. Vazio é aceito (campo opcional). */
export function isValidCnpj(raw: string): boolean {
  const d = onlyDigits(raw);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number) => {
    let sum = 0;
    let weight = len - 7;
    for (let i = 0; i < len; i += 1) {
      sum += Number(d[i]) * weight;
      weight -= 1;
      if (weight < 2) weight = 9;
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

export const supplierInputSchema = z
  .object({
    name: z.string().trim().min(2, "Nome do fornecedor deve ter ao menos 2 caracteres").max(140),
    cnpj: z.string().trim().max(20).optional().default(""),
    phone: z.string().trim().max(30).optional().default(""),
    email: z.string().trim().max(200).optional().default(""),
    contact_name: z.string().trim().max(120).optional().default(""),
    city: z.string().trim().max(100).optional().default(""),
    state: z.string().trim().max(2).optional().default(""),
    address_line: z.string().trim().max(200).optional().default(""),
    notes: z.string().trim().max(1000).optional().default(""),
    payment_methods: z.array(z.string()).default([]),
    payment_day: z.number().int().min(1).max(31).nullable().default(null),
    payment_term_days: z.number().int().min(0).max(365).default(0),
    payment_condition: z.string().trim().max(200).optional().default(""),
    pix_key: z.string().trim().max(140).optional().default(""),
    pix_key_type: z.string().trim().max(20).optional().default(""),
    lead_time_days: z.number().int().min(0).max(365).default(0),
  })
  .superRefine((value, ctx) => {
    if (value.cnpj && !isValidCnpj(value.cnpj)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cnpj"], message: "CNPJ inválido" });
    }
    if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.email)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["email"], message: "E-mail inválido" });
    }
    if (value.phone && onlyDigits(value.phone).length < 10) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["phone"], message: "Telefone incompleto (use DDD)" });
    }
    if (value.payment_methods.includes("pix") && !value.pix_key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pix_key"],
        message: "Informe a chave Pix ou desmarque a forma Pix",
      });
    }
  });

export type SupplierInput = z.infer<typeof supplierInputSchema>;

/** Vínculo produto ⇄ fornecedor. Usado nos dois diálogos de vínculo. */
export const productSupplierLinkSchema = z.object({
  product_id: z.string().uuid("Produto inválido"),
  supplier_id: z.string().uuid("Fornecedor inválido"),
  supplier_sku: z.string().trim().max(60).nullable().default(null),
  unit_cost: z
    .number({ invalid_type_error: "Custo inválido" })
    .min(0, "Custo não pode ser negativo")
    .max(1_000_000, "Custo acima do limite aceitável"),
  min_order_qty: z.number().min(0, "Mínimo de pedido não pode ser negativo").max(1_000_000).default(0),
  lead_time_days: z.number().int().min(0, "Prazo inválido").max(365, "Prazo máximo: 365 dias").default(0),
});

export type ProductSupplierLinkInput = z.infer<typeof productSupplierLinkSchema>;

/** Primeira mensagem de erro de um ZodError, pronta para toast. */
export function firstIssue(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Dados inválidos";
  }
  return error instanceof Error ? error.message : "Dados inválidos";
}

/* ------------------------------------------------------------------ */
/* Auditoria de vínculos existentes                                   */
/* ------------------------------------------------------------------ */

export type LinkIssueSeverity = "critico" | "aviso";

export interface LinkIssue {
  severity: LinkIssueSeverity;
  kind:
    | "sem_fornecedor"
    | "sem_preferencial"
    | "preferencial_duplicado"
    | "custo_zerado"
    | "sem_contato"
    | "fornecedor_sem_produto";
  title: string;
  detail: string;
  /** Ids úteis para navegação a partir da UI. */
  productId?: string;
  supplierId?: string;
}

export interface AuditableLink {
  product_id: string;
  supplier_id: string;
  unit_cost: number | null;
  is_preferred: boolean | null;
}

export interface AuditableProduct {
  id: string;
  name: string;
  active: boolean | null;
}

export interface AuditableSupplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

export interface LinkAuditResult {
  issues: LinkIssue[];
  counts: { critico: number; aviso: number };
  linkedProducts: number;
  totalActiveProducts: number;
}

/**
 * Cruza produtos, fornecedores e vínculos apontando inconsistências.
 * Função pura para ser testável e reutilizável (UI e exportações).
 */
export function auditSupplierLinks(
  products: AuditableProduct[],
  suppliers: AuditableSupplier[],
  links: AuditableLink[],
): LinkAuditResult {
  const issues: LinkIssue[] = [];
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const byProduct = new Map<string, AuditableLink[]>();
  const bySupplier = new Map<string, AuditableLink[]>();

  for (const link of links) {
    byProduct.set(link.product_id, [...(byProduct.get(link.product_id) ?? []), link]);
    bySupplier.set(link.supplier_id, [...(bySupplier.get(link.supplier_id) ?? []), link]);
  }

  const activeProducts = products.filter((p) => p.active !== false);

  for (const product of activeProducts) {
    const list = byProduct.get(product.id) ?? [];

    if (list.length === 0) {
      issues.push({
        severity: "critico",
        kind: "sem_fornecedor",
        title: product.name,
        detail: "Produto ativo sem nenhum fornecedor vinculado — a Reposição não sabe quem contatar.",
        productId: product.id,
      });
      continue;
    }

    const preferred = list.filter((l) => l.is_preferred === true);
    if (preferred.length === 0) {
      issues.push({
        severity: "aviso",
        kind: "sem_preferencial",
        title: product.name,
        detail: `${list.length} fornecedor(es) vinculado(s), nenhum marcado como preferencial.`,
        productId: product.id,
      });
    } else if (preferred.length > 1) {
      issues.push({
        severity: "critico",
        kind: "preferencial_duplicado",
        title: product.name,
        detail: `${preferred.length} fornecedores marcados como preferenciais — mantenha apenas um.`,
        productId: product.id,
      });
    }

    for (const link of list) {
      if (Number(link.unit_cost ?? 0) <= 0) {
        const supplier = supplierById.get(link.supplier_id);
        issues.push({
          severity: "aviso",
          kind: "custo_zerado",
          title: `${product.name} · ${supplier?.name ?? "fornecedor removido"}`,
          detail: "Custo unitário zerado: o pedido de compra sai sem valor estimado.",
          productId: product.id,
          supplierId: link.supplier_id,
        });
      }
    }
  }

  for (const supplier of suppliers) {
    const list = bySupplier.get(supplier.id) ?? [];
    if (list.length === 0) {
      issues.push({
        severity: "aviso",
        kind: "fornecedor_sem_produto",
        title: supplier.name,
        detail: "Fornecedor cadastrado sem nenhum produto vinculado.",
        supplierId: supplier.id,
      });
    }
    if (!supplier.phone && !supplier.email && list.length > 0) {
      issues.push({
        severity: "critico",
        kind: "sem_contato",
        title: supplier.name,
        detail: "Fornecedor atende produtos mas não tem telefone nem e-mail para contato.",
        supplierId: supplier.id,
      });
    }
  }

  return {
    issues,
    counts: {
      critico: issues.filter((i) => i.severity === "critico").length,
      aviso: issues.filter((i) => i.severity === "aviso").length,
    },
    linkedProducts: activeProducts.filter((p) => (byProduct.get(p.id) ?? []).length > 0).length,
    totalActiveProducts: activeProducts.length,
  };
}
