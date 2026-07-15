/**
 * Codepages ESC/POS para acentuação correta em impressoras térmicas.
 *
 * Diferentes impressoras interpretam bytes acima de 0x7F de acordo com o
 * codepage ativo (comando ESC t n). Se o driver imprime "caracteres estranhos"
 * (Ã©, ç virando ‡, etc.) é porque o texto foi enviado numa codificação que
 * a impressora não está esperando. A solução é:
 *   1) mandar ESC t n para selecionar o codepage;
 *   2) codificar cada caractere Unicode para o byte correspondente no codepage.
 *
 * Este módulo mantém tabelas para os codepages mais usados em PT-BR:
 *   - pc437  (ESC t 0)  — USA/ASCII puro, sem acentos (fallback = strip)
 *   - cp850  (ESC t 2)  — Multilíngue Latin-1 (padrão da maioria)
 *   - cp860  (ESC t 3)  — Português (PT-PT/BR)
 *   - cp858  (ESC t 19) — Multilíngue + € (Euro)
 *   - wpc1252(ESC t 16) — Windows-1252 (idêntico ao Latin-1)
 */

export type Codepage = "pc437" | "cp850" | "cp860" | "cp858" | "wpc1252";

export interface CodepageOption {
  id: Codepage;
  label: string;
  hint: string;
}

export const CODEPAGE_OPTIONS: CodepageOption[] = [
  { id: "cp850",   label: "CP850 (Multilíngue)",       hint: "Padrão da maioria das térmicas Epson/Bematech" },
  { id: "cp860",   label: "CP860 (Português)",          hint: "PT-PT/BR — modelos mais antigos" },
  { id: "cp858",   label: "CP858 (Multilíngue + €)",   hint: "Igual ao CP850 com símbolo Euro" },
  { id: "wpc1252", label: "Windows-1252 (Latin-1)",     hint: "Compatível com maioria dos drivers Windows" },
  { id: "pc437",   label: "PC437 (ASCII sem acentos)", hint: "Remove acentos — só use se nada mais funcionar" },
];

const CP_COMMAND: Record<Codepage, number> = {
  pc437: 0,
  cp850: 2,
  cp860: 3,
  cp858: 19,
  wpc1252: 16,
};

/** Bytes ESC t n para selecionar codepage antes de imprimir texto. */
export function getCodepageCommand(cp: Codepage): Uint8Array {
  return new Uint8Array([0x1b, 0x74, CP_COMMAND[cp]]);
}

// -- Tabelas Unicode → byte (apenas caracteres relevantes para PT-BR) --

const CP850: Record<string, number> = {
  "Ç":0x80,"ü":0x81,"é":0x82,"â":0x83,"ä":0x84,"à":0x85,"å":0x86,"ç":0x87,
  "ê":0x88,"ë":0x89,"è":0x8A,"ï":0x8B,"î":0x8C,"ì":0x8D,"Ä":0x8E,"Å":0x8F,
  "É":0x90,"æ":0x91,"Æ":0x92,"ô":0x93,"ö":0x94,"ò":0x95,"û":0x96,"ù":0x97,
  "ÿ":0x98,"Ö":0x99,"Ü":0x9A,"ø":0x9B,"£":0x9C,"Ø":0x9D,"×":0x9E,"ƒ":0x9F,
  "á":0xA0,"í":0xA1,"ó":0xA2,"ú":0xA3,"ñ":0xA4,"Ñ":0xA5,"ª":0xA6,"º":0xA7,
  "¿":0xA8,"®":0xA9,"¬":0xAA,"½":0xAB,"¼":0xAC,"¡":0xAD,"«":0xAE,"»":0xAF,
  "Á":0xB5,"Â":0xB6,"À":0xB7,"©":0xB8,
  "ã":0xC6,"Ã":0xC7,
  "ð":0xD0,"Ð":0xD1,"Ê":0xD2,"Ë":0xD3,"È":0xD4,"ı":0xD5,"Í":0xD6,"Î":0xD7,"Ï":0xD8,
  "Ó":0xE0,"ß":0xE1,"Ô":0xE2,"Ò":0xE3,"õ":0xE4,"Õ":0xE5,"µ":0xE6,"þ":0xE7,"Þ":0xE8,
  "Ú":0xE9,"Û":0xEA,"Ù":0xEB,"ý":0xEC,"Ý":0xED,"¯":0xEE,"´":0xEF,
  "±":0xF1,"¾":0xF3,"¶":0xF4,"§":0xF5,"°":0xF8,"¨":0xF9,"·":0xFA,"¹":0xFB,"³":0xFC,"²":0xFD,
};

const CP858: Record<string, number> = { ...CP850, "€":0xD5 };

