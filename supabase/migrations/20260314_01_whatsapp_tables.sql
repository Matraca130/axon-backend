-- ============================================================================
-- Migration: WhatsApp Integration Tables (Phase 0)
-- Date: 2026-03-14
-- Purpose: Schema foundation for the WhatsApp chatbot system.
--          3 tables + 1 message queue + 2 scheduled cleanup jobs.
--
-- References:
--   WA-4:  Phone linking with PII protection (SHA-256 + salt)
--   WA-5:  Session management with optimistic locking
--   WA-16: Message logging for observability and analytics
--   AUDIT F1: Filename 20260314_01 (sequential after 20260313_02)
--   AUDIT F2: NO FK on whatsapp_sessions.phone_hash (unlinked users
--             need temporary sessions during the linking flow S08)
--   AUDIT F6: pgmq extension with fallback table
--   AUDIT F7: wa_message_id column for Meta message deduplication
--
-- Design decisions:
--   D1: phone_hash uses SHA-256(phone + per-user salt). The raw phone
--       number is NEVER stored. Salt is per-user random, stored in
--       whatsapp_links.phone_salt. Lookup requires knowing the salt.
--   D2: whatsapp_sessions has NO FK to whatsapp_links because during
--       the linking flow (S08), an unlinked user sends a verification
--       code and needs a temporary session BEFORE the link exists.
--       user_id is NULLABLE for the same reason.
--   D3: whatsapp_message_log stores wa_message_id (Meta's original ID)
--       for deduplication. This works for ALL users (linked or not)
--       without requiring phone_hash lookup.
--   D4: No RLS on sessions/logs — accessed exclusively via
--       getAdminClient() from the webhook handler (no JWT context).
--       whatsapp_links HAS RLS (users manage their own link via web UI).
--   D5: Optimistic locking via version column on sessions. Prevents
--       race conditions when concurrent messages arrive for same user.
--   D6: pgmq used for async job queue (generate_content, weekly_report).
--       Fallback table provided if pgmq extension is unavailable.
--
-- Prerequisites:
--   - pg_cron extension enabled (confirmed: 20260305_04 uses it)
--   - pgmq extension: enabled if available, fallback otherwise
--   - 39 existing tables UNTOUCHED
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════
-- 1. whatsapp_links — Phone-to-user linking (PII protected)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS whatsapp_links (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid          NOT NULL UNIQUE
                              REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_hash    text          NOT NULL UNIQUE,
  phone_salt    text          NOT NULL,
  linked_at     timestamptz   NOT NULL DEFAULT now(),
  is_active     boolean       NOT NULL DEFAULT true
);

-- RLS: Users can only see/update their own link
ALTER TABLE whatsapp_links ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'whatsapp_links' AND policyname = 'whatsapp_links_own_row'
  ) THEN
    CREATE POLICY whatsapp_links_own_row ON whatsapp_links
      FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- Lookup by phone_hash (webhook → find user)
CREATE INDEX IF NOT EXISTS idx_whatsapp_links_phone_hash
  ON whatsapp_links (phone_hash);

-- Lookup by user_id (web UI → find my link)
-- Note: UNIQUE constraint on user_id already creates a B-tree index,
-- so no separate index needed.

COMMENT ON TABLE whatsapp_links IS
  'Maps Axon users to WhatsApp phone numbers. Phone stored as SHA-256(phone+salt), never in plaintext. One link per user (UNIQUE user_id). RLS enabled.';

COMMENT ON COLUMN whatsapp_links.phone_hash IS
  'SHA-256 hex of (phone_number + phone_salt). Used for lookups from webhook. Raw phone NEVER stored (WA-4 PII protection).';

COMMENT ON COLUMN whatsapp_links.phone_salt IS
  'Per-user random salt for phone hashing. Stored here so webhook can compute hash for lookup. Different salt per user prevents rainbow table attacks.';


-- ═══════════════════════════════════════════════════════════════
-- 2. whatsapp_sessions — Conversation state (no RLS, admin-only)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  phone_hash      text          PRIMARY KEY,
  -- D2: NO FK to whatsapp_links. user_id NULLABLE for unlinked users.
  user_id         uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  history         jsonb         NOT NULL DEFAULT '[]'::jsonb,
  current_tool    text,
  current_context jsonb         NOT NULL DEFAULT '{}'::jsonb,
  mode            text          NOT NULL DEFAULT 'conversation'
    CHECK (mode IN ('conversation', 'flashcard_review', 'linking')),
  last_message_id text,
  -- D5: Optimistic locking
  version         integer       NOT NULL DEFAULT 0,
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  expires_at      timestamptz   NOT NULL DEFAULT (now() + interval '30 minutes')
);

-- No RLS: accessed via getAdminClient() from webhook handler (D4)

-- Trigger: auto-update updated_at on any change
CREATE OR REPLACE FUNCTION update_whatsapp_sessions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_whatsapp_sessions_updated_at ON whatsapp_sessions;
CREATE TRIGGER trg_whatsapp_sessions_updated_at
  BEFORE UPDATE ON whatsapp_sessions
  FOR EACH ROW EXECUTE FUNCTION update_whatsapp_sessions_updated_at();

