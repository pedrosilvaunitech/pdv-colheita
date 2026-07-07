/// <reference types="w3c-web-serial" />
/**
 * Driver para balanças Toledo (e compatíveis) via Web Serial API.
 *
 * Protocolos suportados:
 *  - "prix3"     Toledo Prix 3 / contínuo: envia frames continuamente
 *                sem solicitação, geralmente iniciados por STX (0x02) e
 *                terminados por ETX (0x03) contendo 5 dígitos ASCII de
 *                peso em kg×1000 (ex.: "01234" = 1,234 kg).
 *  - "prix4-p0"  Toledo Prix 4/5 Protocolo 0: host envia ENQ (0x05) e a
 *                balança responde  STX  P P P P P  ETX  (peso em kg×1000).
 *  - "prix4-p1"  Toledo Prix 4/5 Protocolo 1: host envia ENQ, resposta
 *                estendida com peso, tara e status. Extraímos apenas
 *                o primeiro campo de peso.
 *  - "generic"   Heurística tolerante: aceita qualquer frame contendo
 *                5 dígitos ASCII (opcionalmente com ponto/vírgula).
 *
 * Estados especiais reportados pela balança:
 *  - "IIIII" ou "?????"   → sobrecarga (overload)
 *  - "-----" ou "SSSSS"   → peso instável / em movimento
 *  - "00000"              → peso zero
 *
 * O driver é agnóstico ao SO — funciona em qualquer navegador Chromium
 * com suporte a Web Serial (Chrome/Edge desktop e PWA instalado).
 */

export type ToledoProtocol = "prix3" | "prix4-p0" | "prix4-p1" | "generic";

export interface ToledoConfig {
  protocol: ToledoProtocol;
  baudRate: number;      // 2400 | 4800 | 9600 (Toledo padrão 9600)
  dataBits: 7 | 8;       // Toledo geralmente 8
  stopBits: 1 | 2;       // Toledo geralmente 1
  parity: ParityType;    // "none" | "even" | "odd"
  requestTimeoutMs: number; // timeout p/ modo por requisição (ENQ)
}

export const DEFAULT_TOLEDO_CONFIG: ToledoConfig = {
  protocol: "prix4-p0",
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  requestTimeoutMs: 1500,
};

export type ScaleStatus = "ok" | "unstable" | "overload" | "zero" | "unknown";

export interface ScaleReading {
  weightKg: number;   // peso líquido em kg (0 se status != ok/zero)
  status: ScaleStatus;
  raw: string;        // frame bruto recebido (para debug)
  at: number;         // timestamp
}

const STX = 0x02;
const ETX = 0x03;
const ENQ = 0x05;

export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/** Extrai um bloco de 5 dígitos ASCII e converte para kg. */
function parseWeightBlock(block: string): { kg: number; status: ScaleStatus } {
  const trimmed = block.trim();
  if (/^[I?]{4,6}$/.test(trimmed)) return { kg: 0, status: "overload" };
  if (/^[-S]{4,6}$/.test(trimmed)) return { kg: 0, status: "unstable" };
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 5) return { kg: 0, status: "unknown" };
  const grams = Number(digits.slice(0, digits.length >= 6 ? 6 : 5));
  if (!Number.isFinite(grams)) return { kg: 0, status: "unknown" };
  const kg = grams / 1000;
  if (kg === 0) return { kg: 0, status: "zero" };
  return { kg, status: "ok" };
}

/** Extrai a leitura do frame conforme o protocolo. */
export function parseFrame(buf: Uint8Array, protocol: ToledoProtocol): ScaleReading | null {
  // Localiza um segmento entre STX e ETX (ou usa texto puro em prix3 sem STX)
  let start = -1;
  let end = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === STX && start === -1) start = i + 1;
    else if (buf[i] === ETX && start !== -1) { end = i; break; }
  }
  let payload: string;
  if (start !== -1 && end !== -1) {
    payload = new TextDecoder().decode(buf.slice(start, end));
  } else {
    payload = new TextDecoder().decode(buf).replace(/[\r\n\x00-\x1f]/g, " ").trim();
    if (!payload) return null;
  }

  switch (protocol) {
    case "prix4-p0": {
      // Payload esperado: 5 dígitos exatos
      const r = parseWeightBlock(payload.slice(0, 5));
      return { weightKg: r.kg, status: r.status, raw: payload, at: Date.now() };
    }
    case "prix4-p1": {
      // Payload estendido — primeiros 6 chars costumam ser peso (5+status)
      const r = parseWeightBlock(payload.slice(0, 6));
      return { weightKg: r.kg, status: r.status, raw: payload, at: Date.now() };
    }
    case "prix3":
    case "generic":
    default: {
      // Heurística: primeira sequência com >=5 dígitos
      const m = payload.match(/([I?]{4,6}|[-S]{4,6}|\d{5,6})/);
      if (!m) return null;
      const r = parseWeightBlock(m[1]);
      return { weightKg: r.kg, status: r.status, raw: payload, at: Date.now() };
    }
  }
}

/**
 * Conexão persistente com a balança. Suporta modo contínuo
 * (protocolo prix3) e modo por requisição (prix4-p0/p1).
 */
export class ToledoScale {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private buffer = new Uint8Array(0);
  private cfg: ToledoConfig;
  private readingListeners = new Set<(r: ScaleReading) => void>();
  private stopLoop = false;
  private lastReading: ScaleReading | null = null;
  private pendingResolvers: Array<(r: ScaleReading) => void> = [];

  constructor(cfg: ToledoConfig = DEFAULT_TOLEDO_CONFIG) {
    this.cfg = cfg;
  }

