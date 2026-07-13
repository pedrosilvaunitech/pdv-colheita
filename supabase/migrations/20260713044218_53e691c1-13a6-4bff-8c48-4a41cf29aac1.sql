-- Permitir reutilizar o mesmo número de comanda (modelo restaurante):
-- só pode existir UMA comanda "aberta" por número/loja; fechadas/canceladas ficam no histórico.
ALTER TABLE public.comandas DROP CONSTRAINT IF EXISTS comandas_store_id_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_comandas_open_per_number
  ON public.comandas(store_id, number) WHERE status = 'aberta';