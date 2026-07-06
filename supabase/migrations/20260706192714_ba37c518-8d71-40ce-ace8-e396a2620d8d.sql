
-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM ('admin', 'gerente', 'caixa', 'estoquista');
CREATE TYPE public.tax_regime AS ENUM ('simples_nacional', 'simples_nacional_excesso', 'regime_normal', 'mei');
CREATE TYPE public.fiscal_env AS ENUM ('homologacao', 'producao');
CREATE TYPE public.fiscal_provider AS ENUM ('none', 'focus_nfe', 'nfe_io', 'plugnotas');
CREATE TYPE public.movement_type AS ENUM ('entrada', 'saida', 'ajuste', 'venda', 'devolucao');
CREATE TYPE public.sale_status AS ENUM ('aberta', 'finalizada', 'cancelada');
CREATE TYPE public.payment_method AS ENUM ('dinheiro', 'pix', 'debito', 'credito', 'voucher', 'outro');
CREATE TYPE public.invoice_type AS ENUM ('nfce', 'nfe');
CREATE TYPE public.invoice_status AS ENUM ('rascunho', 'processando', 'autorizada', 'rejeitada', 'cancelada', 'inutilizada');

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ============ STORES ============
CREATE TABLE public.stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  fantasy_name TEXT,
  cnpj TEXT,
  ie TEXT,
  im TEXT,
  address_line TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  phone TEXT,
  tax_regime public.tax_regime NOT NULL DEFAULT 'simples_nacional',
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stores TO authenticated;
GRANT ALL ON public.stores TO service_role;
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;

-- ============ USER ROLES (per store) ============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, store_id, role)
);
CREATE INDEX ON public.user_roles (user_id);
CREATE INDEX ON public.user_roles (store_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- ============ SECURITY DEFINER HELPERS ============
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _store_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND store_id = _store_id AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.has_store_access(_user_id UUID, _store_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND store_id = _store_id
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_store(_user_id UUID, _store_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND store_id = _store_id AND role IN ('admin','gerente')
  );
$$;

CREATE OR REPLACE FUNCTION public.can_operate_pdv(_user_id UUID, _store_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND store_id = _store_id AND role IN ('admin','gerente','caixa')
  );
$$;

-- ============ PROFILES POLICIES + TRIGGER ============
CREATE POLICY "own profile read" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar_url)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email), NEW.raw_user_meta_data->>'avatar_url')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.tg_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- ============ STORES POLICIES ============
-- Qualquer usuário autenticado pode criar loja; ele vira admin automaticamente via trigger
CREATE POLICY "create store" ON public.stores FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by);
CREATE POLICY "read stores with access" ON public.stores FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), id));
CREATE POLICY "update stores if admin" ON public.stores FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), id, 'admin'));
CREATE POLICY "delete stores if admin" ON public.stores FOR DELETE TO authenticated USING (public.has_role(auth.uid(), id, 'admin'));

CREATE TRIGGER trg_stores_updated BEFORE UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- Ao criar loja, criador vira admin
CREATE OR REPLACE FUNCTION public.tg_store_bootstrap_admin()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.user_roles (user_id, store_id, role) VALUES (NEW.created_by, NEW.id, 'admin')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_store_after_insert AFTER INSERT ON public.stores FOR EACH ROW EXECUTE FUNCTION public.tg_store_bootstrap_admin();

-- ============ USER ROLES POLICIES ============
CREATE POLICY "read roles of own stores" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_store_access(auth.uid(), store_id));
CREATE POLICY "admin manages roles" ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), store_id, 'admin'));
CREATE POLICY "admin updates roles" ON public.user_roles FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), store_id, 'admin'));
CREATE POLICY "admin deletes roles" ON public.user_roles FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), store_id, 'admin'));

