// Adapters de PSPs PIX. SERVER-ONLY (.server.ts).
// Cada adapter recebe config + valor e retorna cobrança dinâmica normalizada.

export interface DynamicPixInput {
  amount: number;
  description: string;
  txid: string;
  expiresInSec?: number;
  payerName?: string;
  payerDoc?: string;
  webhookUrl?: string;
}

export interface DynamicPixResult {
  brcode: string;                    // copia-e-cola
  qrImageBase64?: string;            // dataURL ou base64 puro (PNG)
  externalId: string;                // id do PSP para consulta/webhook
  expiresAt?: string;                // ISO
  raw: unknown;
}

// ============ MERCADO PAGO ============
// Auth: Bearer <ACCESS_TOKEN>
// Endpoint: POST https://api.mercadopago.com/v1/payments
export async function mpCreatePixCharge(
  accessToken: string,
  input: DynamicPixInput,
): Promise<DynamicPixResult> {
  const body = {
    transaction_amount: Number(input.amount.toFixed(2)),
    description: input.description.slice(0, 256),
    payment_method_id: "pix",
    external_reference: input.txid,
    date_of_expiration: input.expiresInSec
      ? new Date(Date.now() + input.expiresInSec * 1000).toISOString()
      : undefined,
    payer: {
      email: `${input.payerDoc || "pagador"}@pdv.local`.replace(/[^a-z0-9@._-]/gi, ""),
      first_name: input.payerName || "Cliente",
      identification: input.payerDoc
        ? { type: input.payerDoc.length === 11 ? "CPF" : "CNPJ", number: input.payerDoc.replace(/\D/g, "") }
        : undefined,
    },
    notification_url: input.webhookUrl,
  };
  const res = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": input.txid,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Mercado Pago [${res.status}]: ${JSON.stringify(json)}`);
  const poi = (json.point_of_interaction as { transaction_data?: { qr_code?: string; qr_code_base64?: string } })?.transaction_data;
  if (!poi?.qr_code) throw new Error("Mercado Pago não retornou QR code");
  return {
    brcode: poi.qr_code,
    qrImageBase64: poi.qr_code_base64 ? `data:image/png;base64,${poi.qr_code_base64}` : undefined,
    externalId: String(json.id),
    expiresAt: (json.date_of_expiration as string) || undefined,
    raw: json,
  };
}

export async function mpCheckStatus(accessToken: string, externalId: string): Promise<"pendente" | "pago" | "expirado" | "cancelado"> {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${externalId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const j = (await res.json()) as { status?: string };
  if (!res.ok) throw new Error(`Mercado Pago status: ${res.status}`);
  switch (j.status) {
    case "approved": return "pago";
    case "cancelled": return "cancelado";
    case "expired": return "expirado";
    default: return "pendente";
  }
}

// ============ ASAAS ============
// Auth: header `access_token: <key>`
// Endpoint estático (QR dinâmico avulso): POST /api/v3/pix/qrCodes/static (ou /pix/pay)
// Aqui usamos /api/v3/payments + /pix/qrCode pra flow de cobrança.
export async function asaasCreatePixCharge(
  apiKey: string,
  env: "sandbox" | "producao",
  input: DynamicPixInput,
): Promise<DynamicPixResult> {
  const base = env === "producao" ? "https://api.asaas.com/v3" : "https://sandbox.asaas.com/api/v3";
  // Fluxo: cria QR estático dinâmico (não requer cliente cadastrado)
  const res = await fetch(`${base}/pix/qrCodes/static`, {
    method: "POST",
    headers: { access_token: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      addressKey: undefined,                // opcional; Asaas usa chave PIX cadastrada na conta
      description: input.description,
      value: Number(input.amount.toFixed(2)),
      format: "PAYLOAD",
      expirationDate: input.expiresInSec
        ? new Date(Date.now() + input.expiresInSec * 1000).toISOString().slice(0, 10)
        : undefined,
      allowsMultiplePayments: false,
    }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Asaas [${res.status}]: ${JSON.stringify(json)}`);
  const payload = (json.payload as string) || (json.encodedImage as string);
  const image = json.encodedImage ? `data:image/png;base64,${json.encodedImage as string}` : undefined;
  return {
    brcode: payload,
    qrImageBase64: image,
    externalId: String(json.id),
    raw: json,
  };
}

export async function asaasCheckStatus(apiKey: string, env: "sandbox" | "producao", externalId: string) {
  const base = env === "producao" ? "https://api.asaas.com/v3" : "https://sandbox.asaas.com/api/v3";
  const res = await fetch(`${base}/pix/qrCodes/static/${externalId}`, {
    headers: { access_token: apiKey },
  });
  const j = (await res.json()) as { status?: string };
  if (!res.ok) return "pendente" as const;
  return j.status === "ACTIVE" ? "pendente" : j.status === "PAID" ? "pago" : "pendente";
}

// ============ EFÍ (Gerencianet) — requer mTLS com .p12 ============
// Fluxo: POST /oauth/token (Basic auth client_id:client_secret) → Bearer para POST /v2/cob
// LIMITAÇÃO: Cloudflare Workers não suporta mTLS em fetch. Este adapter só funciona
// em runtime Node.js/servidor próprio. Retornamos erro claro se rodar em Worker.
export async function efiCreatePixCharge(
  _clientId: string,
  _clientSecret: string,
  _certificatePfxBase64: string,
  _env: "sandbox" | "producao",
  _input: DynamicPixInput,
): Promise<DynamicPixResult> {
  throw new Error(
    "Efí PIX requer mTLS (certificado .p12) que o runtime Edge deste PDV não suporta. " +
    "Use Mercado Pago ou Asaas, ou hospede um proxy Node.js dedicado."
  );
}

// ============ INTER / SICOOB / SICREDI — Open Finance mTLS ============
// Mesma limitação da Efí — mTLS obrigatório.
export async function bankCreatePixCharge(
  _bankSlug: "inter" | "sicoob" | "sicredi",
  _clientId: string,
  _clientSecret: string,
  _certificatePfxBase64: string,
  _env: "sandbox" | "producao",
  _input: DynamicPixInput,
): Promise<DynamicPixResult> {
  throw new Error(
    "PIX direto pelo banco (Inter/Sicoob/Sicredi) requer mTLS não suportado no runtime Edge. " +
    "Recomendação: use Mercado Pago (mais simples) ou Asaas."
  );
}
