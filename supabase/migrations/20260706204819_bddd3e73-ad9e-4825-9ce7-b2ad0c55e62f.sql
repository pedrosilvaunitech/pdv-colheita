ALTER TABLE public.fiscal_configs
  ADD COLUMN IF NOT EXISTS defer_credentials boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS credentials_note text;