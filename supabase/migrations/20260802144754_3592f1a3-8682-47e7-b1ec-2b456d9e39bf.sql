CREATE OR REPLACE FUNCTION public.log_sensitive_change(
  _store_id uuid,
  _area text,
  _action text,
  _detail text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_area text := lower(regexp_replace(COALESCE(_area, 'desconhecida'), '[^a-zA-Z0-9_.-]', '', 'g'));
  v_action text := lower(regexp_replace(COALESCE(_action, 'alteracao'), '[^a-zA-Z0-9_.-]', '', 'g'));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  IF _store_id IS NULL OR NOT public.has_store_access(auth.uid(), _store_id) THEN
    RAISE EXCEPTION 'Sem acesso a esta loja';
  END IF;

  IF length(v_area) = 0 THEN v_area := 'desconhecida'; END IF;
  IF length(v_action) = 0 THEN v_action := 'alteracao'; END IF;

  INSERT INTO public.rpc_audit_log (user_id, function_name, store_id, allowed, detail)
  VALUES (
    auth.uid(),
    'sensitive:' || v_area || '.' || v_action,
    _store_id,
    true,
    left(COALESCE(_detail, ''), 1000)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.log_sensitive_change(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_sensitive_change(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_sensitive_change(uuid, text, text, text) TO service_role;