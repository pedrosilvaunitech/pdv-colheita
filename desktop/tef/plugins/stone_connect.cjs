const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "stone_connect", name: "Stone Connect (Pagar.me)", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "stone_connect",
    name: "Stone Connect (Pagar.me)",
    modules: ["node-pagarme-tef", "pagarme-tef", "./vendor/pagarme"],
    docs: "https://docs.pagar.me/",
  }),
};
