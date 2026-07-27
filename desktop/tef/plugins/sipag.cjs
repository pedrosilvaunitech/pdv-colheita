const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "sipag", name: "Sipag (Sicredi)", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "sipag",
    name: "Sipag (Sicredi)",
    modules: ["node-sipag-tef", "sipag-tef", "./vendor/sipag"],
    docs: "https://www.sipag.com.br/",
  }),
};
