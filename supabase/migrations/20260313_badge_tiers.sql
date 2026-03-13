-- Achievement tiers for badge_definitions
-- Supports bronze/silver/gold/platinum progression within achievement groups.

ALTER TABLE badge_definitions
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS achievement_group TEXT;

CREATE INDEX IF NOT EXISTS idx_badge_defs_group
  ON badge_definitions (achievement_group)
  WHERE achievement_group IS NOT NULL;

-- Seed: 20 tiered badge definitions across 5 achievement groups
-- Each group has 4 tiers: bronze, silver, gold, platinum

-- === XP Collector ===
INSERT INTO badge_definitions (name, slug, description, category, criteria, xp_reward, icon_url, rarity, tier, achievement_group, is_active)
VALUES
  ('Recolector Novato', 'xp_collector_bronze', 'Gana 100 XP en total', 'xp', 'total_xp >= 100', 10, NULL, 'common', 'bronze', 'xp_collector', true),
  ('Recolector Experto', 'xp_collector_silver', 'Gana 500 XP en total', 'xp', 'total_xp >= 500', 25, NULL, 'uncommon', 'silver', 'xp_collector', true),
  ('Recolector Maestro', 'xp_collector_gold', 'Gana 2000 XP en total', 'xp', 'total_xp >= 2000', 50, NULL, 'rare', 'gold', 'xp_collector', true),
  ('Recolector Legendario', 'xp_collector_platinum', 'Gana 10000 XP en total', 'xp', 'total_xp >= 10000', 100, NULL, 'legendary', 'platinum', 'xp_collector', true)
ON CONFLICT (slug) DO NOTHING;

-- === Streak Master ===
INSERT INTO badge_definitions (name, slug, description, category, criteria, xp_reward, icon_url, rarity, tier, achievement_group, is_active)
VALUES
  ('Constante', 'streak_master_bronze', 'Manten una racha de 3 dias', 'streak', 'current_streak >= 3', 15, NULL, 'common', 'bronze', 'streak_master', true),
  ('Dedicado', 'streak_master_silver', 'Manten una racha de 7 dias', 'streak', 'current_streak >= 7', 30, NULL, 'uncommon', 'silver', 'streak_master', true),
  ('Imparable', 'streak_master_gold', 'Manten una racha de 14 dias', 'streak', 'current_streak >= 14', 60, NULL, 'rare', 'gold', 'streak_master', true),
  ('Leyenda de la Racha', 'streak_master_platinum', 'Manten una racha de 30 dias', 'streak', 'current_streak >= 30', 150, NULL, 'legendary', 'platinum', 'streak_master', true)
ON CONFLICT (slug) DO NOTHING;

-- === Reviewer ===
INSERT INTO badge_definitions (name, slug, description, category, criteria, xp_reward, icon_url, rarity, tier, achievement_group, is_active)
VALUES
  ('Revisor Inicial', 'reviewer_bronze', 'Completa 50 revisiones', 'mastery', 'total_reviews >= 50', 10, NULL, 'common', 'bronze', 'reviewer', true),
  ('Revisor Frecuente', 'reviewer_silver', 'Completa 200 revisiones', 'mastery', 'total_reviews >= 200', 25, NULL, 'uncommon', 'silver', 'reviewer', true),
  ('Revisor Experto', 'reviewer_gold', 'Completa 500 revisiones', 'mastery', 'total_reviews >= 500', 50, NULL, 'rare', 'gold', 'reviewer', true),
  ('Revisor Legendario', 'reviewer_platinum', 'Completa 2000 revisiones', 'mastery', 'total_reviews >= 2000', 100, NULL, 'legendary', 'platinum', 'reviewer', true)
ON CONFLICT (slug) DO NOTHING;

-- === Scholar (sessions) ===
INSERT INTO badge_definitions (name, slug, description, category, criteria, xp_reward, icon_url, rarity, tier, achievement_group, is_active)
VALUES
  ('Estudiante Curioso', 'scholar_bronze', 'Completa 10 sesiones de estudio', 'progress', 'total_sessions >= 10', 10, NULL, 'common', 'bronze', 'scholar', true),
  ('Estudiante Aplicado', 'scholar_silver', 'Completa 50 sesiones de estudio', 'progress', 'total_sessions >= 50', 25, NULL, 'uncommon', 'silver', 'scholar', true),
  ('Estudiante Avanzado', 'scholar_gold', 'Completa 100 sesiones de estudio', 'progress', 'total_sessions >= 100', 50, NULL, 'rare', 'gold', 'scholar', true),
  ('Estudiante Legendario', 'scholar_platinum', 'Completa 500 sesiones de estudio', 'progress', 'total_sessions >= 500', 100, NULL, 'legendary', 'platinum', 'scholar', true)
ON CONFLICT (slug) DO NOTHING;

-- === Challenge Hunter ===
INSERT INTO badge_definitions (name, slug, description, category, criteria, xp_reward, icon_url, rarity, tier, achievement_group, is_active)
VALUES
  ('Cazador Novato', 'challenge_hunter_bronze', 'Completa 5 desafios', 'challenge', 'challenges_completed >= 5', 15, NULL, 'common', 'bronze', 'challenge_hunter', true),
  ('Cazador Experimentado', 'challenge_hunter_silver', 'Completa 20 desafios', 'challenge', 'challenges_completed >= 20', 30, NULL, 'uncommon', 'silver', 'challenge_hunter', true),
  ('Cazador Experto', 'challenge_hunter_gold', 'Completa 50 desafios', 'challenge', 'challenges_completed >= 50', 60, NULL, 'rare', 'gold', 'challenge_hunter', true),
  ('Cazador Legendario', 'challenge_hunter_platinum', 'Completa 100 desafios', 'challenge', 'challenges_completed >= 100', 150, NULL, 'legendary', 'platinum', 'challenge_hunter', true)
ON CONFLICT (slug) DO NOTHING;
