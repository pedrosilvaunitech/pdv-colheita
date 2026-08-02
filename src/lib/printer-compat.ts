/**
 * Validação de compatibilidade de impressão.
 *
 * A pergunta prática do lojista é "essa impressora vai imprimir cupom neste
 * PC?". Ela depende de uma corrente inteira: navegador com WebUSB, contexto
 * seguro (HTTPS), Agente Local vivo, driver certo no Windows, impressora
 * selecionada para este terminal, largura de papel e codepage coerentes.
 *
 * Testar imprimindo gasta papel e nem sempre explica o motivo da falha. Aqui as
 * verificações são lidas do ambiente e da configuração — sem enviar nada para a
 * impressora — e cada resultado carrega a AÇÃO correspondente. Um "falhou" sem
 * instrução de correção é inútil no caixa às 19h de sábado.
 */

import { pingPrintAgent, getSelectedPrinterForStore, type AgentPrinter } from "@/lib/print-agent";
import { getPrinterCodepage, getPrinterPaperWidth } from "@/lib/printer-config";
import { getGrantedUsbPrinter, isWebUsbSupported } from "@/lib/escpos-usb";
import { isEscPosSupported } from "@/lib/escpos";

export type CompatStatus = "ok" | "aviso" | "falha" | "na";

export interface CompatCheck {
  id: string;
  label: string;
  status: CompatStatus;
  /** O que foi observado. */
  message: string;
  /** O que fazer quando não está `ok`. */
  fix?: string;
}

export interface CompatReport {
  checks: CompatCheck[];
  /** `true` quando existe pelo menos um canal capaz de imprimir. */
  canPrint: boolean;
  summary: string;
  ranAt: string;
}

/**
 * Fabricantes com ESC/POS bem conhecido. Não é lista de exclusão: uma
 * impressora fora dela recebe "aviso", nunca "falha" — muitos modelos genéricos
 * chineses funcionam perfeitamente em modo ESC/POS.
 */
const KNOWN_VENDORS: Record<number, string> = {
  0x04b8: "Epson",
  0x0519: "Star Micronics",
  0x0dd4: "Bixolon / Custom",
  0x20d1: "Elgin",
  0x0416: "Winbond (genérica)",
  0x0483: "Daruma / STMicro",
  0x1fc9: "Sweda / NXP",
  0x1a86: "QinHeng (genérica)",
};

/** Modelos térmicos com corte automático e comando de gaveta padrão. */
const CUTTER_HINTS = [/tm-?t20/i, /tm-?t88/i, /tsp/i, /srp/i, /i9/i, /mp-?4200/i, /dr800/i];

function describeSource(printer: AgentPrinter | { source: string } | null): string {
  const source = printer?.source ?? "";
  if (source === "agent") return "Agente Local (USB bruto)";
  if (source === "windows") return "spooler do Windows";
  if (source === "webusb") return "WebUSB (navegador)";
  return "canal desconhecido";
}

/**
 * Roda todas as verificações. Nunca lança: um erro em uma checagem vira um
 * item "falha" com a mensagem, mantendo o resto do relatório utilizável.
 */
