import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Análise de reposição por IA.
 *
 * A matemática (dias de cobertura, prazo do pedido, quantidade) é feita no
 * cliente por `replenishment-forecast.ts`. Esta função apenas envia o resumo
 * já calculado para a IA e recebe de volta uma leitura de comprador:
 * prioridade, risco de ruptura, o que negociar com o fornecedor e um plano
 * de compra por fornecedor.
 *
 * Nada é gravado no banco — é uma função de leitura/analítica.
 */

const ItemSchema = z.object({
  name: z.string(),
  unit: z.string(),
  currentStock: z.number(),
  avgDaily: z.number(),
  sold7d: z.number(),
  sold30d: z.number(),
  trendPercent: z.number(),
  daysUntilStockout: z.number().nullable(),
  daysToOrder: z.number().nullable(),
  leadTimeDays: z.number(),
  recommendedQty: z.number(),
  estimatedCost: z.number(),
  supplierName: z.string().nullable(),
});

const InputSchema = z.object({
  storeName: z.string().nullable().optional(),
  items: z.array(ItemSchema).min(1).max(60),
});

export type ReplenishmentAiItem = z.infer<typeof ItemSchema>;

export interface ReplenishmentAiInsight {
  produto: string;
  prioridade: "critica" | "alta" | "media" | "baixa";
  duracao_estoque: string;
  prazo_pedido: string;
  quantidade_sugerida: string;
  fornecedor: string;
  observacao: string;
}

export interface ReplenishmentAiReport {
  resumo: string;
  alertas: string[];
  itens: ReplenishmentAiInsight[];
  plano_fornecedores: { fornecedor: string; acao: string }[];
}

const SYSTEM_PROMPT = `Você é um analista de compras de varejo brasileiro (supermercado/conveniência).
Recebe uma tabela com métricas JÁ CALCULADAS de cada produto: estoque atual, média de venda por dia,
tendência da última semana, dias até a ruptura, dias restantes para emitir o pedido (já descontado o
prazo de entrega do fornecedor), quantidade sugerida e custo estimado.

Regras rígidas:
- NUNCA invente ou recalcule números. Use exatamente os valores recebidos, apenas arredondando para leitura humana.
- Escreva em português do Brasil, direto e operacional, como um comprador falaria com o dono da loja.
- "daysToOrder" negativo ou zero significa que o pedido JÁ está atrasado: prioridade crítica.
- Considere a tendência: item com alta forte na semana dura menos que a média mensal sugere; avise.
- Item sem histórico de venda (avgDaily 0) não é urgente: sugira apenas revisar cadastro/mínimo.
- Responda somente com JSON válido no formato solicitado, sem texto fora do JSON.`;

const JSON_SHAPE = `{
  "resumo": "2 a 3 frases sobre a situação geral da reposição",
  "alertas": ["frases curtas sobre os riscos mais graves"],
  "itens": [
    {
      "produto": "nome",
      "prioridade": "critica|alta|media|baixa",
      "duracao_estoque": "ex: dura cerca de 5 dias",
      "prazo_pedido": "ex: pedir até 03/08 (2 dias)",
      "quantidade_sugerida": "ex: 48 un (~R$ 210,00)",
      "fornecedor": "nome do fornecedor ou 'sem fornecedor vinculado'",
      "observacao": "o que fazer / o que negociar"
    }
  ],
  "plano_fornecedores": [
    { "fornecedor": "nome", "acao": "o que pedir e quando contatar" }
  ]
}`;

/** Extrai o primeiro objeto JSON de uma resposta, tolerando cercas de código. */
function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("A IA respondeu em um formato inesperado. Tente novamente.");
  }
}

export const analyzeReplenishment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data }): Promise<ReplenishmentAiReport> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) {
      throw new Error("A análise por IA não está configurada nesta instalação.");
    }

    const table = data.items.map((item) => ({
      produto: item.name,
      unidade: item.unit,
      estoque: Number(item.currentStock.toFixed(3)),
      media_dia: Number(item.avgDaily.toFixed(3)),
      vendas_7d: Number(item.sold7d.toFixed(2)),
      vendas_30d: Number(item.sold30d.toFixed(2)),
      tendencia_pct: Math.round(item.trendPercent),
      dias_ate_ruptura: item.daysUntilStockout == null ? null : Math.floor(item.daysUntilStockout),
      dias_para_pedir: item.daysToOrder == null ? null : Math.floor(item.daysToOrder),
      prazo_entrega_dias: item.leadTimeDays,
      qtd_sugerida: item.recommendedQty,
      custo_estimado: Number(item.estimatedCost.toFixed(2)),
      fornecedor: item.supplierName ?? "sem fornecedor vinculado",
    }));

    const userPrompt = [
      `Loja: ${data.storeName ?? "não informada"}`,
      `Data de referência: ${new Date().toLocaleDateString("pt-BR")}`,
      "",
      "Itens analisados (JSON):",
      JSON.stringify(table),
      "",
      "Responda com JSON neste formato:",
      JSON_SHAPE,
    ].join("\n");

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
      },
      body: JSON.stringify({
        model: "google/gemini-3.6-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (response.status === 429) {
      throw new Error("Muitas análises em sequência. Aguarde um instante e tente de novo.");
    }
    if (response.status === 402) {
      throw new Error("Os créditos de IA do workspace acabaram. Recarregue para continuar usando a análise.");
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Falha na análise por IA (${response.status}). ${detail.slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) throw new Error("A IA não retornou conteúdo. Tente novamente.");

    const parsed = parseJsonLoose(content) as Partial<ReplenishmentAiReport>;

    // Normalização defensiva: a UI nunca deve quebrar por campo ausente.
    return {
      resumo: typeof parsed.resumo === "string" ? parsed.resumo : "",
      alertas: Array.isArray(parsed.alertas) ? parsed.alertas.filter((a): a is string => typeof a === "string") : [],
      itens: Array.isArray(parsed.itens)
        ? parsed.itens.map((raw) => {
            const item = (raw ?? {}) as Partial<ReplenishmentAiInsight>;
            const prioridade = item.prioridade;
            return {
              produto: item.produto ?? "—",
              prioridade:
                prioridade === "critica" || prioridade === "alta" || prioridade === "media" || prioridade === "baixa"
                  ? prioridade
                  : "media",
              duracao_estoque: item.duracao_estoque ?? "—",
              prazo_pedido: item.prazo_pedido ?? "—",
              quantidade_sugerida: item.quantidade_sugerida ?? "—",
              fornecedor: item.fornecedor ?? "sem fornecedor vinculado",
              observacao: item.observacao ?? "",
            };
          })
        : [],
      plano_fornecedores: Array.isArray(parsed.plano_fornecedores)
        ? parsed.plano_fornecedores.map((raw) => {
            const plan = (raw ?? {}) as { fornecedor?: string; acao?: string };
            return { fornecedor: plan.fornecedor ?? "—", acao: plan.acao ?? "" };
          })
        : [],
    };
  });
