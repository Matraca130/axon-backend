-- ============================================================================
-- 20260423000001_verify_linking_session_rpc.sql
--
-- Adds two RPCs used by Telegram and WhatsApp linking flows to verify a
-- linking code atomically with a proper timestamptz comparison on the
-- expiry, rather than the lexical ISO-8601 string compare that the backend
-- was doing previously:
--
--   .eq("current_context->>linking_code", code)
--   .gt("current_context->>linking_expires_at", nowIso)
--
-- The lexical compare works TODAY because `new Date().toISOString()` always
-- emits the exact `YYYY-MM-DDTHH:MM:SS.sssZ` UTC form, so string ordering
-- matches temporal ordering. But there's no schema constraint forcing that
-- format on `current_context->>'linking_expires_at'` — a future writer that
-- uses `+00:00` instead of `Z`, or a different millisecond precision, would
-- silently mis-order, and expired codes could remain valid (or vice versa).
--
-- By casting to `timestamptz` inside a SECURITY DEFINER RPC, we:
--   1. Remove the hidden dependency on ISO-8601 lexical ordering.
--   2. Reject malformed expiries loudly (cast errors out) rather than
--      silently mis-comparing.
--   3. Keep the filter fully DB-side (no 200-row scan, no backend-cast
--      gymnastics via raw SQL / view).
--
-- Both RPCs return 0 or 1 rows (maybeSingle-safe on the Node side).
-- ============================================================================

-- ── verify_telegram_linking_session ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_telegram_linking_session(
  p_code text,
  p_now  timestamptz DEFAULT now()
)
RETURNS TABLE(
  chat_id         bigint,
  linking_user_id uuid,
  expires_at      timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    s.chat_id,
    (s.current_context->>'linking_user_id')::uuid AS linking_user_id,
    (s.current_context->>'linking_expires_at')::timestamptz AS expires_at
  FROM public.telegram_sessions AS s
  WHERE s.mode = 'linking'
    AND s.current_context->>'linking_code' = p_code
    AND (s.current_context->>'linking_expires_at')::timestamptz > p_now
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.verify_telegram_linking_session(text, timestamptz) IS
  'Returns the single linking-mode telegram_sessions row matching p_code whose '
  'linking_expires_at (cast to timestamptz) is still in the future. Used by '
  'Telegram verifyLinkCode. See migration 20260423000001 for rationale.';

-- Only the service-role backend may invoke this (it touches telegram_sessions
-- which is otherwise RLS-gated by user_id). Revoke from everyone and grant
-- explicitly to service_role.
REVOKE ALL ON FUNCTION public.verify_telegram_linking_session(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_telegram_linking_session(text, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.verify_telegram_linking_session(text, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.verify_telegram_linking_session(text, timestamptz) TO service_role;

-- ── verify_whatsapp_linking_session ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_whatsapp_linking_session(
  p_code text,
  p_now  timestamptz DEFAULT now()
)
RETURNS TABLE(
  phone_hash      text,
  linking_user_id uuid,
  expires_at      timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    s.phone_hash,
    (s.current_context->>'linking_user_id')::uuid AS linking_user_id,
    (s.current_context->>'linking_expires_at')::timestamptz AS expires_at
  FROM public.whatsapp_sessions AS s
  WHERE s.mode = 'linking'
    AND s.current_context->>'linking_code' = p_code
    AND (s.current_context->>'linking_expires_at')::timestamptz > p_now
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.verify_whatsapp_linking_session(text, timestamptz) IS
  'Returns the single linking-mode whatsapp_sessions row matching p_code whose '
  'linking_expires_at (cast to timestamptz) is still in the future. Used by '
  'WhatsApp verifyLinkCode. See migration 20260423000001 for rationale.';

REVOKE ALL ON FUNCTION public.verify_whatsapp_linking_session(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_whatsapp_linking_session(text, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.verify_whatsapp_linking_session(text, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.verify_whatsapp_linking_session(text, timestamptz) TO service_role;
