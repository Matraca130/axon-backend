/**
 * cron/reset-xp-counters.ts -- XP daily/weekly reset
 *
 * Deployed as a separate Supabase Edge Function with cron schedule.
 * Resets xp_today at midnight UTC daily, xp_this_week on Monday midnight UTC.
 *
 * Schedule: 0 0 * * * (midnight UTC)
 * Deploy: supabase functions deploy reset-xp-counters --schedule "0 0 * * *"
 */

import { createClient } from "npm:@supabase/supabase-js";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const start = Date.now();
  const adminDb = createClient(supabaseUrl, supabaseServiceKey);
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sunday, 1=Monday

  console.log(`[XP Reset] Running at ${now.toISOString()} (day=${dayOfWeek})`);

  // Always: Reset xp_today for all students
  const { error: dailyErr, count: dailyCount } = await adminDb
    .from("student_xp")
    .update({ xp_today: 0 })
    .gt("xp_today", 0)
    .select("id", { count: "exact", head: true });

  if (dailyErr) {
    console.error("[XP Reset] Daily reset failed:", dailyErr.message);
  } else {
    console.log(`[XP Reset] Daily: reset xp_today for ${dailyCount ?? 0} students`);
  }

  // Monday only: Reset xp_this_week
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
      daily_reset: dailyCount ?? 0,
      weekly_reset: dayOfWeek === 1 ? weeklyCount : "skipped",
      elapsed_ms: elapsed,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
