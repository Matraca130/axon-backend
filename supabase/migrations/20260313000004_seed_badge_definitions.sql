-- ============================================
-- Sprint 1, Step s1-seed-badges
-- Seed badge_definitions (20 badges globales)
-- institution_id = NULL = disponible para TODAS las instituciones
-- trigger_config JSONB define condicion SQL para auto-evaluation
-- ============================================

INSERT INTO badge_definitions (name, description, icon, category, rarity, xp_reward, trigger_type, trigger_config)
VALUES
  -- ═══════════════════════════════════════════
  -- CONSISTENCY (streaks, habits)
  -- ═══════════════════════════════════════════
  ('Primer Paso', 'Completa tu primera sesion de estudio', 'Footprints', 'consistency', 'common', 50, 'auto',
   '{"table":"study_sessions","condition":"COUNT(*) >= 1","filter":"completed_at IS NOT NULL"}'),

  ('Estudiante Dedicado', '3 dias consecutivos de estudio', 'CalendarCheck', 'consistency', 'common', 100, 'auto',
   '{"table":"student_stats","condition":"current_streak >= 3"}'),

  ('Semana de Fuego', '7 dias consecutivos de estudio', 'Flame', 'consistency', 'rare', 200, 'auto',
   '{"table":"student_stats","condition":"longest_streak >= 7"}'),

  ('Mes Imparable', '30 dias consecutivos de estudio', 'Zap', 'consistency', 'epic', 1000, 'auto',
   '{"table":"student_stats","condition":"longest_streak >= 30"}'),

  ('Centurion del Conocimiento', '100 dias sin fallar', 'Crown', 'consistency', 'legendary', 5000, 'auto',
   '{"table":"student_stats","condition":"longest_streak >= 100"}'),

  -- ═══════════════════════════════════════════
  -- STUDY (volume, completion)
  -- ═══════════════════════════════════════════
  ('Primera Revision', 'Completa tu primera revision de flashcard', 'BookOpen', 'study', 'common', 25, 'auto',
   '{"table":"student_stats","condition":"total_reviews >= 1"}'),

  ('Revisor Frecuente', '100 revisiones completadas', 'Repeat', 'study', 'common', 150, 'auto',
   '{"table":"student_stats","condition":"total_reviews >= 100"}'),

  ('Maquina de Repasar', '500 revisiones completadas', 'Cog', 'study', 'rare', 500, 'auto',
   '{"table":"student_stats","condition":"total_reviews >= 500"}'),

  ('Gran Repasador', '1000 revisiones completadas', 'Trophy', 'study', 'epic', 1500, 'auto',
   '{"table":"student_stats","condition":"total_reviews >= 1000"}'),

  ('Maratonista', '5 sesiones de estudio completadas', 'Timer', 'study', 'common', 100, 'auto',
   '{"table":"study_sessions","condition":"COUNT(*) >= 5","filter":"completed_at IS NOT NULL"}'),

  ('Explorador de Contenido', '10 sesiones completadas', 'Compass', 'study', 'rare', 300, 'auto',
   '{"table":"study_sessions","condition":"COUNT(*) >= 10","filter":"completed_at IS NOT NULL"}'),

  -- ═══════════════════════════════════════════
  -- MASTERY (BKT p_know based)
  -- ═══════════════════════════════════════════
  ('Primer Dominio', 'p_know > 0.80 en tu primer subtopic', 'Star', 'mastery', 'common', 100, 'auto',
   '{"table":"bkt_states","condition":"COUNT(*) >= 1","filter":"p_know > 0.80"}'),

  ('Maestro Emergente', 'p_know > 0.90 en 5 subtopics', 'Award', 'mastery', 'rare', 500, 'auto',
   '{"table":"bkt_states","condition":"COUNT(*) >= 5","filter":"p_know > 0.90"}'),

  ('Erudito', 'p_know > 0.95 en 10 subtopics', 'GraduationCap', 'mastery', 'epic', 1500, 'auto',
   '{"table":"bkt_states","condition":"COUNT(*) >= 10","filter":"p_know > 0.95"}'),

  ('Dominio Total', 'p_know > 0.95 en 25 subtopics', 'Brain', 'mastery', 'legendary', 2000, 'auto',
   '{"table":"bkt_states","condition":"COUNT(*) >= 25","filter":"p_know > 0.95"}'),

  -- ═══════════════════════════════════════════
  -- EXPLORATION (breadth of content)
  -- ═══════════════════════════════════════════
  ('Curioso', 'Haz tu primera pregunta al asistente RAG', 'MessageCircle', 'exploration', 'common', 50, 'auto',
   '{"table":"ai_conversations","condition":"COUNT(*) >= 1"}'),

  ('Investigador', '10 preguntas al asistente RAG', 'Search', 'exploration', 'rare', 200, 'auto',
   '{"table":"ai_conversations","condition":"COUNT(*) >= 10"}'),

  ('Lector Voraz', 'Lee 10 resumenes completos', 'BookMarked', 'exploration', 'rare', 300, 'auto',
   '{"table":"reading_states","condition":"COUNT(*) >= 10","filter":"completed = true"}'),

  -- ═══════════════════════════════════════════
  -- SOCIAL (community engagement — Phase 2)
  -- ═══════════════════════════════════════════
  ('Socializador', 'Aparece en el top 10 del leaderboard semanal', 'Users', 'social', 'rare', 300, 'auto',
   '{"table":"leaderboard_weekly","condition":"rank <= 10"}'),

  ('Campeon Semanal', '#1 en el leaderboard semanal', 'Medal', 'social', 'legendary', 1000, 'auto',
   '{"table":"leaderboard_weekly","condition":"rank = 1"}');

-- ============================================
-- Verificacion: Debe retornar 20 filas
-- ============================================
-- SELECT COUNT(*) as total_badges,
--   COUNT(*) FILTER (WHERE category = 'consistency') as consistency,
--   COUNT(*) FILTER (WHERE category = 'study') as study,
--   COUNT(*) FILTER (WHERE category = 'mastery') as mastery,
--   COUNT(*) FILTER (WHERE category = 'exploration') as exploration,
--   COUNT(*) FILTER (WHERE category = 'social') as social
-- FROM badge_definitions
-- WHERE institution_id IS NULL;
