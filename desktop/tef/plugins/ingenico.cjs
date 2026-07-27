const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "ingenico", name: "Ingenico / Telium TEF", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "ingenico",
    name: "Ingenico / Telium TEF",
    modules: ["node-ingenico-tef", "ingenico-tef", "./vendor/ingenico"],
    docs: "https://developer.ingenico.com/",
  }),
};
