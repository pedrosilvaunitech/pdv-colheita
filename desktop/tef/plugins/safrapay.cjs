const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "safrapay", name: "SafraPay", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "safrapay",
    name: "SafraPay",
    modules: ["node-safrapay-tef", "safrapay-tef", "./vendor/safrapay"],
    docs: "https://www.safrapay.com.br/",
  }),
};
