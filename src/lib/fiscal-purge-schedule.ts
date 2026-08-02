/**
 * Agendamento da limpeza fiscal automática.
 *
 * Durante a implantação, o lixo de homologação volta a se acumular todos os
 * dias: o lojista testa emissão, gera rascunho sem certificado, repete. Pedir
 * que ele clique em "limpar" manualmente toda semana é garantir que não vai
 * acontecer. Aqui o app verifica, na abertura e a cada 15 minutos, se a limpeza
 * da loja está vencida — e executa.
 *
 * Escolhas deliberadas:
 *  - o padrão é ambiente HOMOLOGAÇÃO apenas. Limpeza automática em produção só
 *    existe se o gerente marcar explicitamente, porque lá o critério legal é
 *    mais delicado (só rascunho/rejeitada) e ninguém quer surpresa silenciosa;
 *  - a permissão continua sendo decidida pelo banco: se o usuário logado não
 *    for gerente/admin, a chamada falha e apenas registramos `lastError`;
 *  - configuração por LOJA + navegador (localStorage), igual ao backup — o
 *    agendamento acompanha o caixa que fica ligado, sem depender de cron.
 */

import { purgeFiscalErrors, type PurgeEnvironment, type PurgeFiscalResult } from "@/lib/fiscal-purge";

const LS_KEY = "fiscal.purge.schedule.v1";

export type PurgeFrequency = "daily" | "weekly" | "monthly";

export const PURGE_FREQUENCY_LABEL: Record<PurgeFrequency, string> = {
  daily: "Diário",
  weekly: "Semanal",
  monthly: "Mensal",
};

const FREQUENCY_MS: Record<PurgeFrequency, number> = {
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
  monthly: 30 * 24 * 60 * 60_000,
};

export interface PurgeSchedule {
  enabled: boolean;
  frequency: PurgeFrequency;
  environment: PurgeEnvironment;
  includeInvoices: boolean;
  includeQueue: boolean;
  /** Epoch ms da última execução (bem-sucedida ou não). */
  lastRunAt: number | null;
  /** Resumo do último resultado, para a tela não esconder o que foi removido. */
  lastResult: string | null;
  lastError: string | null;
}

function defaults(): PurgeSchedule {
  return {
    enabled: false,
    frequency: "weekly",
    environment: "homologacao",
    includeInvoices: true,
    includeQueue: true,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
  };
}

type ScheduleMap = Record<string, PurgeSchedule>;

function readMap(): ScheduleMap {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as ScheduleMap;
  } catch {
    /* storage indisponível: agendamento vira sessão única */
  }
  return {};
}

function writeMap(map: ScheduleMap): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    /* noop */
  }
}

function keyFor(storeId: string | null | undefined): string {
  return storeId ?? "no-store";
}

export function getPurgeSchedule(storeId: string | null | undefined): PurgeSchedule {
  const stored = readMap()[keyFor(storeId)];
  return stored ? { ...defaults(), ...stored } : defaults();
}

export function setPurgeSchedule(
  storeId: string | null | undefined,
  patch: Partial<PurgeSchedule>,
): PurgeSchedule {
  const next = { ...getPurgeSchedule(storeId), ...patch };
  const map = readMap();
  map[keyFor(storeId)] = next;
  writeMap(map);
  return next;
}

/** Momento da próxima execução; `null` quando o agendamento está desligado. */
export function nextPurgeAt(schedule: PurgeSchedule): number | null {
  if (!schedule.enabled) return null;
  if (!schedule.lastRunAt) return Date.now();
  return schedule.lastRunAt + FREQUENCY_MS[schedule.frequency];
}

export function isPurgeDue(schedule: PurgeSchedule, now = Date.now()): boolean {
  const next = nextPurgeAt(schedule);
  return next !== null && now >= next;
}

export interface PurgeRunOutcome {
  ran: boolean;
  result?: PurgeFiscalResult;
  error?: string;
  schedule: PurgeSchedule;
}

/**
 * Executa a limpeza agendada se estiver vencida.
 *
 * @param force ignora o vencimento (botão "Executar agora").
 */
export async function runScheduledPurge(
  storeId: string,
  options: { force?: boolean } = {},
): Promise<PurgeRunOutcome> {
  const schedule = getPurgeSchedule(storeId);
  if (!options.force) {
    if (!schedule.enabled || !isPurgeDue(schedule)) return { ran: false, schedule };
  }

  try {
    const result = await purgeFiscalErrors(storeId, {
      environment: schedule.environment,
      includeInvoices: schedule.includeInvoices,
      includeQueue: schedule.includeQueue,
    });
    const next = setPurgeSchedule(storeId, {
      lastRunAt: Date.now(),
      lastResult: `${result.invoicesDeleted} nota(s) e ${result.queueDeleted} item(ns) de fila`,
      lastError: null,
    });
    return { ran: true, result, schedule: next };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Falha na limpeza automática";
    // Marca a tentativa mesmo em erro: evita loop de retry a cada 15 minutos.
    const next = setPurgeSchedule(storeId, { lastRunAt: Date.now(), lastError: message });
    return { ran: true, error: message, schedule: next };
  }
}
