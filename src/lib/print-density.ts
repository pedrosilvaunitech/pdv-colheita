/**
 * Intensidade de impressão (darkness) da impressora térmica ESC/POS.
 *
 * Salva por dispositivo (localStorage) porque depende do hardware físico
 * instalado naquele PDV — não faz sentido sincronizar entre estações.
 *
 * Aplicamos dois comandos, para máxima compatibilidade entre marcas:
 *   1) ESC 7 n1 n2 n3  → controla dots máximos, tempo de aquecimento e intervalo
 *      (padrão em impressoras de sobremesa: Bematech, Elgin, Epson genéricas).
 *      n2 (heating time) é o principal driver de "quão escuro" sai o cupom.
 *   2) GS ( E pL pH fn m  → função 5 (Epson TM series) para densidade percentual.
 *      Ignorado em impressoras que não implementam essa função.
 */

const LS_KEY = "escpos.print_density_v1";

export type PrintDensity = "light" | "medium" | "dark" | "extra_dark";

export const DENSITY_LABELS: Record<PrintDensity, string> = {
  light: "Fraca (rápida, poupa cabeça)",
  medium: "Média (padrão de fábrica)",
  dark: "Escura (recomendada)",
  extra_dark: "Muito escura (máximo contraste)",
};

// n1 = max heating dots (unidade de 8; 7 = 64 pontos, típico)
// n2 = heating time (unidades de 10us; maior = mais escuro, mais lento)
// n3 = heating interval (unidades de 10us; menor = mais escuro, mais aquece)
const ESC7_PROFILES: Record<PrintDensity, [number, number, number]> = {
  light:      [7,  60, 4],
  medium:     [7,  90, 3],
  dark:       [11, 150, 2],
  extra_dark: [15, 220, 2],
};

// GS ( E ... fn=5 (Set printing density). m: 0..250 → -50%..+50% relative.
// 50 = default (0%), 100 ≈ +10%, 200 ≈ +30%, 250 ≈ +50%.
const GS_E_DENSITY: Record<PrintDensity, number> = {
  light: 30,
  medium: 50,
  dark: 100,
  extra_dark: 200,
};

function keyFor(printerId?: string | null): string {
  const p = (printerId ?? "").trim();
  return p ? `${LS_KEY}::${p}` : LS_KEY;
}

export function getPrintDensity(printerId?: string | null): PrintDensity {
  try {
    const raw = localStorage.getItem(keyFor(printerId)) ?? (printerId ? localStorage.getItem(LS_KEY) : null);
    if (raw === "light" || raw === "medium" || raw === "dark" || raw === "extra_dark") return raw;
  } catch { /* noop */ }
  return "dark";
}

export function setPrintDensity(v: PrintDensity, printerId?: string | null): void {
  try { localStorage.setItem(keyFor(printerId), v); } catch { /* noop */ }
}

/** Bytes de configuração a prefixar em cada payload ESC/POS. */
export function buildDensityPrefix(density?: PrintDensity, printerId?: string | null): Uint8Array {
  const d = density ?? getPrintDensity(printerId);
  const [n1, n2, n3] = ESC7_PROFILES[d];
  const m = GS_E_DENSITY[d];
  return new Uint8Array([
    0x1b, 0x37, n1, n2, n3,
    0x1d, 0x28, 0x45, 0x03, 0x00, 0x05, m,
  ]);
}
