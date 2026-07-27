import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { AgentDiagnosticsCard } from "@/components/settings/agent-diagnostics-card";
import { WindowsPermissionsChecklist } from "@/components/settings/windows-permissions-checklist";

export const Route = createFileRoute("/_authenticated/agente-diagnostico")({
  head: () => ({
    meta: [
      { title: "Diagnóstico do Agente Local — impressora e balança | Bastion PDV" },
      {
        name: "description",
        content:
          "Verifique agente, impressora térmica, balança serial, TEF e permissões do Windows no PC do caixa em uma única tela de diagnóstico.",
      },
      { property: "og:title", content: "Diagnóstico do Agente Local — Bastion PDV" },
      {
        property: "og:description",
        content:
          "Status do agente, módulos carregados, hardware detectado e checklist de permissões do Windows para o terminal de caixa.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentDiagnosticsPage,
});

function AgentDiagnosticsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Diagnóstico do Agente"
        description="Estado do terminal de caixa: agente, impressora, balança, TEF e permissões do Windows."
      />
      <AgentDiagnosticsCard />
      <WindowsPermissionsChecklist />
    </div>
  );
}
