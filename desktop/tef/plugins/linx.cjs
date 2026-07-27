const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "linx", name: "Linx TEF (DTEF)", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "linx",
    name: "Linx TEF (DTEF)",
    modules: ["node-linx-tef", "linx-dtef", "./vendor/linx"],
    docs: "https://www.linx.com.br/",
  }),
};
