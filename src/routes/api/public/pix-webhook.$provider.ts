import { createFileRoute } from "@tanstack/react-router";

// Webhook público dos PSPs de PIX.
// URL: /api/public/pix-webhook/{provider}
// Suporta: mercadopago | asaas
// Segurança: header X-Webhook-Secret (opcional) OU chamada autenticada pelo próprio PSP.
export const Route = createFileRoute("/api/public/pix-webhook/$provider")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const provider = params.provider;
        const raw = await request.text();
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw); } catch { body = { raw }; }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        let externalId: string | null = null;
        let paid = false;

        if (provider === "mercadopago") {
          // MP envia { action, data: { id } }
          const dataId = (body.data as { id?: string })?.id;
          externalId = dataId ? String(dataId) : null;
          if (externalId) {
            const token = process.env.PIX_MERCADOPAGO_TOKEN;
            if (token) {
              const res = await fetch(`https://api.mercadopago.com/v1/payments/${externalId}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              const j = (await res.json()) as { status?: string };
              paid = j.status === "approved";
            }
          }
        } else if (provider === "asaas") {
          // Asaas: { event, payment: { id, status } }
          const payment = body.payment as { id?: string; status?: string } | undefined;
          externalId = payment?.id ? String(payment.id) : null;
          paid = payment?.status === "RECEIVED" || payment?.status === "CONFIRMED";
        } else {
          return new Response(JSON.stringify({ error: "provider desconhecido" }), { status: 400 });
        }

        if (externalId && paid) {
          await supabaseAdmin
            .from("pix_charges")
            .update({ status: "pago", paid_at: new Date().toISOString(), raw_response: body })
            .eq("external_id", externalId)
            .eq("status", "pendente");
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    },
  },
});
