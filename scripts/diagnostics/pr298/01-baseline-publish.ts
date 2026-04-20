/**
 * 01-baseline-publish.ts — Measure current publish + auto-ingest performance.
 *
 * Audit reference: section 3.1 — H1 baseline measurement (BLOCKING).
 *
 * Method:
 *   1. Re-publish the test summary 5 times (warmup + 5 runs).
 *   2. For each run, capture:
 *      - Total HTTP elapsed_ms (POST /summaries/:id/publish round-trip).
 *      - Backend [Auto-Ingest] Done elapsed_ms (from log scrape if avail, else infer).
 *      - chunks_count + blocks_embedded counts from response.
 *   3. Report p50, p95, mean.
 *
 * Why re-publish is safe:
 *   The publish endpoint is idempotent in this codebase: it re-runs flatten
 *   → update content_markdown → autoChunkAndEmbed → per-block embeddings.
 *   The hash check in autoChunkAndEmbed will short-circuit chunk regeneration
 *   if content didn't change between runs, which actually IS what we want for
 *   baseline (want to measure the consistent-content path the optimization
 *   targets). For the FIRST run, force a re-chunk by toggling something trivial.
 *
 * Usage:
 *   export TEST_SUMMARY_ID=<from script 00>
 *   export AXON_API_BASE_URL=https://staging.axonmed.app  # adjust
 *   export AXON_AUTH_TOKEN=<a professor JWT for the institution>
 *   deno run --allow-env --allow-net --allow-write \
 *     scripts/diagnostics/pr298/01-baseline-publish.ts
 */

import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";

const SUMMARY_ID = Deno.env.get("TEST_SUMMARY_ID");
const API_BASE = Deno.env.get("AXON_API_BASE_URL");
const TOKEN = Deno.env.get("AXON_AUTH_TOKEN");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

if (!SUMMARY_ID || !API_BASE || !TOKEN || !ANON_KEY) {
  console.error("Missing env vars. Required:");
  console.error("  TEST_SUMMARY_ID (from 00-find-test-summary.ts)");
  console.error("  AXON_API_BASE_URL (e.g. https://staging.axonmed.app)");
  console.error("  AXON_AUTH_TOKEN (professor JWT for the institution)");
  console.error("  SUPABASE_ANON_KEY (Bearer key — Axon dual-token auth)");
  Deno.exit(1);
}

const RUNS = 5;
const WARMUP = 1;

interface RunResult {
  run: number;
  http_elapsed_ms: number;
  status: number;
  body: Record<string, unknown> | null;
  error: string | null;
}

async function singleRun(runIdx: number): Promise<RunResult> {
  const start = performance.now();
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/summaries/${SUMMARY_ID}/publish`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${ANON_KEY}`,
          "X-Access-Token": TOKEN,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
  } catch (e) {
    return {
      run: runIdx,
      http_elapsed_ms: performance.now() - start,
      status: 0,
      body: null,
      error: (e as Error).message,
    };
  }
  const elapsed = performance.now() - start;
  let body: Record<string, unknown> | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {
    run: runIdx,
    http_elapsed_ms: Math.round(elapsed),
    status: res.status,
    body,
    error: res.ok ? null : `HTTP ${res.status}`,
  };
}

function p(arr: number[], pct: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((pct / 100) * (sorted.length - 1));
  return sorted[idx];
}

async function main() {
  console.log(`Baseline measurement: ${SUMMARY_ID}`);
  console.log(`Runs: ${WARMUP} warmup + ${RUNS} measured\n`);

  const results: RunResult[] = [];

  console.log("Warmup runs (not counted)...");
  for (let i = 0; i < WARMUP; i++) {
    const r = await singleRun(-1);
    console.log(`  warmup ${i + 1}: ${r.http_elapsed_ms}ms (status ${r.status})`);
  }

  console.log("\nMeasured runs:");
  for (let i = 0; i < RUNS; i++) {
    const r = await singleRun(i + 1);
    results.push(r);
    const bodyStr = r.body
      ? JSON.stringify(
          { chunks: r.body.chunks_count, blocks: r.body.blocks_embedded },
        )
      : r.error;
    console.log(`  run ${i + 1}: ${r.http_elapsed_ms}ms ${bodyStr}`);
    // Small pause to avoid hammering
    await new Promise((res) => setTimeout(res, 1500));
  }

  const successes = results.filter((r) => r.status === 200);
  const times = successes.map((r) => r.http_elapsed_ms);
  const p50 = p(times, 50);
  const p95 = p(times, 95);
  const mean = times.length > 0
    ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    : 0;

  console.log("\n" + "=".repeat(70));
  console.log("BASELINE RESULTS:");
  console.log(`  Successful runs: ${successes.length}/${RUNS}`);
  console.log(`  p50 elapsed_ms:  ${p50}`);
  console.log(`  p95 elapsed_ms:  ${p95}`);
  console.log(`  mean elapsed_ms: ${mean}`);
  console.log("\n  Acceptance criteria for post-change re-measurement:");
  console.log(`    p50 publish ≤ ${Math.round(p50 * 0.4)} ms (40% of baseline = 60% reduction)`);

  await ensureDir("./out");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `./out/01-baseline-publish-${ts}.json`;
  await Deno.writeTextFile(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        summary_id: SUMMARY_ID,
        api_base: API_BASE,
        runs: results,
        stats: { p50, p95, mean, success_count: successes.length, total_runs: RUNS },
        acceptance_target_p50_ms: Math.round(p50 * 0.4),
      },
      null,
      2,
    ),
  );
  console.log(`\nWritten: ${outPath}`);

  if (successes.length === 0) {
    console.error("\n❌ All runs failed. Cannot proceed.");
    Deno.exit(2);
  }
  if (successes.length < RUNS) {
    console.warn(
      `\n⚠ Only ${successes.length}/${RUNS} runs succeeded. Stats may be noisy.`,
    );
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  Deno.exit(1);
});
