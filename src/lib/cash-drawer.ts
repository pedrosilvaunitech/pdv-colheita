/**
 * Gaveta de dinheiro (cash drawer).
 *
 * No varejo brasileiro a gaveta quase nunca é ligada direto ao computador:
 * ela é plugada na porta RJ11/RJ12 da impressora térmica e aberta por um
 * pulso elétrico enviado como comando ESC/POS. Por isso o fluxo aqui é
 * exatamente o mesmo da impressão — Agente Local primeiro, depois
 * WebUSB/Web Serial — e nunca acesso direto ao hardware pelo navegador.
 *
 * Comando: ESC p m t1 t2  (1B 70 m t1 t2)
 *   m  = pino do conector (0 = pino 2, 1 = pino 5)
 *   t1 = tempo de pulso ligado  (x2ms)
 *   t2 = tempo de pulso desligado (x2ms)
 */

import { supabase } from "@/integrations/supabase/client";
import { sendRawEscPos } from "@/lib/escpos";
import { openDrawerViaAgent, getTerminalId, isPrintAgentEnabled } from "@/lib/print-agent";

export type DrawerReason = "manual" | "venda" | "sangria" | "suprimento" | "troca" | "teste";

export interface DrawerSettings {
  /** Abre a gaveta sozinha ao concluir a venda. */
  drawer_auto: boolean;
  /** Restringe a abertura automática a vendas com dinheiro/troco. */
  drawer_cash_only: boolean;
  /** 0 = pino 2 (padrão da maioria), 1 = pino 5. */
  drawer_pulse_pin: 0 | 1;
}

export const DEFAULT_DRAWER_SETTINGS: DrawerSettings = {
  drawer_auto: true,
  drawer_cash_only: true,
  drawer_pulse_pin: 0,
};

/** Monta o pulso ESC/POS de abertura. */
export function buildDrawerPulse(pin: 0 | 1 = 0): Uint8Array {
  // 0x19 (25 → 50ms) ligado, 0xFA (250 → 500ms) desligado: valores aceitos
  // pela quase totalidade das impressoras ESC/POS (Epson, Elgin, Bematech…).
  return new Uint8Array([0x1b, 0x70, pin, 0x19, 0xfa]);
}

export interface OpenDrawerResult {
  ok: boolean;
  channel: "agent" | "usb" | "serial" | "none";
  error?: string;
}

export interface OpenDrawerParams {
  storeId: string | null | undefined;
  reason?: DrawerReason;
  automatic?: boolean;
  saleId?: string | null;
  pin?: 0 | 1;
  /** false para não gravar auditoria (ex.: teste no diagnóstico). */
  audit?: boolean;
}

/**
 * Abre a gaveta e registra a auditoria. Nunca lança: devolve o canal usado
 * e a mensagem de erro para a UI decidir o que mostrar ao operador.
 */
export async function openCashDrawer(params: OpenDrawerParams): Promise<OpenDrawerResult> {
  const { storeId, reason = "manual", automatic = false, saleId = null, pin = 0, audit = true } = params;

  let result: OpenDrawerResult = { ok: false, channel: "none", error: "Nenhum canal disponível" };

  // 1) Agente Local — caminho preferencial: fala com a impressora do Windows
  //    (spooler ou USB) sem depender de permissão do navegador.
  if (isPrintAgentEnabled()) {
    try {
      await openDrawerViaAgent();
      result = { ok: true, channel: "agent" };
    } catch (e) {
      result = { ok: false, channel: "none", error: e instanceof Error ? e.message : String(e) };
    }
  }

  // 2) Fallback WebUSB / Web Serial usando o mesmo pipeline da impressão.
  if (!result.ok) {
    try {
      const diag = await sendRawEscPos(buildDrawerPulse(pin));
      if (diag.ok) {
        result = { ok: true, channel: diag.channel === "usb" ? "usb" : diag.channel === "serial" ? "serial" : "agent" };
      } else {
        result = { ok: false, channel: "none", error: diag.error ?? result.error };
      }
    } catch (e) {
      result = { ok: false, channel: "none", error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (audit && storeId) {
    // A auditoria é best-effort: falha de gravação não pode impedir a venda.
    try {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth.user?.id;
      if (userId) {
        await supabase.from("drawer_events").insert({
          store_id: storeId,
          sale_id: saleId,
          created_by: userId,
          terminal_id: getTerminalId(),
          reason,
          automatic,
          channel: result.channel,
          success: result.ok,
          error_message: result.error ?? null,
        });
      }
    } catch (e) {
      console.warn("[cash-drawer] falha ao registrar auditoria:", e);
    }
  }

  return result;
}

/**
 * Decide se a abertura automática deve acontecer após uma venda.
 * `hasCash` cobre pagamento em dinheiro e devolução de troco.
 */
export function shouldAutoOpen(settings: Partial<DrawerSettings> | null | undefined, hasCash: boolean): boolean {
  const s = { ...DEFAULT_DRAWER_SETTINGS, ...(settings ?? {}) };
  if (!s.drawer_auto) return false;
  if (s.drawer_cash_only && !hasCash) return false;
  return true;
}
