const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "gertec", name: "Gertec PPC / PIN Pad", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "gertec",
    name: "Gertec PPC / PIN Pad",
    modules: ["node-gertec-pinpad", "gertec-pinpad", "./vendor/gertec"],
    docs: "https://www.gertec.com.br/",
  }),
};
