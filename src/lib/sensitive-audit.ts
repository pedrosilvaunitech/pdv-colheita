/**
 * Auditoria de alterações sensíveis.
 *
 * Configuração fiscal, endereço do servidor de emissão, impressora do caixa e
 * política de backup mudam raramente — mas quando mudam, mudam o resultado de
 * uma venda. Sem registro, a investigação de "a nota parou de sair ontem à
 * noite" não tem ponto de partida.
 *
 * O registro é gravado pela função `log_sensitive_change` (SECURITY DEFINER),
 * que confere o acesso do usuário à loja e grava autor e horário no servidor —
 * o front não escolhe quem assinou a mudança nem quando ela aconteceu. As
 * entradas aparecem na linha do tempo de auditoria em *Erros fiscais*.
 *
 * Regra dura: auditoria NUNCA derruba a ação auditada. Toda falha aqui é
 * registrada no console e engolida; perder um log é ruim, impedir o lojista de
 * salvar a configuração é pior.
 */

import { supabase } from "@/integrations/supabase/client";

/** Áreas auditadas. Catálogo fechado no app, texto livre no banco. */
export type SensitiveArea =
  | "servidor_fiscal"
  | "fiscal_config"
  | "impressora"
  | "backup"
  | "seguranca"
  | "terminal";

export interface SensitiveChangeInput {
  storeId: string | null | undefined;
  area: SensitiveArea;
  /** Verbo curto: "salvou", "exportou", "importou", "trocou"… */
  action: string;
  /** O que mudou, em linguagem de operador. Truncado em 1000 chars no banco. */
  detail?: string;
}

/** Rótulos das áreas para a UI de auditoria. */
export const SENSITIVE_AREA_LABEL: Record<string, string> = {
  servidor_fiscal: "Servidor fiscal",
  fiscal_config: "Configuração fiscal",
  impressora: "Impressora",
  backup: "Backup de configuração",
  seguranca: "Segurança",
  terminal: "Terminal / caixa",
};

/**
 * Registra a alteração. Retorna `true` quando o banco confirmou.
 * Nunca lança — ver nota de cabeçalho.
 */
export async function logSensitiveChange(input: SensitiveChangeInput): Promise<boolean> {
  if (!input.storeId) return false;
  try {
    const { error } = await supabase.rpc("log_sensitive_change", {
      _store_id: input.storeId,
      _area: input.area,
      _action: input.action,
      _detail: input.detail ?? undefined,
    });
    if (error) {
      console.warn("[sensitive-audit] não registrou:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[sensitive-audit] erro inesperado:", e);
    return false;
  }
}

/**
 * Descreve a diferença entre dois objetos de configuração em uma linha.
 * Só compara chaves presentes em `next`, e só reporta o que realmente mudou —
 * um log de "nada mudou" polui a auditoria tanto quanto log nenhum.
 *
 * @param sensitiveKeys chaves cujo VALOR não deve entrar no log (mostra "(oculto)").
 */
export function describeChanges(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
  sensitiveKeys: string[] = [],
): string {
  const secret = new Set(sensitiveKeys);
  const parts: string[] = [];

  for (const [key, value] of Object.entries(next)) {
    const before = previous?.[key];
    if (before === value) continue;
    if (secret.has(key)) {
      parts.push(`${key}: (oculto)`);
      continue;
    }
    parts.push(`${key}: ${format(before)} → ${format(value)}`);
  }

  return parts.join(" · ");
}

function format(value: unknown): string {
  if (value === null || value === undefined || value === "") return "vazio";
  if (typeof value === "boolean") return value ? "sim" : "não";
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
