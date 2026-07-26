const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "sitef", name: "SiTef (Software Express)", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "sitef",
    name: "SiTef",
    modules: ["node-clisitef", "clisitef", "./vendor/sitef"],
    docs: "https://dev.softwareexpress.com.br/",
  }),
};
