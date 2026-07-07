// PIX BR Code (EMV) — gerador puro, client-safe.
// Especificação BACEN: Manual de Padrões para Iniciação do PIX.

export interface StaticPixInput {
  key: string;              // chave PIX
  merchantName: string;     // até 25 chars, sem acento
  merchantCity: string;     // até 15 chars
  amount?: number;          // opcional
  txid?: string;            // até 25 chars alfanuméricos; "***" para estático livre
  description?: string;     // adicional (info opcional dentro do 26.02)
}

const normalize = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 .,\-@]/g, "").trim();

const tlv = (id: string, value: string) => {
  const len = value.length.toString().padStart(2, "0");
  return `${id}${len}${value}`;
};

// CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF)
function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function buildStaticPixBRCode(input: StaticPixInput): string {
  const key = input.key.trim();
  if (!key) throw new Error("Chave PIX obrigatória");
  const name = normalize(input.merchantName || "RECEBEDOR").slice(0, 25).toUpperCase();
  const city = normalize(input.merchantCity || "BRASIL").slice(0, 15).toUpperCase();
  const txid = (input.txid || "***").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***";

  // Merchant Account Info (id 26)
  const gui = tlv("00", "BR.GOV.BCB.PIX");
  const keyTlv = tlv("01", key);
  const infoTlv = input.description ? tlv("02", normalize(input.description).slice(0, 72)) : "";
  const merchantAccount = tlv("26", gui + keyTlv + infoTlv);

  // Additional Data (id 62 → 05=txid)
  const additional = tlv("62", tlv("05", txid));

  const parts = [
    tlv("00", "01"),                                   // Payload format
    merchantAccount,
    tlv("52", "0000"),                                 // MCC
    tlv("53", "986"),                                  // BRL
    input.amount && input.amount > 0
      ? tlv("54", input.amount.toFixed(2))
      : "",
    tlv("58", "BR"),
    tlv("59", name),
    tlv("60", city),
    additional,
  ];
  const payloadNoCrc = parts.join("") + "6304";
  return payloadNoCrc + crc16(payloadNoCrc);
}

// Utilitário: gera txid único (25 chars alfa-num) para estático
export function generatePixTxid(prefix = "POS"): string {
  const rand = Math.random().toString(36).slice(2, 12).toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  return `${prefix}${ts}${rand}`.replace(/[^A-Z0-9]/g, "").slice(0, 25);
}
