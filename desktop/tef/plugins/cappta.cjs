const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "cappta", name: "Cappta", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "cappta",
    name: "Cappta",
    modules: ["node-cappta", "cappta-sdk", "./vendor/cappta"],
    docs: "https://developers.cappta.com.br/",
  }),
};