export async function runPrinterCompatCheck(storeId: string | null): Promise<CompatReport> {
  const checks: CompatCheck[] = [];
  const selected = getSelectedPrinterForStore(storeId);

  // 1. Contexto seguro — sem HTTPS/localhost o navegador nem expõe WebUSB.
  const secure = typeof window !== "undefined" && window.isSecureContext;
  checks.push({
    id: "secure-context",
    label: "Conexão segura (HTTPS)",
    status: secure ? "ok" : "falha",
    message: secure
      ? "Página em contexto seguro — o navegador libera acesso a dispositivos."
      : "Página sem HTTPS: o navegador bloqueia WebUSB e Web Serial.",
    fix: secure ? undefined : "Abra o PDV pelo endereço https:// (ou http://localhost no próprio caixa).",
  });

  // 2. APIs do navegador.
  const usb = isWebUsbSupported();
  const serial = isEscPosSupported();
  checks.push({
    id: "browser-apis",
    label: "Suporte do navegador",
    status: usb || serial ? (usb ? "ok" : "aviso") : "falha",
    message: `WebUSB: ${usb ? "disponível" : "indisponível"} · Web Serial: ${serial ? "disponível" : "indisponível"}.`,
    fix:
      usb || serial
        ? usb
          ? undefined
          : "Sem WebUSB só resta a porta serial. Use Chrome/Edge atualizado para imprimir por USB."
        : "Use Google Chrome ou Microsoft Edge no computador do caixa, ou imprima pelo Agente Local.",
  });

  // 3. Agente Local — canal que funciona mesmo sem WebUSB.
  let printers: AgentPrinter[] = [];
  let agentOnline = false;
  let agentVersion: string | undefined;
  try {
    const status = await pingPrintAgent(4000);
    agentOnline = !!status.online;
    agentVersion = status.version;
    printers = status.printers ?? [];
  } catch {
    agentOnline = false;
  }
  checks.push({
    id: "agent",
    label: "Agente Local",
    status: agentOnline ? "ok" : "aviso",
    message: agentOnline
      ? `Online${agentVersion ? ` (v${agentVersion})` : ""} com ${printers.length} impressora(s) visível(is).`
      : "Não respondeu neste computador.",
    fix: agentOnline
      ? undefined
      : "Instale/abra o Agente Local para imprimir sem depender do navegador (e para usar gaveta e balança).",
  });

  // 4. Impressora escolhida para ESTE terminal.
  if (!selected) {
    checks.push({
      id: "selection",
      label: "Impressora deste terminal",
      status: "falha",
      message: "Nenhuma impressora definida para este caixa.",
      fix: 'Escolha uma impressora na lista acima com "Usar esta".',
    });
  } else {
    const found = printers.find((p) => p.name === selected.name);
    checks.push({
      id: "selection",
      label: "Impressora deste terminal",
      status: found ? (found.status === "online" ? "ok" : "aviso") : agentOnline ? "aviso" : "na",
      message: found
        ? `"${selected.name}" via ${describeSource(found)} — ${found.status === "online" ? "pronta" : (found.statusMessage ?? found.status)}.`
        : `"${selected.name}" (${describeSource(selected)}) não apareceu na busca atual.`,
      fix: found
        ? found.status === "online"
          ? undefined
          : "Confira papel, tampa e cabo USB; depois clique em Procurar impressoras."
        : "Ligue a impressora e clique em Procurar impressoras, ou escolha outra da lista.",
    });

    // 5. Permissão WebUSB persistente — a causa nº 1 de "Access denied".
    if (selected.source === "webusb" || !agentOnline) {
      let granted: USBDevice | null = null;
      try {
        granted = usb ? await getGrantedUsbPrinter() : null;
      } catch {
        granted = null;
      }
      checks.push({
        id: "webusb-permission",
        label: "Permissão WebUSB salva",
        status: granted ? "ok" : usb ? "aviso" : "na",
        message: granted
          ? `Dispositivo autorizado: ${granted.productName ?? "impressora USB"}${
              KNOWN_VENDORS[granted.vendorId] ? ` (${KNOWN_VENDORS[granted.vendorId]})` : ""
            }.`
          : usb
            ? "Nenhum dispositivo USB autorizado neste navegador."
            : "WebUSB indisponível — verificação não se aplica.",
        fix: granted
          ? undefined
          : usb
            ? 'Clique em "Impressora" no PDV e autorize o dispositivo uma vez; a permissão fica salva.'
            : undefined,
      });

      if (granted && !KNOWN_VENDORS[granted.vendorId]) {
        checks.push({
          id: "vendor",
          label: "Fabricante reconhecido",
          status: "aviso",
          message: `Fabricante USB 0x${granted.vendorId.toString(16).padStart(4, "0")} fora do catálogo conhecido.`,
          fix: "Provavelmente funciona em modo ESC/POS. Imprima a régua de calibração para confirmar.",
        });
      }
    }

    // 6. Largura do papel definida — cupom cortado na lateral vem daqui.
    const width = getPrinterPaperWidth(selected.name);
    const reported = printers.find((p) => p.name === selected.name)?.paperWidth ?? null;
    const mismatch = width && reported && width !== reported;
    checks.push({
      id: "paper",
      label: "Largura do papel",
      status: mismatch ? "aviso" : width || reported ? "ok" : "aviso",
      message: mismatch
        ? `Configurado ${width}mm, impressora reporta ${reported}mm.`
        : width
          ? `${width}mm (${width === 80 ? 48 : 32} colunas).`
          : reported
            ? `${reported}mm reportado pela impressora.`
            : "Nenhuma largura definida — o cupom assume 80mm.",
      fix: mismatch
        ? "Confie no valor da impressora ou ajuste acima e imprima a régua de calibração."
        : width || reported
          ? undefined
          : "Defina 58mm ou 80mm acima para o cupom não sair cortado.",
    });

    // 7. Codepage — acentos quebrados ("Ã§Ã£o") saem daqui.
    const codepage = getPrinterCodepage(selected.name);
    checks.push({
      id: "codepage",
      label: "Codepage (acentos)",
      status: codepage ? "ok" : "aviso",
      message: codepage
        ? `${codepage.toUpperCase()} configurado para esta impressora.`
        : "Nenhum codepage definido — será usado CP850.",
      fix: codepage ? undefined : "Se os acentos saírem errados, escolha o codepage acima e recalibre.",
    });

    // 8. Corte automático — cupom que não corta trava a fila do caixa.
    const model = `${selected.name} ${printers.find((p) => p.name === selected.name)?.model ?? ""}`;
    const hasCutter = CUTTER_HINTS.some((re) => re.test(model));
    checks.push({
      id: "cutter",
      label: "Corte automático",
      status: hasCutter ? "ok" : "aviso",
      message: hasCutter
        ? "Modelo com guilhotina reconhecida — o comando de corte é enviado no fim do cupom."
        : "Modelo sem guilhotina identificada; o corte pode precisar ser manual.",
      fix: hasCutter ? undefined : "Imprima o teste deste terminal e veja se o papel é cortado no fim.",
    });
  }

  const failures = checks.filter((c) => c.status === "falha").length;
  const warnings = checks.filter((c) => c.status === "aviso").length;
  const canPrint =
    (agentOnline && printers.length > 0) ||
    (secure && (usb || serial) && checks.find((c) => c.id === "webusb-permission")?.status === "ok");

  const summary =
    failures > 0
      ? `${failures} bloqueio(s) de impressão${warnings ? ` e ${warnings} ponto(s) de atenção` : ""}.`
      : warnings > 0
        ? `Compatível com ${warnings} ponto(s) de atenção.`
        : "Totalmente compatível: canal, impressora, papel e acentos conferidos.";

  return { checks, canPrint, summary, ranAt: new Date().toLocaleString("pt-BR") };
}
