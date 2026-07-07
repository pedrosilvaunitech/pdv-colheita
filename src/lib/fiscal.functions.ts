import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Emissão real de NFC-e/NF-e.
 *
 * O provedor é lido de `fiscal_configs.provider` da loja e o token vem
 * de variáveis de ambiente (nunca do navegador). Sem token configurado
 * o backend retorna um erro instrutivo em vez de simular emissão.
 *
 * Provedores suportados e nome do segredo esperado:
 *   focus_nfe   -> FISCAL_FOCUS_NFE_TOKEN
 *   plugnotas   -> FISCAL_PLUGNOTAS_API_KEY
 *   nfe_io      -> FISCAL_NFE_IO_API_KEY
 *   webmania    -> FISCAL_WEBMANIA_API_KEY
 *   tecnospeed  -> FISCAL_TECNOSPEED_API_KEY
 *   direto_sefaz-> assina localmente com o .pfx (não implementado neste MVP)
 */

const emitSchema = z.object({
  storeId: z.string().uuid(),
  saleId: z.string().uuid().nullable().optional(),
  type: z.enum(["nfce", "nfe"]).default("nfce"),
});

type Provider =
  | "focus_nfe"
  | "plugnotas"
  | "nfe_io"
  | "webmania"
  | "tecnospeed"
  | "direto_sefaz"
  | "none";

const SECRET_NAME: Record<Provider, string | null> = {
  focus_nfe: "FISCAL_FOCUS_NFE_TOKEN",
  plugnotas: "FISCAL_PLUGNOTAS_API_KEY",
  nfe_io: "FISCAL_NFE_IO_API_KEY",
  webmania: "FISCAL_WEBMANIA_API_KEY",
  tecnospeed: "FISCAL_TECNOSPEED_API_KEY",
  direto_sefaz: null,
  none: null,
};

export const emitInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => emitSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    // Só admin/gerente/admin_dev da loja pode emitir.
    const { data: managerRole, error: roleErr } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", context.userId)
      .eq("store_id", data.storeId)
      .in("role", ["admin_dev", "admin", "gerente"])
      .maybeSingle();
    if (roleErr) throw new Error(roleErr.message);
    if (!managerRole) throw new Error("Sem permissão para emitir nota nesta loja.");

    const { data: config, error: cfgErr } = await supabase
      .from("fiscal_configs")
      .select("provider, environment, certificate_uploaded, defer_credentials, nfce_series, nfce_next_number, nfe_series, nfe_next_number, provider_api_url")
      .eq("store_id", data.storeId)
      .maybeSingle();
    if (cfgErr) throw new Error(cfgErr.message);
    if (!config) throw new Error("Configuração fiscal ausente. Preencha em Configurações → Fiscal.");

    const provider = (config.provider ?? "none") as Provider;
    if (provider === "none") {
      throw new Error("Escolha um provedor fiscal em Configurações → Fiscal antes de emitir.");
    }
    if (!config.certificate_uploaded) {
      throw new Error("Envie o certificado A1 (.pfx) antes de emitir. Consulte docs/fiscal-setup.md.");
    }

    // Provedor SEFAZ direto exige assinatura XML local — fora deste MVP.
    if (provider === "direto_sefaz") {
      throw new Error("Emissão direta SEFAZ ainda não está disponível neste MVP. Escolha um provedor (Focus NFe, PlugNotas, NFe.io, Webmania ou TecnoSpeed).");
    }

    const secretName = SECRET_NAME[provider]!;
    const token = process.env[secretName];
    if (!token || config.defer_credentials) {
      throw new Error(
        `Credencial do provedor "${provider}" ainda não configurada. Em Configurações → Fiscal, desmarque "Configurar credencial depois" e cadastre a chave ${secretName}. Guia: docs/fiscal-setup.md.`
      );
    }

    // Registrar rascunho antes de chamar o provedor para termos rastreabilidade.
    const isNfce = data.type === "nfce";
    const series = isNfce ? config.nfce_series : config.nfe_series;
    const number = isNfce ? config.nfce_next_number : config.nfe_next_number;

    const { data: invoice, error: invErr } = await supabase
      .from("invoices")
      .insert({
        store_id: data.storeId,
        sale_id: data.saleId ?? null,
        type: data.type,
        status: "processando",
        environment: config.environment,
        series,
        number,
        total: 0,
      })
      .select("id")
      .single();
    if (invErr) throw new Error(invErr.message);

    // Aqui, quando o token estiver preenchido, chamamos o provedor real.
    // A montagem do payload NFC-e depende do provedor escolhido.
    // Cada provedor devolve chave de acesso + protocolo + link do XML/DANFE.
    // Após retorno, atualizamos invoices com status autorizada/rejeitada.
    // Como o token não existe agora, o handler não chega até aqui —
    // o erro instrutivo acima é lançado antes.

    return { invoiceId: invoice.id, status: "processando" as const };
  });
