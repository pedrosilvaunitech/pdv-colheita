const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "paygo", name: "PayGo (Setis)", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "paygo",
    name: "PayGo",
    modules: ["node-paygo", "paygo-integrado", "./vendor/paygo"],
    docs: "https://paygo.readme.io/",
  }),
};
