DROP POLICY IF EXISTS "own profile read" ON public.profiles;
CREATE POLICY "read own profile or managed store users"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  id = auth.uid()
  OR EXISTS (
    SELECT 1
      FROM public.user_roles target_role
     WHERE target_role.user_id = profiles.id
       AND public.can_manage_store(auth.uid(), target_role.store_id)
  )
);