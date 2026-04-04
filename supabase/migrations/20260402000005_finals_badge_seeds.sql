-- ============================================================================
-- Migration: Seed 3 finals effort badges
-- Date: 2026-04-02
-- Purpose: Badge definitions for finals-period effort recognition.
--
-- These badges use custom evaluation logic in finals-badge-hooks.ts,
-- NOT the standard trigger_config COUNT pattern. trigger_type = 'custom'
-- prevents the generic check-badges flow from evaluating them.
-- ============================================================================

INSERT INTO badge_definitions
  (slug, name, description, icon, category, rarity, xp_reward, trigger_type, trigger_config, criteria, is_active)
VALUES
  ('sobreviviente_de_finales', 'Sobreviviente de Finales',
   'Crea 3 o mas planes de estudio durante el periodo de finales',
   'Shield', 'consistency', 'rare', 150, 'custom',
   '{}', 'finals_plans_count >= 3', true),

  ('maraton_de_estudio', 'Maraton de Estudio',
   '4 o mas horas de estudio en un dia durante el periodo de finales',
   'Timer', 'study', 'epic', 200, 'custom',
   '{}', 'finals_day_study_seconds >= 14400', true),

  ('cero_panico', 'Cero Panico',
   'Crea un plan de estudio 15 o mas dias antes de tu examen',
   'Calendar', 'consistency', 'rare', 100, 'custom',
   '{}', 'days_before_exam >= 15', true)
ON CONFLICT (slug) DO NOTHING;
