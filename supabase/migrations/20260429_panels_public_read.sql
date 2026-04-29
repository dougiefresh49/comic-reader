-- Panels has RLS enabled but no SELECT policy, so the public anon key
-- couldn't read it and getPanelsForPage returned []. Mirrors the
-- existing bubbles "public read" policy.
CREATE POLICY "public read" ON public.panels FOR SELECT TO public USING (true);
