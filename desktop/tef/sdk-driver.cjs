/**
 * Fábrica compartilhada de drivers TEF baseados em SDK proprietário.
 *
 * Cada fornecedor (SiTef, PayGo, Cappta, …) distribui seu próprio SDK/DLL
 * mediante contrato e homologação. Aqui carregamos dinamicamente o módulo
 * quando ele existir na pasta do agente; caso contrário o driver reporta
 * `available:false` com instrução clara, sem quebrar o restante do sistema.
 *
 * Contrato esperado do SDK (adaptado por `map`):
 *   sdk.init(config) · sdk.sale(payload) · sdk.cancel(payload)
 *   sdk.reprint() · sdk.status() · sdk.devices()
 */

const { normalizeResult, DriverUnavailableError } = require("./provider.cjs");

/**
 * @param {{ id:string, name:string, modules:string[], docs:string, map?:object }} spec
 */
function createSdkDriver(spec) {
  const { id, name, modules, docs, map = {} } = spec;

  return function createDriver(config = {}, emit = () => {}) {
    let sdk = null;
    let loadError = null;
    let state = "idle";
    let lastResult = null;

    function loadSdk() {
      if (sdk || loadError) return sdk;
      for (const mod of modules) {
        try {
          // eslint-disable-next-line global-require, import/no-dynamic-require
          sdk = require(mod);
          return sdk;
        } catch (e) {
          loadError = e;
        }
      }
      return null;
    }

    function unavailable() {
      return new DriverUnavailableError(
        id,
        `SDK do provedor ${name} não encontrado no agente. Instale o pacote oficial (${modules.join(" ou ")}) na pasta do agente e reinicie. Documentação: ${docs}`,
      );
    }

    function setState(next, extra) {
      state = next;
      emit({ provider: id, state: next, at: new Date().toISOString(), ...extra });
    }

    function call(method, args) {
      const s = loadSdk();
      if (!s) throw unavailable();
      const fn = map[method] ? map[method](s) : s[method];
      if (typeof fn !== "function") {
        throw new DriverUnavailableError(id, `Método "${method}" ausente no SDK ${name}.`);
      }
      return fn.call(s, args);
    }

    return {
      id,
      name,

      async initialize() {
        const s = loadSdk();
        if (!s) return { ok: false, error: unavailable().message };
        try {
          if (typeof s.init === "function") await s.init(config);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },

      async connect() {
        const s = loadSdk();
        if (!s) throw unavailable();
        if (typeof s.connect === "function") await s.connect(config);
        return { ok: true };
      },

      async disconnect() {
        if (sdk && typeof sdk.disconnect === "function") await sdk.disconnect();
        setState("idle");
        return { ok: true };
      },

      async startSale(req) {
        setState("waiting_card", { orderId: req.orderId, amount: req.amount });
        try {
          const raw = await call("sale", {
            amount: req.amount,
            paymentType: req.paymentType,
            installments: req.installments ?? 1,
            orderId: req.orderId,
            ...config.saleDefaults,
          });
          lastResult = normalizeResult({ ...raw, provider: id, orderId: req.orderId, amount: req.amount });
          setState(lastResult.success ? "approved" : "denied", { result: lastResult });
          if (lastResult.receiptCustomer || lastResult.receiptMerchant) setState("receipt_ready", { result: lastResult });
          return lastResult;
        } catch (e) {
          setState("error", { message: e.message, code: e.code });
          throw e;
        }
      },

      async cancelSale(req) {
        setState("processing", { action: "cancel" });
        const raw = await call("cancel", req);
        const result = normalizeResult({ ...raw, provider: id, status: raw?.status || "CANCELLED" });
        setState("cancelled", { result });
        return result;
      },

      async reprintReceipt(req) {
        const raw = await call("reprint", req);
        return { ok: true, provider: id, ...raw };
      },

      getStatus() {
        return { provider: id, state, lastResult };
      },

      async getDevices() {
        const s = loadSdk();
        if (!s || typeof s.devices !== "function") return { provider: id, devices: [] };
        return { provider: id, devices: await s.devices() };
      },

      healthCheck() {
        const s = loadSdk();
        return s
          ? { available: true, provider: id, name }
          : { available: false, provider: id, name, reason: unavailable().message };
      },

      dispose() {
        sdk = null;
        loadError = null;
        state = "idle";
      },
    };
  };
}

module.exports = { createSdkDriver };
