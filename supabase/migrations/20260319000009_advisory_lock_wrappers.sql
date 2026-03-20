-- Wrapper functions for pg_catalog advisory locks.
-- pg_try_advisory_lock / pg_advisory_unlock are built-ins that PostgREST
-- does not expose directly; these wrappers make them callable via .rpc().

CREATE OR REPLACE FUNCTION try_advisory_lock(lock_key BIGINT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN pg_try_advisory_lock(lock_key);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION advisory_unlock(lock_key BIGINT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN pg_advisory_unlock(lock_key);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION try_advisory_lock(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION try_advisory_lock(BIGINT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION advisory_unlock(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advisory_unlock(BIGINT) TO authenticated, service_role;
