/**
 * Cupom de teste de impressão POR TERMINAL.
 *
 * A calibração existente resolve largura e acentos. Este teste responde outra
 * pergunta, que aparece em loja com vários caixas: "o papel saiu — mas saiu
 * NESTE caixa?". Por isso o cupom carrega identificação do terminal, da loja,
 * do canal e um código curto de conferência que o operador compara com a tela.
 */
import { encodeForCodepage, getCodepageCommand, type Codepage } from "./escpos-codepage";
import { getPrinterCodepage, getPrinterPaperWidth } from "./printer-config";

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

export interface TerminalTestInput {
  terminalLabel: string;
  terminalName?: string | null;
  storeName?: string | null;
  printerName?: string | null;
  printerSource?: string | null;
  /** Código curto exibido na tela para conferência visual. */
  verification: string;
}

/** Código de conferência de 6 caracteres, legível em papel térmico. */
export function newVerificationCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function center(text: string, cols: number): string {
  const pad = Math.max(0, Math.floor((cols - text.length) / 2));
  return " ".repeat(pad) + text;
}

/** Monta os bytes ESC/POS do cupom de teste do terminal. */
export function buildTerminalTestPayload(input: TerminalTestInput): Uint8Array {
  const printer = input.printerName ?? null;
  const cp: Codepage = getPrinterCodepage(printer) ?? "cp850";
  const cols = (getPrinterPaperWidth(printer) ?? 80) === 58 ? 32 : 48;
  const enc = (s: string) => encodeForCodepage(s, cp);
  const line = "-".repeat(cols) + "\n";

  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([ESC, 0x40])); // reset
  parts.push(getCodepageCommand(cp));
  parts.push(enc(center("TESTE DE IMPRESSAO", cols) + "\n"));
  parts.push(enc(center("(nao fiscal)", cols) + "\n"));
  parts.push(enc(line));
  parts.push(enc(`Loja......: ${input.storeName ?? "-"}\n`));
  parts.push(enc(`Terminal..: #${input.terminalLabel}\n`));
  if (input.terminalName) parts.push(enc(`Apelido...: ${input.terminalName}\n`));
  parts.push(enc(`Impressora: ${printer ?? "(automatica)"}\n`));
  parts.push(enc(`Canal.....: ${input.printerSource ?? "-"}\n`));
  parts.push(enc(`Papel.....: ${cols === 32 ? "58mm / 32 col" : "80mm / 48 col"}\n`));
  parts.push(enc(`Codepage..: ${cp.toUpperCase()}\n`));
  parts.push(enc(`Data......: ${new Date().toLocaleString("pt-BR")}\n`));
  parts.push(enc(line));
  parts.push(new Uint8Array([ESC, 0x21, 0x30])); // fonte dupla
  parts.push(enc(center(input.verification, Math.floor(cols / 2)) + "\n"));
  parts.push(new Uint8Array([ESC, 0x21, 0x00]));
  parts.push(enc(line));
  parts.push(enc("Acentuacao: ação, coração, José\n"));
  parts.push(enc("Confira o codigo acima com o\n"));
  parts.push(enc("codigo exibido na tela deste caixa.\n"));
  parts.push(new Uint8Array([LF, LF, LF, LF]));
  parts.push(new Uint8Array([GS, 0x56, 0x42, 0x00])); // guilhotina

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
