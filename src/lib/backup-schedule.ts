/**
 * Agendamento de backup automático da configuração.
 *
 * Backup que depende de alguém lembrar não existe. Aqui o app verifica, a cada
 * abertura e a cada 15 minutos, se o backup da loja está vencido conforme a
 * frequência escolhida — e então GERA o arquivo.
 *
 * Por que gerar e guardar em vez de baixar sozinho: navegador só permite
 * download espontâneo dentro de um gesto do usuário; um `a.click()` disparado
 * por timer é bloqueado silenciosamente em várias configurações. Então o
 * envelope pronto (versionado e com hash) fica guardado neste navegador e a
 * tela oferece "Baixar agora". O arquivo não se perde entre sessões e o hash
 * permite conferir se é o mesmo conteúdo do último backup — quando nada mudou,
 * a nova geração é descartada, evitando uma pilha de arquivos idênticos.
 *
 * Escopo: por LOJA + navegador. Cada PC guarda o próprio último backup, o que é
 * proposital: as seções locais (impressora, layout) são diferentes em cada caixa.
 */

import { hashPayload, type BackupEnvelope } from "@/lib/config-backup";
import {
  buildSelectiveBackup,
  EXPORT_SECTIONS,
  type SectionId,
  type SelectivePayload,
} from "@/lib/selective-export";

const LS_CONFIG = "backup.schedule.v1";
const LS_PENDING = "backup.pending.v1";

export type BackupFrequency = "daily" | "weekly" | "monthly";

export interface BackupSchedule {
  enabled: boolean;
  frequency: BackupFrequency;
  sections: SectionId[];
  /** Epoch ms da última geração bem-sucedida. */
  lastRunAt: number | null;
  /** Hash do último payload — evita gerar arquivo idêntico de novo. */
  lastHash: string | null;
  /** Mensagem da última falha, para a tela não esconder problema. */
  lastError: string | null;
}

export const FREQUENCY_LABEL: Record<BackupFrequency, string> = {
  daily: "Diário",
  weekly: "Semanal",
  monthly: "Mensal",
};

const FREQUENCY_MS: Record<BackupFrequency, number> = {
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
  monthly: 30 * 24 * 60 * 60_000,
};

function defaults(): BackupSchedule {
  return {
    enabled: false,
    frequency: "weekly",
    sections: EXPORT_SECTIONS.filter((s) => s.defaultOn).map((s) => s.id),
    lastRunAt: null,
    lastHash: null,
    lastError: null,
  };
}

type ScheduleMap = Record<string, BackupSchedule>;

function readMap(): ScheduleMap {
  try {
    const raw = localStorage.getItem(LS_CONFIG);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ScheduleMap;
  } catch {
    /* storage indisponível */
  }
  return {};
}

function writeMap(map: ScheduleMap): void {
  try {
    localStorage.setItem(LS_CONFIG, JSON.stringify(map));
  } catch {
    /* modo privado: agendamento vira sessão única */
  }
}

function keyFor(storeId: string | null | undefined): string {
  return storeId ?? "no-store";
}

export function getBackupSchedule(storeId: string | null | undefined): BackupSchedule {
  const stored = readMap()[keyFor(storeId)];
  if (!stored) return defaults();
  const valid = new Set(EXPORT_SECTIONS.map((s) => s.id));
  const sections = (Array.isArray(stored.sections) ? stored.sections : []).filter((id) =>
    valid.has(id as SectionId),
  ) as SectionId[];
  return {
    ...defaults(),
    ...stored,
    sections: sections.length ? sections : defaults().sections,
  };
}

export function setBackupSchedule(
  storeId: string | null | undefined,
  patch: Partial<BackupSchedule>,
): BackupSchedule {
  const next = { ...getBackupSchedule(storeId), ...patch };
  const map = readMap();
  map[keyFor(storeId)] = next;
  writeMap(map);
  return next;
}

/** Quando o próximo backup vence. `null` quando desligado. */
export function nextRunAt(schedule: BackupSchedule): number | null {
  if (!schedule.enabled) return null;
  if (!schedule.lastRunAt) return Date.now();
  return schedule.lastRunAt + FREQUENCY_MS[schedule.frequency];
}

export function isBackupDue(schedule: BackupSchedule, now = Date.now()): boolean {
  const next = nextRunAt(schedule);
  return next !== null && now >= next;
}

// ── backup pronto, aguardando download ───────────────────────────────────────

export interface PendingBackup {
  storeId: string;
  createdAt: number;
  fileName: string;
  hash: string;
  version: number;
  sections: SectionId[];
  /** Envelope serializado, pronto para virar arquivo. */
  json: string;
}

export function getPendingBackup(storeId: string | null | undefined): PendingBackup | null {
  try {
    const raw = localStorage.getItem(LS_PENDING);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingBackup;
    if (!parsed || parsed.storeId !== keyFor(storeId)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function setPendingBackup(entry: PendingBackup | null): void {
  try {
    if (entry) localStorage.setItem(LS_PENDING, JSON.stringify(entry));
    else localStorage.removeItem(LS_PENDING);
  } catch {
    /* noop */
  }
}

export function clearPendingBackup(): void {
  setPendingBackup(null);
}

/** Baixa o backup guardado. Precisa ser chamado dentro de um clique. */
export function downloadPendingBackup(pending: PendingBackup): void {
  const blob = new Blob([pending.json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = pending.fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export type RunOutcome =
  | { status: "generated"; pending: PendingBackup }
  | { status: "unchanged" }
  | { status: "skipped" }
  | { status: "error"; message: string };

/**
 * Executa o backup agendado.
 *
 * @param force ignora o vencimento (botão "Executar agora").
 */
export async function runScheduledBackup(
  storeId: string,
  options: { force?: boolean } = {},
): Promise<RunOutcome> {
  const schedule = getBackupSchedule(storeId);
  if (!options.force && !isBackupDue(schedule)) return { status: "skipped" };
  if (schedule.sections.length === 0) {
    setBackupSchedule(storeId, { lastError: "Nenhuma seção selecionada para o backup." });
    return { status: "error", message: "Nenhuma seção selecionada para o backup." };
  }

  try {
    const { envelope } = await buildSelectiveBackup(storeId, schedule.sections);
    const hash = await hashPayload(envelope.payload as SelectivePayload);

    // Conteúdo idêntico ao último backup: marca a rodada e não gera arquivo.
    if (schedule.lastHash === hash) {
      setBackupSchedule(storeId, { lastRunAt: Date.now(), lastError: null });
      return { status: "unchanged" };
    }

    const pending = buildPending(storeId, envelope, schedule.sections);
    setPendingBackup(pending);
    setBackupSchedule(storeId, { lastRunAt: Date.now(), lastHash: hash, lastError: null });
    return { status: "generated", pending };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Falha ao gerar o backup automático.";
    setBackupSchedule(storeId, { lastError: message });
    return { status: "error", message };
  }
}

function buildPending(
  storeId: string,
  envelope: BackupEnvelope<SelectivePayload>,
  sections: SectionId[],
): PendingBackup {
  const day = new Date().toISOString().slice(0, 10);
  return {
    storeId,
    createdAt: Date.now(),
    fileName: `bastion-backup-auto-${day}-${envelope.hash.slice(0, 8)}.json`,
    hash: envelope.hash,
    version: envelope.version,
    sections,
    json: JSON.stringify(envelope, null, 2),
  };
}
