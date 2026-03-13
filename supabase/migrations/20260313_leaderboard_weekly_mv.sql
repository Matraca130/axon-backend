-- Leaderboard weekly materialized view
-- Joins student_xp with profiles for display-ready leaderboard data.
-- Refreshed hourly by cron/refresh-leaderboard.ts

CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard_weekly AS
SELECT
  sx.student_id,
  sx.institution_id,
  sx.xp_this_week,
  sx.total_xp,
  sx.current_level,
  p.full_name,
  p.avatar_url,
  ss.current_streak
FROM student_xp sx
LEFT JOIN profiles p ON p.id = sx.student_id
LEFT JOIN student_stats ss ON ss.student_id = sx.student_id
WHERE sx.xp_this_week > 0
ORDER BY sx.xp_this_week DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_weekly_pk
  ON leaderboard_weekly (student_id, institution_id);

-- RPC function to refresh the MV (called by cron)
CREATE OR REPLACE FUNCTION refresh_leaderboard_weekly()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_weekly;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
