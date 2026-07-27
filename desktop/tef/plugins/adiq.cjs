const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "adiq", name: "Adiq", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "adiq",
    name: "Adiq",
    modules: ["node-adiq-tef", "adiq-tef", "./vendor/adiq"],
    docs: "https://developers.adiq.io/",
  }),
};
