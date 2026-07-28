/**
 * Diagnóstico de falhas do motor fiscal (Direto SEFAZ via Agente Local).
 *
 * Traduz o erro cru (rede, HTTP, cStat da SEFAZ, libs ausentes) numa causa
 * provável + passos acionáveis, para o operador do caixa resolver sozinho
 * sem abrir chamado.
 */

export type SefazFailureCode =
  | "agent_offline"
  | "engine_missing"
  | "certificate"
  | "config"
  | "sefaz_down"
  | "network"
  | "rejected"
  | "unknown";

export type SefazSeverity = "critical" | "warning";

export interface SefazDiagnosis {
  code: SefazFailureCode;
  severity: SefazSeverity;
  /** Título curto para o alerta. */
  title: string;
  /** Causa provável em linguagem de operador. */
  cause: string;
  /** Passos concretos, em ordem. */
  steps: string[];
  /** Mensagem técnica original — exibida em detalhes. */
  raw: string;
}

interface Rule {
  code: SefazFailureCode;
  severity: SefazSeverity;
  test: RegExp;
  title: string;
  cause: string;
  steps: string[];
}

/**
 * Ordem importa: a primeira regra que casar vence. Regras mais específicas
 * (certificado, cStat) vêm antes das genéricas (rede).
 */
const RULES: Rule[] = [
  {
    code: "engine_missing",
    severity: "critical",
    test: /node-dfe|motor nfc-e não carregado|motor nfce não carregado|501/i,
    title: "Motor fiscal não carregado no Agente",
    cause: "O Agente Local está aberto, mas a biblioteca de emissão (node-dfe) não foi instalada.",
    steps: [
      "Abra o Prompt de Comando na pasta do agente (ex.: C:\\pdv\\pdv-colheita\\desktop).",
      "Execute: npm install",
      "Feche e reabra o Bastion POS Agent.",
      "Volte aqui e clique em “Verificar agora”.",
    ],
  },
  {
    code: "certificate",
    severity: "critical",
    test: /certificad|\.pfx|pkcs12|senha|password|expirad|vencid|mac verify|invalid password/i,
    title: "Problema no certificado A1",
    cause: "O arquivo .pfx não foi encontrado, a senha está incorreta ou o certificado venceu.",
    steps: [
      "Confirme o caminho do .pfx na máquina do caixa.",
      "Revise a senha do certificado (diferença de maiúsculas conta).",
      "Verifique a validade — certificado A1 vale 12 meses.",
      "Após corrigir, reinicie o Agente Local.",
    ],
  },
  {
    code: "config",
    severity: "critical",
    test: /configuração ausente|csc|cnpj|uf .* não mapeada|inscrição estadual|crt/i,
    title: "Configuração fiscal incompleta",
    cause: "Falta CNPJ, UF, CSC ID/Token ou CRT no cadastro espelhado para o agente.",
    steps: [
      "Vá em Fiscal → Dados do emitente e preencha CNPJ, IE, CNAE e CRT.",
      "Preencha CSC ID e CSC Token emitidos no portal da SEFAZ do seu estado.",
      "Clique em “Salvar configuração” para reenviar os dados ao Agente Local.",
    ],
  },
  {
    code: "agent_offline",
    severity: "critical",
    test: /não respondeu em 127\.0\.0\.1|agente local não respondeu|agente local offline|econnrefused/i,
    title: "Agente Local fechado",
    cause: "O navegador não conseguiu falar com o Bastion POS Agent em 127.0.0.1:9100.",
    steps: [
      "Procure o ícone do Bastion POS Agent na bandeja do Windows (perto do relógio).",
      "Se não estiver lá, abra o agente pelo atalho na área de trabalho.",
      "Confirme que o Firewall do Windows não está bloqueando a porta 9100.",
      "Recarregue esta página (Ctrl+F5).",
    ],
  },
  {
    // Precede a regra de rejeição: cStat 108/109 são paralisação, não recusa de dados.
    code: "sefaz_down",
    severity: "warning",
    test: /servi[çc]o (?:em manuten[çc]|paralisad|indisponí)|cstat\s*10[89]\b|timeout da sefaz|gateway timeout|\b50[34]\b/i,
    title: "SEFAZ indisponível",
    cause: "O ambiente da SEFAZ do seu estado está fora do ar ou em manutenção — não é problema do seu PDV.",
    steps: [
      "Continue vendendo: as notas ficam pendentes e são reenviadas automaticamente.",
      "Acompanhe em Fiscal → Erros de emissão.",
      "Nenhuma ação manual é necessária enquanto o serviço não volta.",
    ],
  },
  {
    code: "rejected",
    severity: "warning",
    test: /cstat\s*(?:1[0-9]{2}|2[0-9]{2}|[3-7][0-9]{2})|rejei[çc]/i,
    title: "SEFAZ rejeitou a requisição",
    cause: "A SEFAZ respondeu, mas recusou os dados enviados (cStat de rejeição).",
    steps: [
      "Leia o motivo retornado abaixo — ele indica o campo problemático.",
      "Corrija o cadastro (produto, NCM, CFOP, CSC ou dados do emitente).",
      "Reenvie a nota pela tela Fiscal → Erros de emissão.",
    ],
  },
  {
    code: "network",
    severity: "warning",
    test: /failed to fetch|load failed|networkerror|abort|enotfound|etimedout|socket|dns/i,
    title: "Falha de rede",
    cause: "A conexão entre o caixa e a SEFAZ (ou o agente) caiu no meio do caminho.",
    steps: [
      "Verifique a internet do caixa.",
      "Se usa proxy ou firewall corporativo, libere os domínios da SEFAZ (*.fazenda.*.gov.br).",
      "Tente novamente em alguns segundos.",
    ],
  },
];

/** Converte um erro cru em diagnóstico acionável. Nunca lança. */
export function diagnoseSefazFailure(rawError: unknown): SefazDiagnosis {
  const raw = rawError instanceof Error ? rawError.message : String(rawError ?? "Erro desconhecido");
  const rule = RULES.find((r) => r.test.test(raw));
  if (rule) {
    return { code: rule.code, severity: rule.severity, title: rule.title, cause: rule.cause, steps: rule.steps, raw };
  }
  return {
    code: "unknown",
    severity: "warning",
    title: "Falha não identificada na emissão",
    cause: "O motor fiscal respondeu com um erro que não está no catálogo de diagnósticos.",
    steps: [
      "Copie a mensagem técnica abaixo.",
      "Confira Diagnóstico do Agente para ver o estado geral do terminal.",
      "Se persistir, envie a mensagem ao suporte.",
    ],
    raw,
  };
}
