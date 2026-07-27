const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "vero", name: "Vero (Banrisul)", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "vero",
    name: "Vero (Banrisul)",
    modules: ["node-vero-tef", "vero-tef", "./vendor/vero"],
    docs: "https://www.vero.com.br/",
  }),
};
