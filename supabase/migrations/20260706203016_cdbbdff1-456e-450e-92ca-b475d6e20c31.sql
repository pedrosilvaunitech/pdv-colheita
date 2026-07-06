
-- storage policies (path prefix = store_id)
CREATE POLICY "cert manage by store managers"
  ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'fiscal-certificates'
    AND public.can_manage_store(auth.uid(), ((storage.foldername(name))[1])::uuid)
  )
  WITH CHECK (
    bucket_id = 'fiscal-certificates'
    AND public.can_manage_store(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "logo read by store users"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'receipt-logos'
    AND public.has_store_access(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "logo manage by store managers"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'receipt-logos'
    AND public.can_manage_store(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "logo update by store managers"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'receipt-logos'
    AND public.can_manage_store(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "logo delete by store managers"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'receipt-logos'
    AND public.can_manage_store(auth.uid(), ((storage.foldername(name))[1])::uuid)
  );
