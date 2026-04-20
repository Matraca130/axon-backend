/**
 * 04-post-change-validation.ts — Post-Commit 3 validation (audit section 3.5)
 *
 * Run AFTER the 3 implementation commits are deployed to staging.
 * Verifies:
 *   1. Re-baseline: same TEST_SUMMARY_ID, same env, same RUNS=5.
 *      Compute speedup vs baseline (script 01 output).
 *   2. SQL check: chunks.embedding IS NULL count = 0 for the test summary.
 *   3. summary_block_embeddings has no duplicates per block_id.
 *
 * Usage:
 *   export TEST_SUMMARY_ID=<same as 01>
 *   export AXON_API_BASE_URL=...
 *   export AXON_AUTH_TOKEN=...
 *   export SUPABASE_URL=...
 *   export SUPABASE_SERVICE_ROLE_KEY=...
 *   export SUPABASE_ANON_KEY=...
 *   export BASELINE_P50_MS=<from 01-baseline-publish output>
 *   deno run --allow-env --allow-net --allow-write \
 *     scripts/diagnostics/pr298/04-post-change-validation.ts
 */

import { createClient } from "npm:@supabase/supabase-js";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";

const SUMMARY_ID = Deno.env.get("TEST_SUMMARY_ID");
const API_BASE = Deno.env.get("AXON_API_BASE_URL");
const TOKEN = Deno.env.get("AXON_AUTH_TOKEN");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const BASELINE_P50 = Number(Deno.env.get("BASELINE_P50_MS") ?? "0");

if (
  !SUMMARY_ID || !API_BASE || !TOKEN || !ANON_KEY || !SUPABASE_URL ||
  !SERVICE_KEY
) {
  console.error("Missing env vars. See script header.");
  Deno.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RUNS = 5;

interface RunResult {
  run: number;
  http_elapsed_ms: number;
  status: number;
  body: Record<string, unknown> | null;
}

async function singleRun(runIdx: number): Promise<RunResult> {
  const start = performance.now();
  const res = await fetch(`${API_BASE}/summaries/${SUMMARY_ID}/publish`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ANON_KEY}`,
      "X-Access-Token": TOKEN,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const elapsed = performance.now() - start;
  let body: Record<string, unknown> | null = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return {
    run: runIdx,
    http_elapsed_ms: Math.round(elapsed),
    status: res.status,
    body,
  };
}

function p(arr: number[], pct: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor((pct / 100) * (sorted.length - 1))];
}

async function main() {
  console.log("Post-change validation\n");

  // ── Phase 1: Re-baseline ────────────────────────────────────────────────
  console.log("Re-running publish 5 times...");
  const results: RunResult[] = [];
  // 1 warmup
  await singleRun(-1);
  for (let i = 0; i < RUNS; i++) {
    const r = await singleRun(i + 1);
    results.push(r);
    console.log(`  run ${i + 1}: ${r.http_elapsed_ms}ms (status ${r.status})`);
    await new Promise((res) => setTimeout(res, 1500));
  }

  const successes = results.filter((r) => r.status === 200);
  const times = successes.map((r) => r.http_elapsed_ms);
  const newP50 = p(times, 50);
  const newP95 = p(times, 95);
  const newMean = times.length > 0
    ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    : 0;

  // ── Phase 2: chunks.embedding IS NULL check ─────────────────────────────
  console.log("\nQuerying chunks for null embeddings...");
  const { data: nullChunks, count: nullCount } = await db
    .from("chunks")
    .select("id", { count: "exact", head: false })
    .eq("summary_id", SUMMARY_ID)
    .is("embedding", null);

  const { count: totalChunks } = await db
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("summary_id", SUMMARY_ID);

  console.log(`  chunks total: ${totalChunks}`);
  console.log(`  chunks with NULL embedding: ${nullCount} (must be 0)`);

  // ── Phase 3: summary_block_embeddings duplicate check ────────────────────
  console.log("\nChecking summary_block_embeddings for duplicates...");
  const { data: blocks } = await db
    .from("summary_blocks")
    .select("id")
    .eq("summary_id", SUMMARY_ID)
    .eq("is_active", true);
  const blockIds = (blocks ?? []).map((b) => b.id as string);

  const { data: embRows } = await db
    .from("summary_block_embeddings")
    .select("block_id")
    .in("block_id", blockIds);

  const seen = new Map<string, number>();
  for (const r of embRows ?? []) {
    const id = r.block_id as string;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const duplicates = Array.from(seen.entries()).filter(([_, n]) => n > 1);

  console.log(`  block_embeddings rows: ${embRows?.length ?? 0}`);
  console.log(`  blocks with duplicates: ${duplicates.length} (must be 0)`);

  // ── Verdict ──────────────────────────────────────────────────────────────
  const speedup = BASELINE_P50 > 0 ? (BASELINE_P50 / newP50).toFixed(2) : "n/a";
  const acceptanceTarget = Math.round(BASELINE_P50 * 0.4);
  const meetsTarget = BASELINE_P50 > 0 && newP50 <= acceptanceTarget;

  console.log("\n" + "=".repeat(70));
  console.log("POST-CHANGE VALIDATION:");
  console.log(`  Baseline p50:   ${BASELINE_P50}ms`);
  console.log(`  New p50:        ${newP50}ms`);
  console.log(`  New p95:        ${newP95}ms`);
  console.log(`  Speedup:        ${speedup}x`);
  console.log(`  Target p50:     ${acceptanceTarget}ms (40% of baseline)`);
  console.log(`  Meets target:   ${meetsTarget ? "✅ YES" : "❌ NO"}`);
  console.log(`  NULL embeddings: ${nullCount === 0 ? "✅ 0" : "❌ " + nullCount}`);
  console.log(`  Duplicates:      ${duplicates.length === 0 ? "✅ 0" : "❌ " + duplicates.length}`);

  const allPass = meetsTarget && nullCount === 0 && duplicates.length === 0;
  console.log(`\n  Overall: ${allPass ? "✅ PASS — ship it" : "❌ INVESTIGATE"}`);

  await ensureDir("./out");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `./out/04-post-change-validation-${ts}.json`;
  await Deno.writeTextFile(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        summary_id: SUMMARY_ID,
        baseline_p50_ms: BASELINE_P50,
        new_p50_ms: newP50,
        new_p95_ms: newP95,
        new_mean_ms: newMean,
        speedup,
        acceptance_target_ms: acceptanceTarget,
        meets_target: meetsTarget,
        chunks_total: totalChunks,
        chunks_null_embedding: nullCount,
        block_embeddings_total: embRows?.length ?? 0,
        block_duplicates: duplicates.length,
        runs: results,
        verdict: allPass ? "PASS" : "INVESTIGATE",
      },
      null,
      2,
    ),
  );
  console.log(`\nWritten: ${outPath}`);

  if (!allPass) Deno.exit(2);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  Deno.exit(1);
});
