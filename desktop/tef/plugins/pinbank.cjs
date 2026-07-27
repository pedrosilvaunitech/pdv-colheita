const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "pinbank", name: "PinBank", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "pinbank",
    name: "PinBank",
    modules: ["node-pinbank-tef", "pinbank-tef", "./vendor/pinbank"],
    docs: "https://www.pinbank.com.br/",
  }),
};
