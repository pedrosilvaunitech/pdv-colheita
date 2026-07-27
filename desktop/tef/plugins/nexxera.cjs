const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "nexxera", name: "Nexxera / TefWay", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "nexxera",
    name: "Nexxera / TefWay",
    modules: ["node-tefway", "tefway", "./vendor/tefway"],
    docs: "https://www.tefway.com.br/",
  }),
};
