const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "bin", name: "BIN / NTK TEF Dedicado", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "bin",
    name: "BIN/NTK",
    modules: ["node-bin-tef", "ntk-tef", "./vendor/bin"],
    docs: "https://www.ntksolutions.com.br/",
  }),
};
