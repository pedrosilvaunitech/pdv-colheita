import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("/tmp/qa/report.xlsx");
console.log("abas:", wb.worksheets.map((s) => s.name).join(" | "));
console.log("activeTab:", JSON.stringify(wb.views));
for (const ws of wb.worksheets) {
  const formulas: string[] = [];
  ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === "object" && c.value && "formula" in (c.value as any)) formulas.push(`${ws.name}!${c.address}=${(c.value as any).formula}`); }));
  console.log(`\n[${ws.name}] linhas=${ws.rowCount} cols=${ws.columnCount} formulas=${formulas.length}`);
  formulas.slice(0, 12).forEach((f) => console.log("  ", f));
}
