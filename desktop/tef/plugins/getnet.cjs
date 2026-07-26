const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "getnet", name: "Getnet TEF", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "getnet",
    name: "Getnet",
    modules: ["node-getnet-tef", "getnet-tef", "./vendor/getnet"],
    docs: "https://developers.getnet.com.br/",
  }),
};
