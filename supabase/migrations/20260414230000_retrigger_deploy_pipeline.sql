-- Migration: retrigger deploy-migrations workflow (no-op)
-- Date: 2026-04-14
--
-- Purpose: Force a new `supabase/migrations/**` path change so the
--          deploy-migrations workflow re-runs. The previous run for
--          `20260414000001_review_batch_rpc.sql` failed because Guard B
--          flagged the file's legitimate idioms:
--            - `DROP FUNCTION IF EXISTS` before `CREATE OR REPLACE`
--              (needed to change the function signature cleanly)
--            - `REVOKE ALL ON FUNCTION ... FROM PUBLIC` before `GRANT`
--              (standard hardening pattern for SECURITY DEFINER RPCs)
--
-- The merge commit message for this push contains the literal token
-- `[migration:destructive-ok]`, which instructs the guard to skip the
-- destructive-SQL scan for the commits in this push range. Guard A
-- (append-only) and the manual production-db reviewer gate still apply.
--
-- This file is intentionally a no-op. It exists solely to satisfy the
-- `paths: supabase/migrations/**` trigger filter so the workflow runs.
-- `supabase db push` will apply both this file and the prior-pending
-- `20260414000001_review_batch_rpc.sql` in order, inside a transaction.

DO $$
BEGIN
  -- no-op: retrigger marker only
  PERFORM 1;
END;
$$;
