/**
 * Contrato base de um driver TEF (plugin).
 *
 * Todo plugin DEVE exportar `createDriver(config, emit)` devolvendo um objeto
 * que implemente esta interface. O restante do agente e o PDV jamais conhecem
 * o fornecedor — só falam com esta interface e com o formato único de resposta.
 *
 *   initialize()      → prepara SDK/DLL, carrega credenciais
 *   connect()         → abre sessão com o PIN Pad
 *   disconnect()      → encerra sessão
 *   startSale(req)    → executa venda; emite eventos durante o fluxo
 *   cancelSale(req)   → cancela/estorna transação (por NSU)
 *   reprintReceipt()  → reimprime último comprovante
 *   getStatus()       → estado atual normalizado
 *   getDevices()      → periféricos vistos pelo driver
 *   healthCheck()     → { available, reason }
 *   dispose()         → libera recursos
 */

/** Estados normalizados do fluxo TEF. */
const TEF_STATES = Object.freeze([
  "idle",
  "waiting_card",
  "insert_card",
  "tap_card",
  "remove_card",
  "pin_required",
  "processing",
  "approved",
  "denied",
  "cancelled",
  "timeout",
  "error",
  "receipt_ready",
]);

/**
 * Normaliza qualquer retorno de SDK para o formato único do sistema.
 * @param {object} raw
 * @returns {object}
 */
function normalizeResult(raw = {}) {
  const status = String(raw.status || (raw.success ? "APPROVED" : "ERROR")).toUpperCase();
  return {
    success: status === "APPROVED",
    status,
    nsu: raw.nsu ?? null,
    authorizationCode: raw.authorizationCode ?? raw.autorizacao ?? null,
    acquirer: raw.acquirer ?? raw.rede ?? null,
    provider: raw.provider ?? null,
    cardBrand: raw.cardBrand ?? raw.bandeira ?? null,
    cardType: raw.cardType ?? raw.paymentType ?? null,
    installments: Number(raw.installments ?? 1),
    amount: Number(raw.amount ?? 0),
    orderId: raw.orderId ?? null,
    transactionId: raw.transactionId ?? raw.nsu ?? null,
    receiptCustomer: raw.receiptCustomer ?? null,
    receiptMerchant: raw.receiptMerchant ?? null,
    message: raw.message ?? raw.error ?? null,
    timestamp: raw.timestamp ?? new Date().toISOString(),
  };
}

/** Erro padronizado de driver indisponível (SDK proprietário ausente). */
class DriverUnavailableError extends Error {
  constructor(providerId, reason) {
    super(reason);
    this.name = "DriverUnavailableError";
    this.providerId = providerId;
    this.code = "DRIVER_UNAVAILABLE";
  }
}

module.exports = { TEF_STATES, normalizeResult, DriverUnavailableError };
