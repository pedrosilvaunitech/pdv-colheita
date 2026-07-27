const { createSdkDriver } = require("../sdk-driver.cjs");

module.exports = {
  meta: { id: "mercadopago", name: "Mercado Pago Point", requiresSdk: true },
  createDriver: createSdkDriver({
    id: "mercadopago",
    name: "Mercado Pago Point",
    modules: ["node-mercadopago-point", "mercadopago-point", "./vendor/mercadopago"],
    docs: "https://www.mercadopago.com.br/developers/",
  }),
};
