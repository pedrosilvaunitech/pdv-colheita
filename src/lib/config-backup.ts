/**
 * Backup de configuração com versão e hash de integridade.
 *
 * Um arquivo de backup viaja por e-mail, pendrive e WhatsApp até chegar na
 * segunda loja. Sem verificação, um JSON truncado ou editado à mão entra no
 * sistema silenciosamente e derruba a emissão fiscal. Por isso o envelope
 * carrega:
 *
 *  - `version`: permite migrar formatos antigos em vez de rejeitá-los;
 *  - `algorithm` + `hash`: SHA-256 do payload canônico (chaves ordenadas),
 *    calculado com WebCrypto — detecta corrupção e edição manual;
 *  - `kind`: impede importar o backup errado (ex.: impressora em fiscal).
 *
 * O hash NÃO é assinatura: quem edita o arquivo pode recalcular. Ele serve
 * contra acidente, não contra adversário — segredo nenhum sai do backend.
 */

/** Versão atual do envelope. Incremente ao mudar o formato de `payload`. */
export const BACKUP_VERSION = 2;

export interface BackupEnvelope<T> {
  kind: string;
  version: number;
  exported_at: string;
  app: string;
  algorithm: "SHA-256";
  /** Hash hexadecimal do payload canônico. */
  hash: string;
  payload: T;
}

export interface BackupParseResult<T> {
  payload: T;
  version: number;
  exportedAt: string | null;
  /** `true` quando o hash confere; `false` quando diverge. */
  hashValid: boolean;
  /** `true` para backups antigos (v1) que não tinham hash. */
  legacy: boolean;
}

/** Serialização canônica: chaves ordenadas em toda a árvore. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** SHA-256 hexadecimal do payload canônico. */
export async function hashPayload(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Monta o envelope versionado e já hasheado. */
export async function buildBackup<T>(kind: string, payload: T): Promise<BackupEnvelope<T>> {
  return {
    kind,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    app: "Bastion PDV",
    algorithm: "SHA-256",
    hash: await hashPayload(payload),
    payload,
  };
}

/**
 * Lê e valida um backup.
 *
 * Aceita o formato v1 (campo `config`, sem hash) marcando `legacy: true`, para
 * não invalidar exportações já feitas pelos lojistas.
 *
 * @throws quando o arquivo não é JSON, é de outro tipo ou não tem payload.
 */
export async function parseBackup<T>(text: string, expectedKind: string): Promise<BackupParseResult<T>> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Arquivo não é um JSON válido.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Arquivo de backup vazio ou inválido.");
  if (parsed.kind !== expectedKind) {
    throw new Error(`Arquivo não é um backup de "${expectedKind}".`);
  }

  const version = typeof parsed.version === "number" ? parsed.version : 1;
  const payload = (parsed.payload ?? parsed.config) as T | undefined;
  if (!payload || typeof payload !== "object") {
    throw new Error("Backup sem dados de configuração.");
  }

  const declaredHash = typeof parsed.hash === "string" ? parsed.hash : null;
  if (!declaredHash) {
    return {
      payload,
      version,
      exportedAt: typeof parsed.exported_at === "string" ? parsed.exported_at : null,
      hashValid: false,
      legacy: true,
    };
  }

  const actual = await hashPayload(payload);
  return {
    payload,
    version,
    exportedAt: typeof parsed.exported_at === "string" ? parsed.exported_at : null,
    hashValid: actual === declaredHash,
    legacy: false,
  };
}

/** Dispara o download do envelope como arquivo .json. */
export function downloadBackup(envelope: BackupEnvelope<unknown>, baseName: string): void {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName}-v${envelope.version}-${envelope.hash.slice(0, 8)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
