const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "banrisul", name: "Banrisul TEF Dedicado", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "banrisul",
    name: "Banrisul TEF Dedicado",
    modules: ["node-banrisul-tef", "banrisul-tef", "./vendor/banrisul"],
    docs: "https://www.banrisul.com.br/",
  }),
};
