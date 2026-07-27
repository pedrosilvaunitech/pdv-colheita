const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "elgin", name: "Elgin TEF (E1/Smart)", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "elgin",
    name: "Elgin TEF (E1/Smart)",
    modules: ["node-elgin-tef", "elgin-tef", "./vendor/elgin"],
    docs: "https://elgin.com.br/desenvolvedores",
  }),
};
