const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "pagbank", name: "PagBank / PagSeguro (Moderninha)", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "pagbank",
    name: "PagBank / PagSeguro (Moderninha)",
    modules: ["node-pagbank-tef", "pagseguro-tef", "./vendor/pagbank"],
    docs: "https://dev.pagbank.uol.com.br/",
  }),
};
