const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "cielo", name: "Cielo LIO / TEF", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "cielo",
    name: "Cielo",
    modules: ["node-cielo-tef", "cielo-tef", "./vendor/cielo"],
    docs: "https://developercielo.github.io/",
  }),
};
