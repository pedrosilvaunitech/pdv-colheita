
-- Fix missing Data API grants on all public tables
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.stores, public.user_roles, public.profiles,
  public.customers, public.suppliers, public.products, public.product_stocks,
  public.stock_movements, public.purchases, public.purchase_items,
  public.sales, public.sale_items, public.sale_payments,
  public.cash_registers, public.cash_movements,
  public.receipt_settings, public.fiscal_configs, public.fiscal_checklist,
  public.invoices
TO authenticated;

GRANT ALL ON
  public.stores, public.user_roles, public.profiles,
  public.customers, public.suppliers, public.products, public.product_stocks,
  public.stock_movements, public.purchases, public.purchase_items,
  public.sales, public.sale_items, public.sale_payments,
  public.cash_registers, public.cash_movements,
  public.receipt_settings, public.fiscal_configs, public.fiscal_checklist,
  public.invoices
TO service_role;

-- Certificado digital A1 (armazenado em storage privado)
ALTER TABLE public.fiscal_configs
  ADD COLUMN IF NOT EXISTS certificate_path text,
  ADD COLUMN IF NOT EXISTS certificate_filename text,
  ADD COLUMN IF NOT EXISTS certificate_password_set boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS certificate_subject text,
  ADD COLUMN IF NOT EXISTS provider_api_url text,
  ADD COLUMN IF NOT EXISTS cnae text,
  ADD COLUMN IF NOT EXISTS crt text;

-- Personalização do cupom/nota
ALTER TABLE public.receipt_settings
  ADD COLUMN IF NOT EXISTS show_logo boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_cnpj boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_address boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_operator boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_customer boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_item_code boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_qrcode boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS font_size text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS thank_you_text text,
  ADD COLUMN IF NOT EXISTS extra_info text;
