import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { SEFAZ_LINKS } from "@/lib/cnpj-lookup";
import { ExternalLink, KeyRound, ShieldCheck, Info } from "lucide-react";

interface Props {
  defaultUf?: string;
  trigger?: React.ReactNode;
}

/**
 * Assistente para gerar CSC ID + CSC Token no portal da SEFAZ da UF.
 * O CSC (Código de Segurança do Contribuinte) NUNCA é retornado pela Receita —
 * cada estado gera o par ID/Token no portal do contribuinte.
 */
export function CscTokenAssistant({ defaultUf = "MG", trigger }: Props) {
  const [uf, setUf] = useState(defaultUf.toUpperCase());
  const link = SEFAZ_LINKS[uf];

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="gap-1">
            <KeyRound className="size-3" /> Como obter CSC
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" /> Assistente CSC / Token NFC-e
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="text-xs text-muted-foreground leading-relaxed">
            O <b>CSC (Código de Segurança do Contribuinte)</b> é um par <b>ID + Token</b> gerado
            no portal SEFAZ do seu estado. Ele é usado para assinar o QR Code da NFC-e — sem ele
            a nota é rejeitada pela SEFAZ (rejeição 778/779).
          </p>

          <div className="space-y-1">
            <label className="text-xs font-medium">Estado de emissão</label>
            <Select value={uf} onValueChange={setUf}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {Object.entries(SEFAZ_LINKS).map(([code, info]) => (
                  <SelectItem key={code} value={code}>{code} · {info.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="border border-border rounded-md bg-secondary/40 p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Badge variant="outline" className="font-mono">{uf}</Badge>
              {link?.name}
            </div>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal ml-4">
              <li>Acesse o portal do contribuinte da <b>{link?.name ?? uf}</b>.</li>
              <li>Faça login com <b>e-CNPJ (A1 ou A3)</b> ou senha do contribuinte.</li>
              <li>
                Procure <b>"NFC-e"</b> → <b>"Gerenciamento de CSC"</b> ou <b>"Código de Segurança do
                Contribuinte"</b>.
              </li>
              <li>Clique em <b>"Gerar novo CSC"</b>. O portal exibe o par <b>ID (6 dígitos)</b> + <b>Token (36 caracteres)</b>.</li>
              <li>
                <b className="text-warning">Copie o Token AGORA</b> — a maioria das SEFAZ só mostra
                uma vez. Se perder, gere um novo (o antigo continua ativo até você revogar).
              </li>
              <li>Cole o par nos campos <b>CSC ID</b> e <b>CSC Token</b> aqui do sistema.</li>
            </ol>
            <a
              href={link?.csc}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-info hover:underline mt-2"
            >
              Abrir portal SEFAZ {uf} <ExternalLink className="size-3" />
            </a>
          </div>

          <div className="border border-info/40 bg-info/5 rounded-md p-3 text-xs text-info flex gap-2">
            <Info className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p>
                <b>Homologação vs produção:</b> a maioria dos estados exige gerar CSC
                <b> separado</b> para cada ambiente. Verifique se o portal tem a aba "Ambiente de
                testes" antes de gerar.
              </p>
              <p>
                <b>Rotação:</b> mantenha o token vigente por 90 dias e gere um novo periodicamente
                (obrigatório em SP, MG, RS).
              </p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