-- ============ PRODUCTS ============
CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  sku TEXT,
  barcode TEXT,
  name TEXT NOT NULL,
  description TEXT,
  unit TEXT NOT NULL DEFAULT 'UN',
  price_sell NUMERIC(12,2) NOT NULL DEFAULT 0,
  price_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  ncm TEXT,
  cfop TEXT,
  cst TEXT,
  csosn TEXT,
  origin TEXT DEFAULT '0',
  icms_rate NUMERIC(6,3) DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.products (store_id);
CREATE INDEX ON public.products (barcode);
CREATE INDEX ON public.products (store_id, active);
CREATE UNIQUE INDEX products_store_barcode_uk ON public.products (store_id, barcode) WHERE barcode IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read products" ON public.products FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "manage products" ON public.products FOR INSERT TO authenticated WITH CHECK (public.can_manage_store(auth.uid(), store_id));
CREATE POLICY "update products" ON public.products FOR UPDATE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));
CREATE POLICY "delete products" ON public.products FOR DELETE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- ============ STOCK ============
CREATE TABLE public.product_stocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  min_quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, product_id)
);
CREATE INDEX ON public.product_stocks (store_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_stocks TO authenticated;
GRANT ALL ON public.product_stocks TO service_role;
ALTER TABLE public.product_stocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read stocks" ON public.product_stocks FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "insert stocks" ON public.product_stocks FOR INSERT TO authenticated WITH CHECK (public.can_manage_store(auth.uid(), store_id));
CREATE POLICY "update stocks" ON public.product_stocks FOR UPDATE TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "delete stocks" ON public.product_stocks FOR DELETE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));

CREATE TABLE public.stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  type public.movement_type NOT NULL,
  quantity NUMERIC(14,3) NOT NULL,
  unit_cost NUMERIC(12,2),
  reason TEXT,
  ref_sale_id UUID,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.stock_movements (store_id, created_at DESC);
