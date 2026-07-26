const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "rede", name: "Rede TEF", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "rede",
    name: "Rede",
    modules: ["node-rede-tef", "rede-tef", "./vendor/rede"],
    docs: "https://developer.userede.com.br/",
  }),
};
