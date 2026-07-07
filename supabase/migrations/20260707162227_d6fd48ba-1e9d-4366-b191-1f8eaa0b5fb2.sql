DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'stores','profiles','user_roles','products','product_stocks',
      'suppliers','customers','sales','sale_items','sale_payments',
      'stock_movements','purchases','purchase_items','cash_registers',
      'cash_movements','invoices','fiscal_configs','fiscal_checklist',
      'receipt_settings'
    ])
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;