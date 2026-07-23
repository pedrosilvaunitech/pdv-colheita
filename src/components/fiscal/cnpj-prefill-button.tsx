import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Building2, Loader2, CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { lookupCnpj, suggestCRT, type CnpjData } from "@/lib/cnpj-lookup";

interface Props {
  cnpj: string | null | undefined;
  onApply: (patch: {
    cnae: string;
    crt: string;
    razao_social?: string;
    fantasia?: string;
    uf?: string;
    municipio?: string;
    cep?: string;
    endereco?: string;
  }) => void;
}

/**
 * Consulta o CNPJ na Receita Federal (BrasilAPI) e sugere valores para os campos
 * fiscais da loja — CNAE, CRT, endereço, razão social. O usuário revisa antes de aplicar.
 */
export function CnpjPrefillButton({ cnpj, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<CnpjData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!cnpj) {
      toast.error("Cadastre o CNPJ da loja em Configurações → Loja antes de consultar.");
      return;
    }
    setOpen(true);
    setLoading(true);
    setErr(null);
    setData(null);
    try {
      const result = await lookupCnpj(cnpj);
      setData(result);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function apply() {
    if (!data) return;
    const suggestion = suggestCRT(data);
    onApply({
      cnae: data.cnae_principal,
      crt: suggestion.crt,
      razao_social: data.razao_social,
      fantasia: data.nome_fantasia ?? undefined,
      uf: data.uf,
      municipio: data.municipio,
      cep: data.cep,
      endereco: [data.logradouro, data.numero, data.complemento, data.bairro]
        .filter(Boolean)
        .join(", "),
    });
    toast.success("Dados fiscais preenchidos automaticamente");
    setOpen(false);
  }

  const suggestion = data ? suggestCRT(data) : null;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={run}
        className="gap-1 w-full"
        disabled={!cnpj}
        title={!cnpj ? "Preencha o CNPJ da loja antes" : "Buscar dados na Receita Federal"}
      >
        <Sparkles className="size-3" /> Pré-preencher pelo CNPJ
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="size-4 text-primary" /> Dados da Receita Federal
            </DialogTitle>
          </DialogHeader>

          {loading && (
            <div className="py-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Consultando CNPJ…
            </div>
          )}

          {err && (
            <div className="border border-destructive/40 bg-destructive/5 rounded-md p-3 text-xs text-destructive flex items-start gap-2">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <span>{err}</span>
            </div>
          )}

          {data && (
            <div className="space-y-3 text-xs">
              <div className="border border-border rounded-md p-3 space-y-1.5 bg-secondary/30">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px]">{data.cnpj}</span>
                  <Badge
                    variant="outline"
                    className={
                      data.situacao === "ATIVA"
                        ? "border-primary/40 text-primary"
                        : "border-destructive/40 text-destructive"
                    }
                  >
                    {data.situacao}
                  </Badge>
                </div>
                <div className="font-semibold text-sm">{data.razao_social}</div>
                {data.nome_fantasia && (
                  <div className="text-muted-foreground italic">{data.nome_fantasia}</div>
                )}
                <div className="text-muted-foreground">
                  {data.municipio}/{data.uf} · CEP {data.cep}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Field label="CNAE principal" value={data.cnae_principal} mono />
                <Field label="Porte" value={data.porte} />
              </div>
              <Field label="Atividade" value={data.cnae_principal_desc} />

              <div className="border border-info/40 bg-info/5 rounded-md p-3 space-y-1">
                <div className="text-info font-semibold flex items-center gap-1">
                  <CheckCircle2 className="size-3" /> Regime tributário sugerido
                </div>
                <div>
                  <b>CRT {suggestion?.crt}</b> · {suggestion?.label}
                </div>
                <div className="text-muted-foreground text-[11px]">{suggestion?.reason}</div>
                {data.data_exclusao_mei && (
                  <div className="text-warning text-[11px] flex items-center gap-1 mt-1">
                    <AlertTriangle className="size-3" />
                    Foi MEI, mas excluído em{" "}
                    {new Date(data.data_exclusao_mei).toLocaleDateString("pt-BR")}.
                  </div>
                )}
              </div>

              {data.cnaes_secundarios.length > 0 && (
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    CNAEs secundários ({data.cnaes_secundarios.length})
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {data.cnaes_secundarios.slice(0, 10).map((c) => (
                      <li key={c.codigo} className="flex gap-2">
                        <span className="font-mono text-muted-foreground">{c.codigo}</span>
                        <span className="truncate">{c.descricao}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="outline" className="flex-1" onClick={() => setOpen(false)}>
                  Cancelar
                </Button>
                <Button size="sm" className="flex-1" onClick={apply}>
                  Aplicar ao formulário
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground text-center">
                A Inscrição Estadual não vem da Receita — busque no portal da SEFAZ da sua UF.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono" : ""}>{value || "—"}</div>
    </div>
  );
}
