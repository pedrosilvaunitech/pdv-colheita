import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { buildStaticPixBRCode, generatePixTxid } from "./pix-brcode";
import QRCode from "qrcode";

const createSchema = z.object({
  storeId: z.string().uuid(),
  saleId: z.string().uuid().optional(),
  amount: z.number().positive(),
  description: z.string().default("Venda PDV"),
  expiresInSec: z.number().int().positive().max(3600).default(600),
  payerName: z.string().optional(),
  payerDoc: z.string().optional(),
});

async function toQrImage(brcode: string): Promise<string> {
  try {
    return await QRCode.toDataURL(brcode, { errorCorrectionLevel: "M", width: 320, margin: 1 });
  } catch {
    return "";
  }
}

export const createPixCharge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => createSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: cfg, error: cfgErr } = await supabase
      .from("pix_configs")
      .select("*")
      .eq("store_id", data.storeId)
      .maybeSingle();
    if (cfgErr) throw new Error(cfgErr.message);
    if (!cfg) throw new Error("PIX não configurado. Vá em Configurações → PIX.");

    const txid = generatePixTxid();
    let brcode = "";
    let qrImage = "";
    let externalId: string | null = null;
    let provider = cfg.mode as string;
    let expiresAt: string | null = null;
    let raw: unknown = null;

    if (cfg.mode === "estatico") {
      if (!cfg.pix_key || !cfg.merchant_name || !cfg.merchant_city) {
        throw new Error("Configure chave PIX, nome e cidade do recebedor.");
      }
      brcode = buildStaticPixBRCode({
        key: cfg.pix_key,
        merchantName: cfg.merchant_name,
        merchantCity: cfg.merchant_city,
        amount: data.amount,
        txid,
        description: data.description,
      });
      qrImage = await toQrImage(brcode);
    } else {
      // Dinâmico via PSP — carrega credenciais do Vault do Supabase Edge Secrets
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const env = (cfg.environment || "sandbox") as "sandbox" | "producao";
      const secretName = `PIX_${cfg.mode.toUpperCase()}_${data.storeId.replace(/-/g, "").slice(0, 8)}`;
      // Simplificação: usamos secret padrão por loja: PIX_<PROVIDER>_TOKEN (única por conta)
      const genericKey = `PIX_${cfg.mode.toUpperCase()}_TOKEN`;
      const token = process.env[secretName] || process.env[genericKey];
      if (!token) {
        throw new Error(
          `Credencial do provedor ${cfg.mode} não configurada. Salve o segredo ${genericKey} nas configurações do backend.`
        );
      }

      const webhookUrl = process.env.PIX_WEBHOOK_BASE_URL
        ? `${process.env.PIX_WEBHOOK_BASE_URL}/api/public/pix-webhook/${cfg.mode}`
        : undefined;

      const providers = await import("./pix-providers.server");
      const input = {
        amount: data.amount,
        description: data.description,
        txid,
        expiresInSec: data.expiresInSec,
        payerName: data.payerName,
        payerDoc: data.payerDoc,
        webhookUrl,
      };

      let result;
      if (cfg.mode === "mercadopago") result = await providers.mpCreatePixCharge(token, input);
      else if (cfg.mode === "asaas") result = await providers.asaasCreatePixCharge(token, env, input);
      else if (cfg.mode === "efi") throw new Error("Efí PIX indisponível no runtime atual (requer mTLS).");
      else if (cfg.mode === "inter") throw new Error("PIX bancário direto indisponível no runtime atual (requer mTLS).");
      else throw new Error("Provedor desconhecido");

      brcode = result.brcode;
      qrImage = result.qrImageBase64 || (await toQrImage(brcode));
      externalId = result.externalId;
      expiresAt = result.expiresAt || null;
      raw = result.raw;
      void supabaseAdmin; // reservado p/ auditoria futura
    }

    if (!expiresAt) expiresAt = new Date(Date.now() + data.expiresInSec * 1000).toISOString();

    const { data: charge, error } = await supabase
      .from("pix_charges")
      .insert({
        store_id: data.storeId,
        sale_id: data.saleId ?? null,
        provider,
        txid,
        external_id: externalId,
        amount: data.amount,
        brcode,
        qr_image: qrImage,
        status: "pendente",
        expires_at: expiresAt,
        raw_response: (raw as never) ?? null,
        created_by: userId,
      })
      .select("id,txid,brcode,qr_image,status,expires_at,external_id,provider")
      .single();
    if (error) throw new Error(error.message);
    return charge;
  });

export const checkPixCharge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ chargeId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: charge, error } = await supabase
      .from("pix_charges")
      .select("*")
      .eq("id", data.chargeId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!charge) throw new Error("Cobrança não encontrada");
    if (charge.status !== "pendente") return { status: charge.status, charge };

    // Poll no provedor
    if (charge.provider === "mercadopago" && charge.external_id) {
      const token = process.env.PIX_MERCADOPAGO_TOKEN;
      if (token) {
        const { mpCheckStatus } = await import("./pix-providers.server");
        const st = await mpCheckStatus(token, charge.external_id);
        if (st !== "pendente") {
          await supabase.from("pix_charges")
            .update({ status: st, paid_at: st === "pago" ? new Date().toISOString() : null })
            .eq("id", charge.id);
          return { status: st, charge: { ...charge, status: st } };
        }
      }
    }
    if (charge.provider === "asaas" && charge.external_id) {
      const token = process.env.PIX_ASAAS_TOKEN;
      if (token) {
        const { asaasCheckStatus } = await import("./pix-providers.server");
        const st = await asaasCheckStatus(token, "sandbox", charge.external_id);
        if (st === "pago") {
          await supabase.from("pix_charges")
            .update({ status: "pago", paid_at: new Date().toISOString() })
            .eq("id", charge.id);
          return { status: "pago" as const, charge: { ...charge, status: "pago" } };
        }
      }
    }
    return { status: "pendente" as const, charge };
  });

export const confirmPixManually = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ chargeId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("pix_charges")
      .update({ status: "pago", paid_at: new Date().toISOString() })
      .eq("id", data.chargeId)
      .eq("status", "pendente");
    if (error) throw new Error(error.message);
    return { ok: true };
  });
