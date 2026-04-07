-- PG14+ syntax — no DROP TRIGGER needed.
CREATE OR REPLACE TRIGGER foo_set_updated_at
  BEFORE UPDATE ON public.foo
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
