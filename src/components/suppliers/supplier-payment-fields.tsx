/**
 * Campos de pagamento do fornecedor.
 *
 * Fica isolado do formulário principal porque a regra de negócio aqui é
 * financeira (dia de vencimento, prazo, formas aceitas) e tende a crescer.
 * O componente é controlado: não guarda estado, apenas reporta mudanças.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const PAYMENT_METHODS = [
  { value: "pix", label: "Pix" },
  { value: "boleto", label: "Boleto" },
  { value: "transferencia", label: "Transferência / TED" },
  { value: "dinheiro", label: "Dinheiro" },
  { value: "cartao", label: "Cartão" },
  { value: "cheque", label: "Cheque" },
  { value: "prazo", label: "Faturado (prazo)" },
] as const;

export const PIX_KEY_TYPES = [
  { value: "cnpj", label: "CNPJ" },
  { value: "cpf", label: "CPF" },
  { value: "email", label: "E-mail" },
  { value: "telefone", label: "Telefone" },
  { value: "aleatoria", label: "Chave aleatória" },
] as const;

export interface SupplierPaymentValue {
  payment_methods: string[];
  payment_day: string;
  payment_term_days: string;
  payment_condition: string;
  pix_key: string;
  pix_key_type: string;
  lead_time_days: string;
}

export interface SupplierPaymentFieldsProps {
  value: SupplierPaymentValue;
  onChange: (next: SupplierPaymentValue) => void;
}

export function SupplierPaymentFields({ value, onChange }: SupplierPaymentFieldsProps) {
  const patch = (p: Partial<SupplierPaymentValue>) => onChange({ ...value, ...p });

  const toggleMethod = (method: string, checked: boolean) => {
    const set = new Set(value.payment_methods);
    if (checked) set.add(method);
    else set.delete(method);
    patch({ payment_methods: Array.from(set) });
  };

  const showPix = value.payment_methods.includes("pix");

  return (
    <div className="col-span-2 space-y-3 border-t border-border pt-3">
      <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
        Pagamento
      </div>

      <div>
        <Label className="text-xs">Formas de pagamento aceitas</Label>
        <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2">
          {PAYMENT_METHODS.map((m) => (
            <label key={m.value} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={value.payment_methods.includes(m.value)}
                onCheckedChange={(c) => toggleMethod(m.value, c === true)}
              />
              {m.label}
            </label>
          ))}
        </div>
      </div>

      {showPix && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Tipo da chave Pix</Label>
            <Select
              value={value.pix_key_type || undefined}
              onValueChange={(v) => patch({ pix_key_type: v })}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Selecione" />
              </SelectTrigger>
              <SelectContent>
                {PIX_KEY_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Chave Pix</Label>
            <Input
              className="mt-1 font-mono"
              value={value.pix_key}
              maxLength={140}
              onChange={(e) => patch({ pix_key: e.target.value })}
              placeholder="chave para pagamento"
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className="text-xs">Dia de pagamento</Label>
          <Input
            className="mt-1"
            type="number"
            min={1}
            max={31}
            value={value.payment_day}
            onChange={(e) => patch({ payment_day: e.target.value })}
            placeholder="ex.: 10"
          />
        </div>
        <div>
          <Label className="text-xs">Prazo (dias)</Label>
          <Input
            className="mt-1"
            type="number"
            min={0}
            max={365}
            value={value.payment_term_days}
            onChange={(e) => patch({ payment_term_days: e.target.value })}
            placeholder="ex.: 28"
          />
        </div>
        <div>
          <Label className="text-xs">Entrega (dias)</Label>
          <Input
            className="mt-1"
            type="number"
            min={0}
            max={365}
            value={value.lead_time_days}
            onChange={(e) => patch({ lead_time_days: e.target.value })}
            placeholder="ex.: 3"
          />
        </div>
      </div>

      <div>
        <Label className="text-xs">Condição / observação de pagamento</Label>
        <Input
          className="mt-1"
          value={value.payment_condition}
          maxLength={200}
          onChange={(e) => patch({ payment_condition: e.target.value })}
          placeholder="ex.: 28/35/42 dias, boleto por e-mail"
        />
      </div>
    </div>
  );
}
