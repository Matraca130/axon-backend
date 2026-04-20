/**
 * 00-find-test-summary.ts — Identify a published summary with ≥50 blocks.
 *
 * The audit (section 3.1) requires a test summary with ≥50 blocks AND
 * ≥50 chunks expected, so the speedup is measurable. This script finds
 * candidates and prints them ranked by block count.
 *
 * Usage:
 *   deno run --allow-env --allow-net --allow-write \
 *     scripts/diagnostics/pr298/00-find-test-summary.ts
 *
 * Output:
 *   - stdout: human-readable table of top 5 candidates
 *   - out/00-find-test-summary-<ts>.json: structured data for downstream scripts
 */

import { createClient } from "npm:@supabase/supabase-js";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Missing env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
  );
  Deno.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface Candidate {
  summary_id: string;
  title: string;
  status: string;
  institution_id: string;
  block_count: number;
  chunk_count: number;
  block_types: string[];
}

async function findCandidates(): Promise<Candidate[]> {
  // Pull all summaries with their block counts. Cheaper than per-summary RPC.
  const { data: blockGroups, error: blockErr } = await db
    .from("summary_blocks")
    .select("summary_id")
    .eq("is_active", true);

  if (blockErr) throw blockErr;

  const counts = new Map<string, number>();
  for (const row of blockGroups ?? []) {
    const sid = row.summary_id as string;
    counts.set(sid, (counts.get(sid) ?? 0) + 1);
  }

  const eligible = Array.from(counts.entries())
    .filter(([_, n]) => n >= 50)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (eligible.length === 0) {
    return [];
  }

  const ids = eligible.map(([id]) => id);

  const { data: summaries, error: sumErr } = await db
    .from("summaries")
    .select("id, title, status, institution_id")
    .in("id", ids);

  if (sumErr) throw sumErr;

  const { data: chunks, error: chunkErr } = await db
    .from("chunks")
    .select("summary_id")
    .in("summary_id", ids);

  if (chunkErr) throw chunkErr;

  const chunkCounts = new Map<string, number>();
  for (const row of chunks ?? []) {
    const sid = row.summary_id as string;
    chunkCounts.set(sid, (chunkCounts.get(sid) ?? 0) + 1);
  }

  const { data: blockTypes, error: typesErr } = await db
    .from("summary_blocks")
    .select("summary_id, type")
    .in("summary_id", ids)
    .eq("is_active", true);

  if (typesErr) throw typesErr;

  const typesBySummary = new Map<string, Set<string>>();
  for (const row of blockTypes ?? []) {
    const sid = row.summary_id as string;
    if (!typesBySummary.has(sid)) typesBySummary.set(sid, new Set());
    typesBySummary.get(sid)!.add(row.type as string);
  }

  return eligible.map(([id, blockCount]) => {
    const s = (summaries ?? []).find((x) => x.id === id);
    return {
      summary_id: id,
      title: (s?.title as string) ?? "(unknown)",
      status: (s?.status as string) ?? "(unknown)",
      institution_id: (s?.institution_id as string) ?? "(unknown)",
      block_count: blockCount,
      chunk_count: chunkCounts.get(id) ?? 0,
      block_types: Array.from(typesBySummary.get(id) ?? []),
    };
  });
}

async function main() {
  console.log("Searching for summaries with ≥50 blocks...\n");

  const candidates = await findCandidates();

  if (candidates.length === 0) {
    console.error(
      "❌ No summaries with ≥50 blocks found. Cannot proceed with baseline.",
    );
    console.error(
      "   The audit requires this for measurable speedup. Either create a",
    );
    console.error(
      "   synthetic test summary with bulk blocks, or use a smaller threshold",
    );
    console.error("   (and document the deviation in PR description).");
    Deno.exit(2);
  }

  console.log(
    "Top candidates (ranked by block count, prefer published+mixed-types):\n",
  );
  console.log(
    "  rank | blocks | chunks | status     | types".padEnd(70) + "| summary_id | title",
  );
  console.log("-".repeat(130));
  for (let i = 0; i < Math.min(candidates.length, 5); i++) {
    const c = candidates[i];
    const types = c.block_types.slice(0, 3).join(",") +
      (c.block_types.length > 3 ? `+${c.block_types.length - 3}` : "");
    const line =
      `  ${(i + 1).toString().padStart(4)} | ${c.block_count.toString().padStart(6)} | ` +
      `${c.chunk_count.toString().padStart(6)} | ${c.status.padEnd(10)} | ${types.padEnd(25)}` +
      `| ${c.summary_id} | ${c.title.slice(0, 50)}`;
    console.log(line);
  }

  // Pick the recommended one: highest block count + status='published' + most type diversity
  const recommended = candidates.find((c) =>
    c.status === "published" && c.block_types.length >= 2
  ) ?? candidates[0];

  console.log("\n" + "=".repeat(80));
  console.log(`RECOMMENDED: ${recommended.summary_id}`);
  console.log(`  Title: ${recommended.title}`);
  console.log(`  Blocks: ${recommended.block_count}, Chunks: ${recommended.chunk_count}`);
  console.log(`  Types: ${recommended.block_types.join(", ")}`);
  console.log(`  Status: ${recommended.status}`);
  console.log("\nExport for next scripts:");
  console.log(`  export TEST_SUMMARY_ID=${recommended.summary_id}`);
  console.log(`  export TEST_INSTITUTION_ID=${recommended.institution_id}`);

  await ensureDir("./out");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `./out/00-find-test-summary-${ts}.json`;
  await Deno.writeTextFile(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        recommended,
        candidates,
      },
      null,
      2,
    ),
  );
  console.log(`\nWritten: ${outPath}`);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  Deno.exit(1);
});