  isOpen(): boolean { return !!this.port; }
  getConfig(): ToledoConfig { return this.cfg; }
  getLast(): ScaleReading | null { return this.lastReading; }

  onReading(fn: (r: ScaleReading) => void): () => void {
    this.readingListeners.add(fn);
    return () => { this.readingListeners.delete(fn); };
  }

  /** Solicita ao usuário que escolha a porta (gesto de usuário obrigatório). */
  async requestPort(): Promise<void> {
    if (!isWebSerialSupported()) throw new Error("Este navegador não suporta Web Serial (use Chrome/Edge).");
    const port = await (navigator as Navigator & { serial: { requestPort: () => Promise<SerialPort> } })
      .serial.requestPort();
    await this.openPort(port);
  }

  /** Tenta reabrir a última porta autorizada (sem prompt). */
  async tryReopenLast(): Promise<boolean> {
    if (!isWebSerialSupported()) return false;
    const ports = await (navigator as Navigator & { serial: { getPorts: () => Promise<SerialPort[]> } })
      .serial.getPorts();
    if (!ports.length) return false;
    try { await this.openPort(ports[0]); return true; } catch { return false; }
  }

  private async openPort(port: SerialPort): Promise<void> {
    await port.open({
      baudRate: this.cfg.baudRate,
      dataBits: this.cfg.dataBits,
      stopBits: this.cfg.stopBits,
      parity: this.cfg.parity,
      flowControl: "none",
    });
    this.port = port;
    this.stopLoop = false;
    if (port.readable) this.reader = port.readable.getReader();
    if (port.writable) this.writer = port.writable.getWriter();
    void this.readLoop();
  }

  async close(): Promise<void> {
    this.stopLoop = true;
    try { await this.reader?.cancel(); } catch { /* noop */ }
    try { this.reader?.releaseLock(); } catch { /* noop */ }
    try { this.writer?.releaseLock(); } catch { /* noop */ }
    try { await this.port?.close(); } catch { /* noop */ }
    this.reader = null; this.writer = null; this.port = null;
    this.buffer = new Uint8Array(0);
  }

  private async readLoop(): Promise<void> {
    if (!this.reader) return;
    try {
      while (!this.stopLoop) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        // acumula buffer
        const merged = new Uint8Array(this.buffer.length + value.length);
        merged.set(this.buffer, 0);
        merged.set(value, this.buffer.length);
        this.buffer = merged;
        this.drainFrames();
      }
    } catch {
      // porta desconectada
    }
  }

  private drainFrames(): void {
    // procura frames STX...ETX e emite; se protocolo prix3 aceita CR/LF terminator
    while (true) {
      let stxIdx = this.buffer.indexOf(STX);
      let etxIdx = this.buffer.indexOf(ETX, stxIdx >= 0 ? stxIdx : 0);
      // fallback: quebra por CR/LF (prix3 sem STX)
      if (stxIdx === -1 || etxIdx === -1) {
        const nl = this.buffer.findIndex((b) => b === 0x0a || b === 0x0d);
        if (nl === -1) return;
        const frame = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (frame.length >= 5) this.emitFrame(frame);
        continue;
      }
      const frame = this.buffer.slice(stxIdx, etxIdx + 1);
      this.buffer = this.buffer.slice(etxIdx + 1);
      this.emitFrame(frame);
    }
  }

  private emitFrame(frame: Uint8Array): void {
    const reading = parseFrame(frame, this.cfg.protocol);
    if (!reading) return;
    this.lastReading = reading;
    for (const fn of this.readingListeners) fn(reading);
    const pending = this.pendingResolvers;
    this.pendingResolvers = [];
    for (const r of pending) r(reading);
  }

  /**
   * Solicita uma leitura ao vivo:
   *  - prix4-p0/p1: envia ENQ e aguarda próximo frame.
   *  - prix3/generic: retorna o próximo frame recebido.
   * Timeout via requestTimeoutMs.
   */
  async requestWeight(): Promise<ScaleReading> {
    if (!this.port) throw new Error("Balança não conectada. Clique em Conectar balança.");
    if (this.cfg.protocol === "prix4-p0" || this.cfg.protocol === "prix4-p1") {
      if (!this.writer) throw new Error("Porta não está pronta para escrita.");
      await this.writer.write(new Uint8Array([ENQ]));
    }
    return await new Promise<ScaleReading>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pendingResolvers = this.pendingResolvers.filter((r) => r !== onRead);
        reject(new Error("Tempo esgotado ao ler peso da balança."));
      }, this.cfg.requestTimeoutMs);
      const onRead = (r: ScaleReading) => { clearTimeout(t); resolve(r); };
      this.pendingResolvers.push(onRead);
    });
  }
}

/* --------------------------- Config persistida --------------------------- */

const LS_KEY = "toledo_scale_config_v1";

export function loadToledoConfig(): ToledoConfig {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LS_KEY) : null;
    if (!raw) return { ...DEFAULT_TOLEDO_CONFIG };
    const parsed = JSON.parse(raw) as Partial<ToledoConfig>;
    return { ...DEFAULT_TOLEDO_CONFIG, ...parsed };
  } catch { return { ...DEFAULT_TOLEDO_CONFIG }; }
}

export function saveToledoConfig(cfg: ToledoConfig): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* noop */ }
}

/* ---------------------- Singleton para o app inteiro --------------------- */

let _instance: ToledoScale | null = null;
export function getToledoScale(): ToledoScale {
  if (!_instance) _instance = new ToledoScale(loadToledoConfig());
  return _instance;
}
export function replaceToledoScale(cfg: ToledoConfig): ToledoScale {
  if (_instance) void _instance.close();
  _instance = new ToledoScale(cfg);
  return _instance;
}
