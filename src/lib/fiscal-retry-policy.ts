/**
 * Política de retentativa fiscal — regra única para todo o sistema.
 *
 * Antes, a decisão de "tentar de novo ou desistir" estava espalhada entre o
 * banco (backoff em `complete_fiscal_job`), o cliente de emissão
 * (`isRecoverableAgentError`) e a tela de erros. Aqui centralizamos a
 * classificação do erro e o cronograma de novas tentativas, para que agente,
 * fila e UI concordem sobre o mesmo diagnóstico.
 *
 * Princípio: só reagendar o que pode dar certo sozinho. Rejeição de conteúdo
 * (XML inválido, CSC errado, certificado vencido) falharia de novo em qualquer
 * motor e por isso vira pendência manual imediatamente.
 */

export type FiscalErrorClass =
  /** Motor/agente/rede indisponível — tende a se resolver sozinho. */
  | "transient"
  /** SEFAZ fora do ar ou em manutenção (cStat 108/109/999). */
  | "sefaz_down"
  /** Excesso de conexões / consumo indevido (cStat 656) — exige recuo maior. */
  | "throttled"
  /** Conteúdo rejeitado — exige correção humana. */
  | "permanent"
  /** Não foi possível classificar: tratado como transitório, com teto menor. */
  | "unknown";

export interface RetryDecision {
  class: FiscalErrorClass;
  /** A fila deve reagendar automaticamente? */
  retryable: boolean;
  /** Marcar o job como definitivo (sai do ciclo automático)? */
  permanent: boolean;
  /** Espera até a próxima tentativa, em milissegundos. */
  delayMs: number;
  /** Teto de tentativas automáticas para esta classe. */
  maxAttempts: number;
  /** Explicação em linguagem de operador. */
  reason: string;
}

/** Teto global — mesmo valor usado por `fiscal_queue.max_attempts`. */
export const DEFAULT_MAX_ATTEMPTS = 6;

const TRANSIENT_RE =
  /offline|failed to fetch|load failed|ECONNREFUSED|ETIMEDOUT|timeout|abort|não carregado|nao carregado|501|não instalado|nao instalado|indispon[ií]vel|502|503|504|network|socket/i;

const SEFAZ_DOWN_RE = /cstat\s*(108|109|999)|manuten[çc][ãa]o|servi[çc]o\s+paralisado|em\s+manuten/i;

const THROTTLE_RE = /cstat\s*656|consumo\s+indevido|too\s+many\s+requests|429|rate\s*limit/i;

const PERMANENT_RE =
  /cstat\s*(2\d\d|3\d\d|4\d\d|5\d\d)|rejei[çc][ãa]o|certificado\s+(vencido|inv[áa]lido|expirado)|csc\s+(inv[áa]lido|incorreto)|assinatura\s+inv[áa]lida|xml\s+inv[áa]lido|duplicidade|ie\s+inv[áa]lida|cnpj\s+inv[áa]lido/i;

/** Classifica a mensagem de erro devolvida por qualquer motor fiscal. */
export function classifyFiscalError(error?: string | null): FiscalErrorClass {
  if (!error) return "transient";
  if (THROTTLE_RE.test(error)) return "throttled";
  if (SEFAZ_DOWN_RE.test(error)) return "sefaz_down";
  if (PERMANENT_RE.test(error)) return "permanent";
  if (TRANSIENT_RE.test(error)) return "transient";
  return "unknown";
}

/** Backoff exponencial com jitter, limitado por classe. */
function backoff(attempt: number, baseMs: number, capMs: number): number {
  const exp = Math.min(capMs, baseMs * Math.pow(4, Math.max(0, attempt - 1)));
  // Jitter de ±20% evita que vários caixas voltem à SEFAZ no mesmo instante.
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.max(1_000, Math.round(exp + jitter));
}

/**
 * Decide o destino de um job após uma falha.
 *
 * @param error    mensagem devolvida pelo motor
 * @param attempts tentativas já realizadas (incluindo a que acabou de falhar)
 */
export function decideRetry(error: string | null | undefined, attempts: number): RetryDecision {
  const cls = classifyFiscalError(error);

  const table: Record<FiscalErrorClass, { base: number; cap: number; max: number; reason: string }> = {
    transient: {
      base: 60_000,
      cap: 15 * 60_000,
      max: DEFAULT_MAX_ATTEMPTS,
      reason: "Motor ou rede indisponível no momento — a fila tenta de novo sozinha.",
    },
    sefaz_down: {
      base: 5 * 60_000,
      cap: 60 * 60_000,
      max: 12,
      reason: "SEFAZ fora do ar ou em manutenção — espera maior antes de insistir.",
    },
    throttled: {
      base: 10 * 60_000,
      cap: 60 * 60_000,
      max: 8,
      reason: "A SEFAZ sinalizou excesso de consultas — recuo obrigatório antes de reenviar.",
    },
    unknown: {
      base: 2 * 60_000,
      cap: 30 * 60_000,
      max: 4,
      reason: "Erro não reconhecido — poucas tentativas automáticas antes de pedir revisão.",
    },
    permanent: {
      base: 0,
      cap: 0,
      max: 0,
      reason: "Nota rejeitada por conteúdo — corrija o cadastro/configuração e reemita manualmente.",
    },
  };

  const cfg = table[cls];
  const exhausted = cls !== "permanent" && attempts >= cfg.max;
  const permanent = cls === "permanent" || exhausted;

  return {
    class: cls,
    retryable: !permanent,
    permanent,
    delayMs: permanent ? 0 : backoff(attempts, cfg.base, cfg.cap),
    maxAttempts: cfg.max,
    reason: exhausted
      ? `Limite de ${cfg.max} tentativas automáticas atingido — requer ação manual.`
      : cfg.reason,
  };
}

export const ERROR_CLASS_LABEL: Record<FiscalErrorClass, string> = {
  transient: "Indisponibilidade temporária",
  sefaz_down: "SEFAZ indisponível",
  throttled: "Bloqueio por excesso de consultas",
  permanent: "Rejeição definitiva",
  unknown: "Erro não classificado",
};

/** Quando a próxima tentativa deve acontecer, em ISO, a partir de agora. */
export function nextAttemptAt(decision: RetryDecision, from: Date = new Date()): string | null {
  if (!decision.retryable) return null;
  return new Date(from.getTime() + decision.delayMs).toISOString();
}