const CP860: Record<string, number> = {
  "Ç":0x80,"ü":0x81,"é":0x82,"â":0x83,"ã":0x84,"à":0x85,"Á":0x86,"ç":0x87,
  "ê":0x88,"Ê":0x89,"è":0x8A,"Í":0x8B,"Ô":0x8C,"ì":0x8D,"Ã":0x8E,"Â":0x8F,
  "É":0x90,"À":0x91,"È":0x92,"ô":0x93,"õ":0x94,"ò":0x95,"Ú":0x96,"ù":0x97,
  "Ì":0x98,"Õ":0x99,"Ü":0x9A,"¢":0x9B,"£":0x9C,"Ù":0x9D,"Ó":0x9F,
  "á":0xA0,"í":0xA1,"ó":0xA2,"ú":0xA3,"ñ":0xA4,"Ñ":0xA5,"ª":0xA6,"º":0xA7,
  "¿":0xA8,"Ò":0xA9,"¬":0xAA,"½":0xAB,"¼":0xAC,"¡":0xAD,"«":0xAE,"»":0xAF,
};

const WPC1252: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  // 0xA0-0xFF do Windows-1252 coincidem com Unicode Latin-1.
  for (let b = 0xA0; b <= 0xFF; b++) m[String.fromCharCode(b)] = b;
  // Zona 0x80-0x9F tem símbolos específicos.
  const win: Array<[number, string]> = [
    [0x80,"€"],[0x82,"‚"],[0x83,"ƒ"],[0x84,"„"],[0x85,"…"],[0x86,"†"],[0x87,"‡"],
    [0x88,"ˆ"],[0x89,"‰"],[0x8A,"Š"],[0x8B,"‹"],[0x8C,"Œ"],[0x8E,"Ž"],
    [0x91,"‘"],[0x92,"’"],[0x93,"“"],[0x94,"”"],[0x95,"•"],[0x96,"–"],[0x97,"—"],
    [0x98,"˜"],[0x99,"™"],[0x9A,"š"],[0x9B,"›"],[0x9C,"œ"],[0x9E,"ž"],[0x9F,"Ÿ"],
  ];
  for (const [b, ch] of win) m[ch] = b;
  return m;
})();

const TABLES: Record<Codepage, Record<string, number>> = {
  pc437: {},
  cp850: CP850,
  cp860: CP860,
  cp858: CP858,
  wpc1252: WPC1252,
};

// Substituições ASCII para símbolos que não existem em codepages restritos.
const ASCII_FALLBACK: Record<string, string> = {
  "“":'"',"”":'"',"‘":"'","’":"'","–":"-","—":"-","…":"...","•":"*","«":"<<","»":">>",
  "€":"EUR","₧":"Pts","™":"TM","©":"(c)","®":"(r)","·":".","º":"o","ª":"a",
  "\u00A0":" ","\u202F":" ","\u2007":" ","\u2009":" ","\u200B":"","\u2060":"","\uFEFF":"",
  "№":"No.","−":"-","₋":"-","₊":"+","₌":"=",
};

function normalizePrintableText(text: string): string {
  return text
    // O Intl pt-BR costuma gerar moeda como "R$\u00A012,34". A maioria das
    // térmicas não tem byte para esse espaço especial e imprimia "R$?12,34".
    .replace(/[\u00A0\u202F\u2007\u2009]/g, " ")
    // Marcadores invisíveis não devem virar "?" no papel.
    .replace(/[\u200B\u2060\uFEFF]/g, "");
}

/**
 * Codifica texto Unicode em bytes para o codepage escolhido.
 * Caracteres não representáveis viram (nessa ordem):
 *   1) substituto ASCII manual (ASCII_FALLBACK)
 *   2) versão sem diacrítico (NFD strip)
 *   3) espaço em branco caso nada resolva, para não poluir valores com "??".
 */
export function encodeForCodepage(text: string, cp: Codepage): Uint8Array {
  const table = TABLES[cp];
  const out: number[] = [];
  for (const ch of normalizePrintableText(text)) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) { out.push(code); continue; }
    const mapped = table[ch];
    if (mapped !== undefined) { out.push(mapped); continue; }
    const alt = ASCII_FALLBACK[ch];
    if (alt !== undefined) { for (let i = 0; i < alt.length; i++) out.push(alt.charCodeAt(i)); continue; }
    // Remove acentos e tenta de novo.
    const stripped = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (stripped && stripped !== ch) {
      for (const s of stripped) {
        const c = s.codePointAt(0)!;
        if (c < 0x80) out.push(c);
        else out.push(table[s] ?? 0x20);
      }
      continue;
    }
    out.push(0x20);
  }
  return new Uint8Array(out);
}