COMMENT ON TABLE whatsapp_sessions IS
  'Active WhatsApp conversation state. Keyed by phone_hash. No FK to whatsapp_links (D2: unlinked users need temp sessions for linking flow). TTL 30min, cleaned by pg_cron.';

COMMENT ON COLUMN whatsapp_sessions.version IS
  'Optimistic locking counter. UPDATE WHERE version = N, SET version = N+1. Prevents race conditions from concurrent webhook deliveries (D5).';

COMMENT ON COLUMN whatsapp_sessions.mode IS
  'conversation = normal Gemini agentic loop. flashcard_review = deterministic state machine (bypasses Gemini, ~200ms). linking = awaiting verification code.';

COMMENT ON COLUMN whatsapp_sessions.current_context IS
  'Stores mode-specific state. For flashcard_review: {queue, cursor, ghost_session_id, cards_reviewed, ratings}. For linking: {code, expires_at}.';


-- ═══════════════════════════════════════════════════════════════
-- 3. whatsapp_message_log — Observability + dedup (no RLS)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS whatsapp_message_log (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash      text          NOT NULL,
  user_id         uuid,
  -- D3: Meta's original message ID for deduplication (AUDIT F7)
  wa_message_id   text,
  direction       text          NOT NULL
    CHECK (direction IN ('in', 'out')),
  message_type    text          NOT NULL DEFAULT 'text'
    CHECK (message_type IN ('text', 'voice', 'button', 'image')),
  tool_called     text,
  tool_args       jsonb,
  latency_ms      integer,
  success         boolean       NOT NULL DEFAULT true,
  error_message   text,
  created_at      timestamptz   NOT NULL DEFAULT now()
);

-- No RLS: admin-only observability table (D4)

-- Recent logs (dashboard, debugging)
CREATE INDEX IF NOT EXISTS idx_wa_log_created
  ON whatsapp_message_log (created_at DESC);

-- Per-user history (analytics)
CREATE INDEX IF NOT EXISTS idx_wa_log_phone
  ON whatsapp_message_log (phone_hash, created_at DESC);

-- Dedup by Meta message ID (AUDIT F7: works for linked AND unlinked users)
CREATE INDEX IF NOT EXISTS idx_wa_log_msg_id
  ON whatsapp_message_log (wa_message_id)
  WHERE wa_message_id IS NOT NULL;

COMMENT ON TABLE whatsapp_message_log IS
  'Audit trail for all WhatsApp messages (in/out). Used for dedup (wa_message_id), analytics (tool usage, latency), and debugging. Retained 30 days via pg_cron.';

COMMENT ON COLUMN whatsapp_message_log.wa_message_id IS
  'Meta WhatsApp Cloud API message ID (e.g., wamid.xxx). Used for deduplication in webhook handler. Indexed with partial index (WHERE NOT NULL) for fast lookups.';


-- ═══════════════════════════════════════════════════════════════
-- 4. pgmq queue — Async job processing (with fallback)
-- ═══════════════════════════════════════════════════════════════

-- Attempt to enable pgmq. If not available, the DO block handles it.
DO $$ 
BEGIN
  -- Check if pgmq is available
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgmq') THEN
    CREATE EXTENSION IF NOT EXISTS pgmq;
    PERFORM pgmq.create('whatsapp_jobs');
    RAISE NOTICE 'pgmq extension enabled, queue whatsapp_jobs created.';
  ELSE
    RAISE NOTICE 'pgmq not available. Creating fallback whatsapp_jobs table.';
    -- Fallback: simple job queue table with polling
    CREATE TABLE IF NOT EXISTS whatsapp_jobs (
      id            bigserial     PRIMARY KEY,
      payload       jsonb         NOT NULL,
      status        text          NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'done', 'failed')),
      attempts      integer       NOT NULL DEFAULT 0,
      max_attempts  integer       NOT NULL DEFAULT 3,
      error_message text,
      created_at    timestamptz   NOT NULL DEFAULT now(),
      processed_at  timestamptz
    );
    CREATE INDEX IF NOT EXISTS idx_wa_jobs_pending
      ON whatsapp_jobs (created_at ASC)
      WHERE status = 'pending';
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════
-- 5. pg_cron jobs — Automated cleanup
-- ═══════════════════════════════════════════════════════════════

-- Session cleanup: every hour, remove expired sessions
-- (sessions have 30min TTL, extended to 4h during flashcard_review)
SELECT cron.schedule(
  'wa-session-cleanup',
  '0 * * * *',
  $$DELETE FROM whatsapp_sessions WHERE expires_at < now()$$
);

-- Log retention: daily at 03:00 UTC, remove logs older than 30 days
SELECT cron.schedule(
  'wa-log-retention',
  '0 3 * * *',
  $$DELETE FROM whatsapp_message_log WHERE created_at < now() - interval '30 days'$$
);

-- ── Verification queries (run manually after migration) ──────
-- \dt whatsapp_*
-- SELECT * FROM pgmq.list_queues();  -- or: SELECT * FROM whatsapp_jobs LIMIT 0;
-- SELECT jobname, schedule, command FROM cron.job WHERE jobname LIKE 'wa-%';
-- SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
