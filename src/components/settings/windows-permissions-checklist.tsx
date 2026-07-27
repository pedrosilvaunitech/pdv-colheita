import { useMemo, useState } from "react";
import { ShieldCheck, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";

interface ChecklistItem {
  id: string;
  title: string;
  why: string;
  /** Passos objetivos no Windows, na ordem de execução. */
  steps: string[];
  /** Comando PowerShell/CMD opcional para copiar. */
  command?: string;
  critical: boolean;
}

const LS_KEY = "agent.windows.checklist.v1";

const ITEMS: ChecklistItem[] = [
  {
    id: "admin",
    title: "Executar o agente como administrador",
    why: "Sem elevação o Windows bloqueia o acesso USB bruto à impressora e a troca de driver do PIN Pad.",
    steps: [
      "Clique com o botão direito no atalho do Bastion POS Agent.",
      "Propriedades → Compatibilidade → marque 'Executar este programa como administrador'.",
      "Aplique e reinicie o agente.",
    ],
    critical: true,
  },
  {
    id: "startup",
    title: "Iniciar o agente junto com o Windows",
    why: "Se o agente não sobe no boot, o caixa abre o PDV e nada imprime.",
    steps: [
      "Pressione Win + R e digite shell:startup.",
      "Copie o atalho do Bastion POS Agent para a pasta que abrir.",
      "Reinicie o PC e confirme o ícone na bandeja.",
    ],
    command: "shell:startup",
    critical: true,
  },
  {
    id: "firewall",
    title: "Liberar a porta 9100 no Firewall (perfil privado)",
    why: "O navegador chama http://127.0.0.1:9100. Alguns antivírus bloqueiam o loopback do Node.",
    steps: [
      "Abra o PowerShell como administrador.",
      "Rode o comando ao lado.",
      "Se usar antivírus de terceiros (Avast, Kaspersky, Sophos), adicione o executável do agente às exceções.",
    ],
    command:
      'New-NetFirewallRule -DisplayName "Bastion POS Agent" -Direction Inbound -LocalPort 9100 -Protocol TCP -Action Allow -Profile Private',
    critical: true,
  },
  {
    id: "serial-driver",
    title: "Instalar o driver do conversor USB-Serial da balança",
    why: "Sem driver não existe porta COM e a autodetecção não encontra a balança.",
    steps: [
      "Abra o Gerenciador de Dispositivos (Win + X → Gerenciador de Dispositivos).",
      "Procure em 'Portas (COM e LPT)'. Se houver item com triângulo amarelo, o driver está faltando.",
      "Instale o driver do chip: Prolific PL2303, FTDI FT232 ou CH340/CH341.",
      "Anote a porta (ex.: COM3) e rode 'Detectar automaticamente' nas configurações.",
    ],
    command: "devmgmt.msc",
    critical: false,
  },
  {
    id: "printer-driver",
    title: "Instalar a impressora térmica no spooler do Windows",
    why: "O canal spooler é o mais estável — usa o driver oficial e dispensa WinUSB.",
    steps: [
      "Configurações → Bluetooth e dispositivos → Impressoras e scanners.",
      "Instale o driver do fabricante (Epson TM-T20X, Elgin i9, Bematech MP-4200…).",
      "Imprima a página de teste do Windows antes de testar pelo PDV.",
    ],
    critical: true,
  },
  {
    id: "winusb",
    title: "WinUSB (Zadig) somente se usar USB bruto",
    why: "Trocar o driver por WinUSB remove a impressora do spooler. Faça apenas se o spooler não funcionar.",
    steps: [
      "Baixe o Zadig em zadig.akeo.ie.",
      "Options → List All Devices e selecione a impressora.",
      "Troque o driver para WinUSB e reinicie o agente.",
      "Para voltar atrás: Gerenciador de Dispositivos → desinstalar o dispositivo marcando 'excluir o driver' e reinstalar o driver do fabricante.",
    ],
    critical: false,
  },
  {
    id: "energy",
    title: "Desativar suspensão seletiva de USB",
    why: "O Windows desliga a porta USB para economizar energia e a impressora 'some' no meio do expediente.",
    steps: [
      "Painel de Controle → Opções de Energia → Alterar configurações do plano.",
      "Configurações avançadas → Configurações USB → Suspensão seletiva USB → Desabilitado.",
      "Faça o mesmo em 'Gerenciamento de energia' de cada Hub USB Raiz no Gerenciador de Dispositivos.",
    ],
    command: "powercfg.cpl",
    critical: false,
  },
  {
    id: "port-conflict",
    title: "Fechar programas que ocupam a porta COM",
    why: "A porta serial é exclusiva: o software da balança ou um PDV antigo aberto impede a leitura.",
    steps: [
      "Feche softwares do fabricante da balança e sistemas de PDV legados.",
      "Se o erro 'Acesso negado' persistir, reinicie o PC — algum serviço mantém o handle aberto.",
    ],
    critical: false,
  },
];

/**
 * Checklist operacional de permissões do Windows para o caixa.
 * O progresso é local ao terminal (localStorage), porque as pendências são
 * do PC físico e não do usuário logado.
 */
export function WindowsPermissionsChecklist() {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });

  const toggle = (id: string, value: boolean) => {
    setChecked((prev) => {
      const next = { ...prev, [id]: value };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next));
      } catch {
        /* modo privado: segue sem persistir */
      }
      return next;
    });
  };

  const { done, criticalPending } = useMemo(
    () => ({
      done: ITEMS.filter((i) => checked[i.id]).length,
      criticalPending: ITEMS.filter((i) => i.critical && !checked[i.id]).length,
    }),
    [checked],
  );

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Comando copiado.");
    } catch {
      toast.error("Não foi possível copiar o comando.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" /> Checklist de permissões (Windows)
        </CardTitle>
        <CardDescription>
          Percorra os itens no PC do caixa. {done} de {ITEMS.length} concluídos
          {criticalPending > 0 && ` · ${criticalPending} obrigatório${criticalPending > 1 ? "s" : ""} pendente${criticalPending > 1 ? "s" : ""}`}
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {ITEMS.map((item) => (
          <div
            key={item.id}
            className="rounded border border-border p-3 data-[done=true]:opacity-60"
            data-done={!!checked[item.id]}
          >
            <div className="flex items-start gap-3">
              <Checkbox
                id={`chk-${item.id}`}
                checked={!!checked[item.id]}
                onCheckedChange={(v) => toggle(item.id, v === true)}
                className="mt-1"
              />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label
                    htmlFor={`chk-${item.id}`}
                    className="cursor-pointer text-sm font-medium text-foreground"
                  >
                    {item.title}
                  </label>
                  <Badge variant={item.critical ? "destructive" : "secondary"}>
                    {item.critical ? "Obrigatório" : "Recomendado"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{item.why}</p>
                <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                  {item.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                {item.command && (
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px] text-foreground">
                      {item.command}
                    </code>
                    <Button variant="ghost" size="sm" onClick={() => void copy(item.command!)}>
                      <Copy className="size-3" />
                    </Button>
                  </div>
                )}
                {item.id === "winusb" && (
                  <a
                    href="https://zadig.akeo.ie"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2"
                  >
                    Abrir site do Zadig <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
