/**
 * cron/reset-xp-counters.ts -- XP + stat daily/weekly reset
 *
 * Schedule: 0 0 * * * (midnight UTC)
 * Deploy: supabase functions deploy reset-xp-counters --schedule "0 0 * * *"
 *
 * Resets:
 *   - student_xp.xp_today (daily)
 *   - student_xp.xp_this_week (Monday only)
 *   - student_stats.reviews_today (daily, PR #108)
 *   - student_stats.sessions_today (daily, PR #108)
 */

import { createClient } from "npm:@supabase/supabase-js";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async () => {
  const start = Date.now();
  const adminDb = createClient(supabaseUrl, supabaseServiceKey);
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sunday, 1=Monday

  console.log(`[XP Reset] Running at ${now.toISOString()} (day=${dayOfWeek})`);

  // --- Always: Reset xp_today ---
  const { error: dailyErr, count: dailyCount } = await adminDb
    .from("student_xp")
    .update({ xp_today: 0 })
    .gt("xp_today", 0)
    .select("id", { count: "exact", head: true });

  if (dailyErr) {
    console.error("[XP Reset] Daily xp reset failed:", dailyErr.message);
  } else {
    console.log(`[XP Reset] Daily: reset xp_today for ${dailyCount ?? 0} students`);
  }

  // --- Always: Reset daily stat counters (PR #108) ---
  const { error: statErr, count: statCount } = await adminDb
    .from("student_stats")
    .update({ reviews_today: 0, sessions_today: 0 })
    .or("reviews_today.gt.0,sessions_today.gt.0")
    .select("student_id", { count: "exact", head: true });

  if (statErr) {
    console.error("[XP Reset] Daily stat counters reset failed:", statErr.message);
  } else {
    console.log(`[XP Reset] Daily: reset stat counters for ${statCount ?? 0} students`);
  }

  // Note: correct_streak is NOT reset daily -- it persists across days
  // and only resets on incorrect answers (handled by stat-counters.ts)

  // --- Monday only: Reset xp_this_week ---
  let weeklyCount = 0;
  if (dayOfWeek === 1) {
    const { error: weeklyErr, count } = await adminDb
      .from("student_xp")
      .update({ xp_this_week: 0 })
      .gt("xp_this_week", 0)
      .select("id", { count: "exact", head: true });

    if (weeklyErr) {
      console.error("[XP Reset] Weekly reset failed:", weeklyErr.message);
    } else {
      weeklyCount = count ?? 0;
      console.log(`[XP Reset] Weekly: reset xp_this_week for ${weeklyCount} students`);
    }
  }

  const elapsed = Date.now() - start;
  console.log(`[XP Reset] Done in ${elapsed}ms`);

  return new Response(
    JSON.stringify({
      ok: true,
      daily_xp_reset: dailyCount ?? 0,
      daily_stat_reset: statCount ?? 0,
      weekly_reset: dayOfWeek === 1 ? weeklyCount : "skipped",
      elapsed_ms: elapsed,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
