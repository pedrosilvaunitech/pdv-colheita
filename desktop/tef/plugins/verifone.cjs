const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "verifone", name: "Verifone TEF", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "verifone",
    name: "Verifone TEF",
    modules: ["node-verifone-tef", "verifone-tef", "./vendor/verifone"],
    docs: "https://developer.verifone.com/",
  }),
};
