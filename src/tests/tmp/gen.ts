import { buildSalesReportPdf } from "../../lib/sales-report-pdf";
import { buildSalesReportXlsx } from "../../lib/sales-report-xlsx";
import type { SalesReport } from "../../lib/sales-report";
import { writeFileSync } from "node:fs";

const periods = Array.from({ length: 14 }, (_, i) => {
  const start = new Date(2026, 6, i + 1);
  const total = 1200 + i * 137.5;
  return { key: `2026-07-${String(i + 1).padStart(2, "0")}`, label: `${String(i + 1).padStart(2, "0")}/07`,
    detail: `${String(i + 1).padStart(2, "0")}/07/2026 · quarta-feira`, start,
    sales: 20 + i, items: 55 + i * 2, gross: total + 80, discount: 80, total, avgTicket: total / (20 + i) };
});
const registers = ["Caixa 01", "Caixa 02 - Loja de rua com nome muito comprido", "Não identificado"].map((name, i) => ({
  key: name, name, operators: ["Giselle Fortunato Matias", "João Câmara"], sessions: 3 - i,
  sales: 120 - i * 30, items: 300, discount: 210.5, total: 20000 - i * 6000, avgTicket: 150 + i,
  share: [0.55, 0.3, 0.15][i]!, firstSaleAt: new Date(), lastSaleAt: new Date(),
}));
const report: SalesReport = {
  granularity: "day", from: new Date(2026, 6, 1), to: new Date(2026, 6, 14),
  totals: { sales: 300, items: 900, gross: 41000, discount: 1000, total: 40000, avgTicket: 133.33,
    avgItemsPerSale: 3, bestDay: { label: "14/07/2026 · terça-feira", total: 3000 }, fiscalIssued: 280, fiscalPending: 20 },
  periods, registers,
  payments: [ { method: "pix", label: "Pix", count: 120, total: 18000, share: 0.45 },
    { method: "credito", label: "Cartão de crédito", count: 90, total: 14000, share: 0.35 },
    { method: "dinheiro", label: "Dinheiro", count: 90, total: 8000, share: 0.2 } ],
  products: Array.from({ length: 25 }, (_, i) => ({ productId: `p${i}`, name: `Produto de teste com nome grande nº ${i + 1} — açúcar refinado 1kg`, quantity: 100 - i, total: 900 - i * 20, share: (25 - i) / 300 })),
  operators: [], matrix: registers.map((r) => ({ register: r.name, byPeriod: Object.fromEntries(periods.map((p) => [p.key, r.total / 14])), total: r.total })),
  generatedAt: new Date(2026, 7, 2, 15, 5),
};
const pdf = buildSalesReportPdf(report, { fantasyName: "Mercado Fortunato", cnpj: "51.483.602/0001-88" });
writeFileSync("/tmp/qa/report.pdf", Buffer.from(await pdf.arrayBuffer()));
const xlsx = await buildSalesReportXlsx(report, { fantasyName: "Mercado Fortunato", cnpj: "51.483.602/0001-88" });
writeFileSync("/tmp/qa/report.xlsx", Buffer.from(await xlsx.arrayBuffer()));
console.log("ok");
