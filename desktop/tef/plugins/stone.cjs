const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "stone", name: "Stone TEF", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "stone",
    name: "Stone",
    modules: ["node-stone-tef", "stone-tef", "./vendor/stone"],
    docs: "https://sdks.stone.com.br/",
  }),
};
