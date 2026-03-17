/**
 * cron/refresh-leaderboard.ts -- Refresh leaderboard materialized view
 *
 * Refreshes the leaderboard_weekly materialized view hourly.
 * The MV joins student_xp with profiles for display names.
 *
 * Schedule: 0 * * * * (every hour)
 * Deploy: supabase functions deploy refresh-leaderboard --schedule "0 * * * *"
 */

import { createClient } from "npm:@supabase/supabase-js";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async (req: Request) => {
  // Verify the request carries a valid Authorization header (cron sends service_role key)
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ ok: false, error: "Missing Authorization header" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const start = Date.now();
  const adminDb = createClient(supabaseUrl, supabaseServiceKey);

  console.log(`[Leaderboard] Refreshing MV at ${new Date().toISOString()}`);

  try {
    const { error } = await adminDb.rpc("refresh_leaderboard_weekly");

    if (error) {
      console.error("[Leaderboard] Refresh failed:", error.message);
      return new Response(
        JSON.stringify({ ok: false, error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const elapsed = Date.now() - start;
    console.log(`[Leaderboard] Refreshed in ${elapsed}ms`);

    return new Response(
      JSON.stringify({ ok: true, elapsed_ms: elapsed }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[Leaderboard] Exception:", (e as Error).message);
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
