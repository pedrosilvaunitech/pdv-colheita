/**
 * Auditoria dos vínculos fornecedor ⇄ produto.
 *
 * A Reposição só funciona bem quando cada produto ativo tem fornecedor e um
 * preferencial claro. Este painel expõe as inconsistências (regras em
 * `src/lib/supplier-validation.ts`) para o comprador corrigir antes de
 * disparar pedidos.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldCheck, AlertTriangle, TriangleAlert, RefreshCw, CheckCircle2 } from "lucide-react";
import { auditSupplierLinks, type LinkIssue } from "@/lib/supplier-validation";

export interface SupplierLinkAuditCardProps {
  storeId: string;
  /** Abre o catálogo de produtos de um fornecedor a partir de um problema. */
  onOpenSupplier?: (supplierId: string) => void;
}

export function SupplierLinkAuditCard({ storeId, onOpenSupplier }: SupplierLinkAuditCardProps) {
  const audit = useQuery({
    queryKey: ["product-suppliers", "audit", storeId],
    enabled: Boolean(storeId),
    queryFn: async () => {
      const [products, suppliers, links] = await Promise.all([
        supabase.from("products").select("id,name,active").eq("store_id", storeId),
        supabase.from("suppliers").select("id,name,phone,email").eq("store_id", storeId),
        supabase
          .from("product_suppliers")
          .select("product_id,supplier_id,unit_cost,is_preferred")
          .eq("store_id", storeId),
      ]);
      if (products.error) throw new Error(products.error.message);
      if (suppliers.error) throw new Error(suppliers.error.message);
      if (links.error) throw new Error(links.error.message);

      return auditSupplierLinks(
        products.data ?? [],
        suppliers.data ?? [],
        (links.data ?? []).map((l) => ({
          product_id: l.product_id,
          supplier_id: l.supplier_id,
          unit_cost: l.unit_cost == null ? null : Number(l.unit_cost),
          is_preferred: l.is_preferred,
        })),
      );
    },
  });

  const result = audit.data;
  const coverage = result && result.totalActiveProducts > 0
    ? Math.round((result.linkedProducts / result.totalActiveProducts) * 100)
    : 100;

  return (
    <div className="border border-border rounded-md bg-card">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <div>
            <div className="text-sm font-medium">Validação dos vínculos fornecedor ⇄ produto</div>
            <div className="text-xs text-muted-foreground">
              {result
                ? `${result.linkedProducts}/${result.totalActiveProducts} produtos ativos com fornecedor (${coverage}%)`
                : "Analisando cadastro…"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {result && (
            <>
              <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive">
                <AlertTriangle className="size-3" /> {result.counts.critico}
              </Badge>
              <Badge variant="outline" className="gap-1 border-warning/40 text-warning">
                <TriangleAlert className="size-3" /> {result.counts.aviso}
              </Badge>
            </>
          )}
          <Button
            size="sm" variant="outline" className="gap-2"
            onClick={() => audit.refetch()} disabled={audit.isFetching}
          >
            <RefreshCw className={`size-3.5 ${audit.isFetching ? "animate-spin" : ""}`} /> Revalidar
          </Button>
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto divide-y divide-border">
        {result && result.issues.length === 0 && (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-primary" />
            Nenhuma inconsistência encontrada nos vínculos.
          </div>
        )}
        {(result?.issues ?? []).slice(0, 60).map((issue, i) => (
          <IssueRow key={`${issue.kind}-${issue.productId ?? issue.supplierId ?? i}`} issue={issue} onOpenSupplier={onOpenSupplier} />
        ))}
        {(result?.issues.length ?? 0) > 60 && (
          <div className="px-4 py-2 text-xs text-muted-foreground">
            Exibindo as 60 primeiras de {result?.issues.length} ocorrências.
          </div>
        )}
      </div>
    </div>
  );
}

function IssueRow({
  issue, onOpenSupplier,
}: { issue: LinkIssue; onOpenSupplier?: (supplierId: string) => void }) {
  const critical = issue.severity === "critico";
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium truncate">
          {critical
            ? <AlertTriangle className="size-3.5 text-destructive shrink-0" />
            : <TriangleAlert className="size-3.5 text-warning shrink-0" />}
          <span className="truncate">{issue.title}</span>
        </div>
        <div className="text-xs text-muted-foreground">{issue.detail}</div>
      </div>
      {issue.supplierId && onOpenSupplier && (
        <Button size="sm" variant="ghost" onClick={() => onOpenSupplier(issue.supplierId!)}>
          Abrir
        </Button>
      )}
    </div>
  );
}
