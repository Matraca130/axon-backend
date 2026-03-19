-- RLS for newly created tables (Telegram + webhook events)

ALTER TABLE telegram_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tg_sessions_service_role_only" ON telegram_sessions
  FOR ALL USING (auth.role() = 'service_role');

ALTER TABLE telegram_message_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tg_log_service_role_only" ON telegram_message_log
  FOR ALL USING (auth.role() = 'service_role');

-- telegram_links + messaging_admin_settings already have RLS from 20260316_01

ALTER TABLE processed_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pwe_service_role_only" ON processed_webhook_events
  FOR ALL USING (auth.role() = 'service_role');
