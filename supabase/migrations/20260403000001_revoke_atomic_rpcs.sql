-- Fix: REVOKE public access + harden search_path for atomic RPCs (BH-ERR-016 follow-up)
-- These SECURITY DEFINER functions were created without GRANT/REVOKE,
-- leaving them callable by anon/authenticated via PostgREST.

-- increment_student_stat
REVOKE ALL ON FUNCTION increment_student_stat(UUID, TEXT, INT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_student_stat(UUID, TEXT, INT) TO service_role;
ALTER FUNCTION increment_student_stat(UUID, TEXT, INT) SET search_path = public, pg_temp;

-- decrement_streak_freezes
REVOKE ALL ON FUNCTION decrement_streak_freezes(UUID, UUID, INT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION decrement_streak_freezes(UUID, UUID, INT) TO service_role;
ALTER FUNCTION decrement_streak_freezes(UUID, UUID, INT) SET search_path = public, pg_temp;

-- increment_bkt_attempts (also created in same migration batch, same issue)
REVOKE ALL ON FUNCTION increment_bkt_attempts(UUID, UUID, INT, INT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_bkt_attempts(UUID, UUID, INT, INT) TO service_role;
ALTER FUNCTION increment_bkt_attempts(UUID, UUID, INT, INT) SET search_path = public, pg_temp;
