/**
 * lib/finals-detector.ts — Finals period detection helper
 *
 * Checks whether a given date falls within a configured finals period
 * for a specific institution (or course within the institution).
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";

/**
 * Check if a date falls within any finals period for an institution.
 * Course-specific periods and institution-wide (course_id IS NULL) both count.
 */
export async function isInFinalsPeriod(
  db: SupabaseClient,
  institutionId: string,
  date: Date = new Date(),
): Promise<boolean> {
  const dateStr = date.toISOString().split("T")[0];
  const { data } = await db
    .from("finals_periods")
    .select("id")
    .eq("institution_id", institutionId)
    .lte("finals_period_start", dateStr)
    .gte("finals_period_end", dateStr)
    .limit(1);
  return (data?.length ?? 0) > 0;
}
