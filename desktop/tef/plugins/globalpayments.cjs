const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "globalpayments", name: "Global Payments (Cielo/GP)", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "globalpayments",
    name: "Global Payments (Cielo/GP)",
    modules: ["node-globalpayments-tef", "globalpayments-tef", "./vendor/globalpayments"],
    docs: "https://developer.globalpay.com/",
  }),
};