CREATE INDEX ON public.stock_movements (product_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_movements TO authenticated;
GRANT ALL ON public.stock_movements TO service_role;
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read movements" ON public.stock_movements FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "insert movements" ON public.stock_movements FOR INSERT TO authenticated
  WITH CHECK (public.has_store_access(auth.uid(), store_id) AND created_by = auth.uid());

-- Trigger que aplica movimentação no estoque
CREATE OR REPLACE FUNCTION public.tg_apply_stock_movement()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  delta NUMERIC(14,3);
BEGIN
  IF NEW.type IN ('entrada','devolucao') THEN
    delta := NEW.quantity;
  ELSIF NEW.type IN ('saida','venda') THEN
    delta := -NEW.quantity;
  ELSE -- ajuste
    delta := NEW.quantity; -- pode ser negativo
  END IF;

  INSERT INTO public.product_stocks (store_id, product_id, quantity, updated_at)
  VALUES (NEW.store_id, NEW.product_id, delta, now())
  ON CONFLICT (store_id, product_id) DO UPDATE
    SET quantity = public.product_stocks.quantity + EXCLUDED.quantity,
        updated_at = now();
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_stock_movement_apply AFTER INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public.tg_apply_stock_movement();

-- ============ SALES ============
CREATE TABLE public.sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  status public.sale_status NOT NULL DEFAULT 'aberta',
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  customer_cpf TEXT,
  customer_name TEXT,
  operator_id UUID NOT NULL REFERENCES auth.users(id),
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.sales (store_id, created_at DESC);
CREATE INDEX ON public.sales (store_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales TO authenticated;
GRANT ALL ON public.sales TO service_role;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read sales" ON public.sales FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "insert sales" ON public.sales FOR INSERT TO authenticated
  WITH CHECK (public.can_operate_pdv(auth.uid(), store_id) AND operator_id = auth.uid());
CREATE POLICY "update sales" ON public.sales FOR UPDATE TO authenticated
  USING (public.can_operate_pdv(auth.uid(), store_id));
CREATE TRIGGER trg_sales_updated BEFORE UPDATE ON public.sales FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE TABLE public.sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id),
  product_name TEXT NOT NULL,
  barcode TEXT,
  quantity NUMERIC(14,3) NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.sale_items (sale_id);
CREATE INDEX ON public.sale_items (store_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sale_items TO authenticated;
GRANT ALL ON public.sale_items TO service_role;
ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read items" ON public.sale_items FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "insert items" ON public.sale_items FOR INSERT TO authenticated WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));
CREATE POLICY "update items" ON public.sale_items FOR UPDATE TO authenticated USING (public.can_operate_pdv(auth.uid(), store_id));
CREATE POLICY "delete items" ON public.sale_items FOR DELETE TO authenticated USING (public.can_operate_pdv(auth.uid(), store_id));

CREATE TABLE public.sale_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  method public.payment_method NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.sale_payments (sale_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sale_payments TO authenticated;
GRANT ALL ON public.sale_payments TO service_role;
ALTER TABLE public.sale_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read payments" ON public.sale_payments FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "insert payments" ON public.sale_payments FOR INSERT TO authenticated WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));
CREATE POLICY "delete payments" ON public.sale_payments FOR DELETE TO authenticated USING (public.can_operate_pdv(auth.uid(), store_id));

-- ============ FISCAL CONFIG ============
CREATE TABLE public.fiscal_configs (
  store_id UUID PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  provider public.fiscal_provider NOT NULL DEFAULT 'none',
  environment public.fiscal_env NOT NULL DEFAULT 'homologacao',
  nfce_series INT NOT NULL DEFAULT 1,
  nfce_next_number INT NOT NULL DEFAULT 1,
  nfe_series INT NOT NULL DEFAULT 1,
  nfe_next_number INT NOT NULL DEFAULT 1,
  csc_id TEXT,
  csc_token TEXT,
  certificate_uploaded BOOLEAN NOT NULL DEFAULT false,
  certificate_expires_on DATE,
  provider_api_key_set BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fiscal_configs TO authenticated;
GRANT ALL ON public.fiscal_configs TO service_role;
ALTER TABLE public.fiscal_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read fiscal config" ON public.fiscal_configs FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "manage fiscal config" ON public.fiscal_configs FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), store_id, 'admin'));
CREATE POLICY "update fiscal config" ON public.fiscal_configs FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), store_id, 'admin'));

-- ============ FISCAL CHECKLIST ============
CREATE TABLE public.fiscal_checklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  done_at TIMESTAMPTZ,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, step_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fiscal_checklist TO authenticated;
GRANT ALL ON public.fiscal_checklist TO service_role;
ALTER TABLE public.fiscal_checklist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read checklist" ON public.fiscal_checklist FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "upsert checklist" ON public.fiscal_checklist FOR INSERT TO authenticated WITH CHECK (public.can_manage_store(auth.uid(), store_id));
CREATE POLICY "update checklist" ON public.fiscal_checklist FOR UPDATE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));

-- ============ INVOICES ============
CREATE TABLE public.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  sale_id UUID REFERENCES public.sales(id) ON DELETE SET NULL,
  type public.invoice_type NOT NULL,
  status public.invoice_status NOT NULL DEFAULT 'rascunho',
  environment public.fiscal_env NOT NULL DEFAULT 'homologacao',
  series INT NOT NULL,
  number INT NOT NULL,
  access_key TEXT,
  protocol TEXT,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  provider_ref TEXT,
  provider_response JSONB,
  xml_url TEXT,
  danfe_url TEXT,
  rejection_reason TEXT,
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.invoices (store_id, created_at DESC);
CREATE INDEX ON public.invoices (store_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO authenticated;
GRANT ALL ON public.invoices TO service_role;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read invoices" ON public.invoices FOR SELECT TO authenticated USING (public.has_store_access(auth.uid(), store_id));
CREATE POLICY "insert invoices" ON public.invoices FOR INSERT TO authenticated WITH CHECK (public.can_operate_pdv(auth.uid(), store_id));
CREATE POLICY "update invoices" ON public.invoices FOR UPDATE TO authenticated USING (public.can_manage_store(auth.uid(), store_id));
CREATE TRIGGER trg_invoices_updated BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
