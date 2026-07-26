/**
 * Driver genérico / simulador.
 *
 * Serve para (a) homologar todo o fluxo do PDV sem hardware e sem contrato
 * TEF e (b) servir de referência para novos plugins. Em modo `simulate`
 * percorre todos os estados reais do fluxo com atrasos realistas.
 */

const crypto = require("crypto");
const { normalizeResult } = require("../provider.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createDriver(config = {}, emit = () => {}) {
  let state = "idle";
  let lastResult = null;
  let cancelRequested = false;

  const stepMs = Number(config.simulateStepMs ?? 900);

  function setState(next, extra) {
    state = next;
    emit({ provider: "generic", state: next, at: new Date().toISOString(), ...extra });
  }

  return {
    id: "generic",
    name: "Genérico (simulador/homologação)",

    async initialize() { return { ok: true, simulated: true }; },
    async connect() { return { ok: true }; },
    async disconnect() { setState("idle"); return { ok: true }; },

    async startSale(req) {
      cancelRequested = false;
      const amount = Number(req.amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Valor inválido para transação TEF.");

      setState("waiting_card", { orderId: req.orderId, amount });
      await sleep(stepMs);
      if (cancelRequested) { setState("cancelled"); return (lastResult = normalizeResult({ status: "CANCELLED", provider: "generic", orderId: req.orderId, amount })); }

      setState(req.paymentType === "credit" ? "insert_card" : "tap_card");
      await sleep(stepMs);
      setState("pin_required");
      await sleep(stepMs);
      if (cancelRequested) { setState("cancelled"); return (lastResult = normalizeResult({ status: "CANCELLED", provider: "generic", orderId: req.orderId, amount })); }

      setState("processing");
      await sleep(stepMs);
      setState("remove_card");

      const denied = config.simulateDenied === true;
      const nsu = crypto.randomBytes(4).readUInt32BE(0).toString().padStart(9, "0");
      lastResult = normalizeResult({
        status: denied ? "DENIED" : "APPROVED",
        provider: "generic",
        nsu,
        authorizationCode: crypto.randomBytes(3).toString("hex").toUpperCase(),
        acquirer: "SIMULADOR",
        cardBrand: "VISA",
        cardType: req.paymentType,
        installments: req.installments ?? 1,
        amount,
        orderId: req.orderId,
        transactionId: nsu,
        message: denied ? "Transação negada pelo emissor (simulado)" : "Transação aprovada (simulado)",
        receiptCustomer: buildReceipt("VIA CLIENTE", { nsu, amount, req }),
        receiptMerchant: buildReceipt("VIA ESTABELECIMENTO", { nsu, amount, req }),
      });
      setState(lastResult.success ? "approved" : "denied", { result: lastResult });
      if (lastResult.success) setState("receipt_ready", { result: lastResult });
      return lastResult;
    },

    async cancelSale(req) {
      cancelRequested = true;
      const result = normalizeResult({ status: "CANCELLED", provider: "generic", nsu: req?.nsu ?? null });
      setState("cancelled", { result });
      return result;
    },

    async reprintReceipt() {
      if (!lastResult) return { ok: false, error: "Nenhuma transação para reimprimir." };
      return { ok: true, provider: "generic", receiptCustomer: lastResult.receiptCustomer, receiptMerchant: lastResult.receiptMerchant };
    },

    getStatus() { return { provider: "generic", state, lastResult }; },
    async getDevices() { return { provider: "generic", devices: [{ type: "pinpad", name: "PIN Pad Simulado", status: "online" }] }; },
    healthCheck() { return { available: true, provider: "generic", name: "Genérico (simulador)" }; },
    dispose() { state = "idle"; lastResult = null; },
  };
}

function buildReceipt(title, { nsu, amount, req }) {
  const money = amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  return [
    "*** CUPOM TEF - SIMULADOR ***",
    title,
    `PEDIDO: ${req.orderId ?? "-"}`,
    `VALOR : ${money}`,
    `TIPO  : ${req.paymentType === "credit" ? "CREDITO" : "DEBITO"}`,
    `NSU   : ${nsu}`,
    new Date().toLocaleString("pt-BR"),
    "TRANSACAO NAO FINANCEIRA (TESTE)",
  ].join("\n");
}

module.exports = { meta: { id: "generic", name: "Genérico (simulador)", requiresSdk: false }, createDriver };
