/**
 * Configuração por impressora persistida em localStorage:
 *  - largura do papel (override manual, usado quando o agente não reporta)
 *  - resultado da calibração automática (largura escolhida pelo operador)
 */

const LS_PAPER = "printer_paper_width_v1"; // JSON: { [printerName]: 58 | 80 }

type PaperMap = Record<string, 58 | 80>;

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

/**
 * Payload de calibração: imprime duas réguas (48 col para 80mm e 32 col
 * para 58mm) — o operador vê qual encaixa exatamente na largura do papel.
 */
export function buildCalibrationPayload(): Uint8Array {
  const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
  const enc = (s: string) => new TextEncoder().encode(s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([ESC, 0x40]));
  parts.push(new Uint8Array([ESC, 0x74, 0x02]));
  parts.push(enc("=== CALIBRACAO DE LARGURA ===\n\n"));
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
