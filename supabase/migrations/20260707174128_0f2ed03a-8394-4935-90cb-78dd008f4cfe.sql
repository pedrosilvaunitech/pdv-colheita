
-- =========== pix_configs ===========
CREATE TABLE public.pix_configs (
  store_id UUID PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'estatico' CHECK (mode IN ('estatico','mercadopago','efi','asaas','inter')),
  pix_key TEXT,
  pix_key_type TEXT CHECK (pix_key_type IN ('cpf','cnpj','email','telefone','aleatoria')),
  merchant_name TEXT,
  merchant_city TEXT,
  environment TEXT NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox','producao')),
  -- Mercado Pago
  mp_client_id TEXT,
  mp_access_token_set BOOLEAN NOT NULL DEFAULT false,
  -- Efí (Gerencianet)
  efi_client_id TEXT,
  efi_client_secret_set BOOLEAN NOT NULL DEFAULT false,
  efi_certificate_uploaded BOOLEAN NOT NULL DEFAULT false,
  efi_certificate_path TEXT,
  -- Asaas
  asaas_api_key_set BOOLEAN NOT NULL DEFAULT false,
  -- Inter/Sicoob/Sicredi (open finance)
  bank_client_id TEXT,
  bank_client_secret_set BOOLEAN NOT NULL DEFAULT false,
  bank_certificate_uploaded BOOLEAN NOT NULL DEFAULT false,
  bank_certificate_path TEXT,
  -- webhook
  webhook_secret TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pix_configs TO authenticated;
GRANT ALL ON public.pix_configs TO service_role;
ALTER TABLE public.pix_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pix_configs_read" ON public.pix_configs FOR SELECT TO authenticated
  USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "pix_configs_write" ON public.pix_configs FOR ALL TO authenticated
  USING (public.can_manage_store(auth.uid(), store_id))
  WITH CHECK (public.can_manage_store(auth.uid(), store_id));

CREATE TRIGGER trg_pix_configs_updated_at BEFORE UPDATE ON public.pix_configs
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- =========== pix_charges ===========
CREATE TABLE public.pix_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  sale_id UUID REFERENCES public.sales(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  txid TEXT NOT NULL,
  external_id TEXT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  brcode TEXT NOT NULL,
  qr_image TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','pago','expirado','cancelado')),
  payer_name TEXT,
  payer_doc TEXT,
  end_to_end_id TEXT,
  paid_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  raw_response JSONB,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pix_charges_store_status_idx ON public.pix_charges(store_id, status, created_at DESC);
CREATE INDEX pix_charges_txid_idx ON public.pix_charges(txid);
CREATE INDEX pix_charges_external_id_idx ON public.pix_charges(external_id) WHERE external_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON public.pix_charges TO authenticated;
GRANT ALL ON public.pix_charges TO service_role;
ALTER TABLE public.pix_charges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pix_charges_read" ON public.pix_charges FOR SELECT TO authenticated
  USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "pix_charges_insert" ON public.pix_charges FOR INSERT TO authenticated
  WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));
CREATE POLICY "pix_charges_update" ON public.pix_charges FOR UPDATE TO authenticated
  USING (public.can_operate_pdv(auth.uid(), store_id))
  WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));

CREATE TRIGGER trg_pix_charges_updated_at BEFORE UPDATE ON public.pix_charges
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
