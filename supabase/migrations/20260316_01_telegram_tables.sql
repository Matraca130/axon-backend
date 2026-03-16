-- ============================================================================
-- Migration: Telegram Integration Tables
-- Date: 2026-03-16
-- Purpose: Schema foundation for the Telegram bot system.
--          Mirrors WhatsApp tables design with Telegram-specific adaptations.
--
-- Design decisions:
--   D1: telegram_links stores chat_id (Telegram's unique identifier, integer).
--       Unlike WhatsApp, Telegram provides a stable chat_id — no phone hashing needed.
--   D2: telegram_sessions mirrors whatsapp_sessions for conversation state.
--   D3: telegram_message_log for observability and analytics.
--   D4: No RLS on sessions/logs — accessed via getAdminClient() (no JWT context).
--       telegram_links HAS RLS (users manage their own link via web UI).
--   D5: Reuses whatsapp_jobs table for async job processing (shared queue).
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════
-- 1. telegram_links — Telegram chat-to-user linking
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS telegram_links (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid          NOT NULL UNIQUE
                              REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id       bigint        NOT NULL UNIQUE,
  username      text,
  linked_at     timestamptz   NOT NULL DEFAULT now(),
  is_active     boolean       NOT NULL DEFAULT true
);

-- RLS: Users can only see/update their own link
ALTER TABLE telegram_links ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'telegram_links' AND policyname = 'telegram_links_own_row'
  ) THEN
    CREATE POLICY telegram_links_own_row ON telegram_links
      FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_telegram_links_chat_id
  ON telegram_links (chat_id);

COMMENT ON TABLE telegram_links IS
  'Maps Axon users to Telegram chat IDs. One link per user (UNIQUE user_id). RLS enabled.';


-- ═══════════════════════════════════════════════════════════════
-- 2. telegram_sessions — Conversation state (no RLS, admin-only)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id         bigint        PRIMARY KEY,
  user_id         uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  history         jsonb         NOT NULL DEFAULT '[]'::jsonb,
  current_tool    text,
  current_context jsonb         NOT NULL DEFAULT '{}'::jsonb,
  mode            text          NOT NULL DEFAULT 'conversation'
    CHECK (mode IN ('conversation', 'flashcard_review', 'linking')),
  last_message_id text,
  version         integer       NOT NULL DEFAULT 0,
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  expires_at      timestamptz   NOT NULL DEFAULT (now() + interval '30 minutes')
);

CREATE OR REPLACE FUNCTION update_telegram_sessions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_telegram_sessions_updated_at ON telegram_sessions;
CREATE TRIGGER trg_telegram_sessions_updated_at
  BEFORE UPDATE ON telegram_sessions
  FOR EACH ROW EXECUTE FUNCTION update_telegram_sessions_updated_at();

COMMENT ON TABLE telegram_sessions IS
  'Active Telegram conversation state. Keyed by chat_id. No RLS — accessed via getAdminClient(). TTL 30min, extended during flashcard_review.';


-- ═══════════════════════════════════════════════════════════════
-- 3. telegram_message_log — Observability + analytics (no RLS)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS telegram_message_log (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id         bigint        NOT NULL,
  user_id         uuid,
  tg_message_id   bigint,
  direction       text          NOT NULL
    CHECK (direction IN ('in', 'out')),
  message_type    text          NOT NULL DEFAULT 'text'
    CHECK (message_type IN ('text', 'voice', 'callback', 'command')),
  tool_called     text,
  tool_args       jsonb,
  latency_ms      integer,
  success         boolean       NOT NULL DEFAULT true,
  error_message   text,
  created_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tg_log_created
  ON telegram_message_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tg_log_chat
  ON telegram_message_log (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tg_log_msg_id
  ON telegram_message_log (tg_message_id)
  WHERE tg_message_id IS NOT NULL;

COMMENT ON TABLE telegram_message_log IS
  'Audit trail for all Telegram messages (in/out). Used for analytics, debugging. Retained 30 days via pg_cron.';


-- ═══════════════════════════════════════════════════════════════
-- 4. Admin settings table for messaging integrations
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS messaging_admin_settings (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id  uuid          NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  channel         text          NOT NULL CHECK (channel IN ('whatsapp', 'telegram')),
  settings        jsonb         NOT NULL DEFAULT '{}'::jsonb,
  is_enabled      boolean       NOT NULL DEFAULT false,
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  updated_by      uuid          REFERENCES auth.users(id),
  UNIQUE(institution_id, channel)
);

ALTER TABLE messaging_admin_settings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE messaging_admin_settings IS
  'Per-institution messaging channel settings. Stores API tokens/config as JSON. Admin-managed via web UI.';

COMMENT ON COLUMN messaging_admin_settings.settings IS
  'Channel-specific config. WhatsApp: {phone_number_id, access_token, app_secret, verify_token}. Telegram: {bot_token, bot_username}. Tokens should be set via admin UI.';


-- ═══════════════════════════════════════════════════════════════
-- 5. pg_cron jobs — Cleanup
-- ═══════════════════════════════════════════════════════════════

SELECT cron.schedule(
  'tg-session-cleanup',
  '0 * * * *',
  $$DELETE FROM telegram_sessions WHERE expires_at < now()$$
);

SELECT cron.schedule(
  'tg-log-retention',
  '0 3 * * *',
  $$DELETE FROM telegram_message_log WHERE created_at < now() - interval '30 days'$$
);
