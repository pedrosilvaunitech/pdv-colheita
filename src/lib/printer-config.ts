/**
 * Configuração por impressora persistida em localStorage:
 *  - largura do papel (override manual, usado quando o agente não reporta)
 *  - resultado da calibração automática (largura escolhida pelo operador)
 *  - codepage (linguagem/charset ESC/POS para acentos corretos)
 */

import type { Codepage } from "./escpos-codepage";

const LS_PAPER = "printer_paper_width_v1"; // JSON: { [printerName]: 58 | 80 }
const LS_CODEPAGE = "printer_codepage_v1"; // JSON: { [printerName]: Codepage }

type PaperMap = Record<string, 58 | 80>;
type CodepageMap = Record<string, Codepage>;

function read(): PaperMap {
  try {
    const raw = localStorage.getItem(LS_PAPER);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as PaperMap;
  } catch { /* noop */ }
  return {};
}

function write(map: PaperMap): void {
  try { localStorage.setItem(LS_PAPER, JSON.stringify(map)); } catch { /* noop */ }
}

export function getPrinterPaperWidth(printerName?: string | null): 58 | 80 | null {
  const key = (printerName ?? "").trim();
  if (!key) return null;
  return read()[key] ?? null;
}

export function setPrinterPaperWidth(printerName: string, width: 58 | 80): void {
  const map = read();
  map[printerName] = width;
  write(map);
}

export function clearPrinterPaperWidth(printerName: string): void {
  const map = read();
  delete map[printerName];
  write(map);
}

// ---------------- Codepage por impressora ----------------

function readCp(): CodepageMap {
  try {
    const raw = localStorage.getItem(LS_CODEPAGE);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as CodepageMap;
  } catch { /* noop */ }
  return {};
}

function writeCp(map: CodepageMap): void {
  try { localStorage.setItem(LS_CODEPAGE, JSON.stringify(map)); } catch { /* noop */ }
}

export function getPrinterCodepage(printerName?: string | null): Codepage | null {
  const key = (printerName ?? "").trim();
  if (!key) return null;
  return readCp()[key] ?? null;
}

export function setPrinterCodepage(printerName: string, cp: Codepage): void {
  const map = readCp();
  map[printerName] = cp;
  writeCp(map);
}



/**
 * Payload de calibração: imprime duas réguas (48 col para 80mm e 32 col
 * para 58mm) — o operador vê qual encaixa exatamente na largura do papel.
 * Também imprime uma linha de teste de acentos para validar o codepage.
 */
export function buildCalibrationPayload(printerName?: string | null): Uint8Array {
  const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
  // Import dinâmico evita ciclo; código roda no browser sempre.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { encodeForCodepage, getCodepageCommand } = require("./escpos-codepage") as typeof import("./escpos-codepage");
  const cp = getPrinterCodepage(printerName ?? null) ?? "cp850";
  const enc = (s: string) => encodeForCodepage(s, cp);
  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([ESC, 0x40]));
  parts.push(getCodepageCommand(cp));
  parts.push(enc("=== CALIBRACAO DE LARGURA ===\n"));
  parts.push(enc(`Codepage: ${cp.toUpperCase()}\n`));
  parts.push(enc("Acentos: á é í ó ú â ê ô ã õ ç Ç\n\n"));
  parts.push(enc("Regua 80mm (48 colunas):\n"));
  parts.push(enc("123456789012345678901234567890123456789012345678\n"));
  parts.push(enc("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n\n"));
  parts.push(enc("Regua 58mm (32 colunas):\n"));
  parts.push(enc("12345678901234567890123456789012\n"));
  parts.push(enc("XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n\n"));
  parts.push(enc("Escolha a regua que encaixa\n"));
  parts.push(enc("EXATAMENTE na largura do papel\n"));
  parts.push(enc("sem cortar caracteres.\n"));
  parts.push(new Uint8Array([LF, LF, LF, LF]));
  parts.push(new Uint8Array([GS, 0x56, 0x42, 0x00]));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
