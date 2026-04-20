/**
 * 03-probe-memory-bulk-insert.ts — Empirical memory limit (audit section 3.4)
 *
 * The audit says "MAX_BATCH_INSERT_CHUNKS must be empirical, not a round
 * number". This script measures Deno.memoryUsage() before and after
 * synthetic bulk inserts at sizes 100, 250, 500, 1000, 2000.
 *
 * Method:
 *   1. Create a synthetic summary with a sentinel title for cleanup.
 *   2. For each size N: build N synthetic chunks with 1536-dim float arrays
 *      simulating real embeddings (~12KB per chunk).
 *   3. Run a bulk INSERT into chunks (mimicking Commit 3's planned path).
 *   4. Capture: heapUsed delta, rss delta, latency, success/error.
 *   5. Cleanup: DELETE chunks WHERE summary_id, DELETE the synthetic summary.
 *
 * Recommendation derivation:
 *   MAX_BATCH_INSERT_CHUNKS = 50% of largest size that succeeded WITHOUT
 *   warnings, rounded down to multiple of 50.
 *
 * Usage:
 *   deno run --allow-env --allow-net --allow-write \
 *     scripts/diagnostics/pr298/03-probe-memory-bulk-insert.ts
 *
 * Safety:
 *   Synthetic data only. The summary is identified by title prefix
 *   "__pr298_memory_probe_synthetic__" for guaranteed cleanup.
 *   Manual cleanup if script crashes:
 *     DELETE FROM chunks WHERE summary_id IN (
 *       SELECT id FROM summaries WHERE title LIKE '__pr298_memory_probe_synthetic__%'
 *     );
 *     DELETE FROM summaries WHERE title LIKE '__pr298_memory_probe_synthetic__%';
 */

import { createClient } from "npm:@supabase/supabase-js";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SIZES = [100, 250, 500, 1000, 2000];
const EMBEDDING_DIM = 1536;
const SENTINEL_TITLE = "__pr298_memory_probe_synthetic__";

interface ProbeResult {
  size: number;
  heap_before_mb: number;
  heap_after_mb: number;
  heap_delta_mb: number;
  rss_before_mb: number;
  rss_after_mb: number;
  rss_delta_mb: number;
  insert_ms: number;
  success: boolean;
  error: string | null;
  notes: string[];
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function buildSyntheticChunk(summaryId: string, idx: number): {
  summary_id: string;
  content: string;
  content_hash: string;
  chunk_index: number;
  embedding: number[];
} {
  // Simulate ~600 chars per chunk (typical post-chunker output)
  const content = `Synthetic chunk #${idx} for memory probing. `.repeat(20);
  const embedding = new Array(EMBEDDING_DIM).fill(0).map(() => Math.random() * 2 - 1);
  // Normalize to L2 = 1 (matches OpenAI's normalized output)
  const norm = Math.sqrt(embedding.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < embedding.length; i++) embedding[i] /= norm;
  return {
    summary_id: summaryId,
    content,
    content_hash: `synthetic-${idx}-${Date.now()}`,
    chunk_index: idx,
    embedding,
  };
}

async function setupSummary(): Promise<{ id: string; institution_id: string }> {
  // Need a real institution_id — pick the first one.
  const { data: insts } = await db
    .from("institutions")
    .select("id")
    .limit(1);
  const inst = (insts?.[0]?.id as string) ?? null;
  if (!inst) throw new Error("No institutions found");

  // Need a real created_by user. Pick any user_metadata or first profile.
  const { data: profiles } = await db
    .from("profiles")
    .select("id")
    .eq("institution_id", inst)
    .limit(1);
  const owner = (profiles?.[0]?.id as string) ?? null;

  const { data: created, error } = await db
    .from("summaries")
    .insert({
      title: SENTINEL_TITLE,
      content_markdown: "synthetic",
      status: "draft",
      institution_id: inst,
      ...(owner ? { created_by: owner } : {}),
    })
    .select("id, institution_id")
    .single();

  if (error || !created) {
    throw new Error(
      `setup failed: ${error?.message} — may need adjusting required columns for your schema`,
    );
  }
  return { id: created.id as string, institution_id: created.institution_id as string };
}

async function cleanup(summaryId: string) {
  await db.from("chunks").delete().eq("summary_id", summaryId);
  await db.from("summaries").delete().eq("id", summaryId);
}

async function probeOnce(summaryId: string, size: number): Promise<ProbeResult> {
  const notes: string[] = [];
  // Clear chunks from prior probe
  await db.from("chunks").delete().eq("summary_id", summaryId);
  // Force GC if possible (Deno doesn't expose explicit GC; rely on minor pause)
  await new Promise((r) => setTimeout(r, 200));

  const memBefore = Deno.memoryUsage();
  const chunks = Array.from(
    { length: size },
    (_, i) => buildSyntheticChunk(summaryId, i),
  );

  const insertStart = performance.now();
  let success = false;
  let error: string | null = null;
  try {
    // Single bulk insert (the "after" path of Commit 3)
    const { error: insErr } = await db.from("chunks").insert(chunks);
    if (insErr) {
      error = insErr.message;
      notes.push(`insert error: ${insErr.message}`);
    } else {
      success = true;
    }
  } catch (e) {
    error = (e as Error).message;
    notes.push(`exception: ${error}`);
  }
  const insertMs = Math.round(performance.now() - insertStart);
  const memAfter = Deno.memoryUsage();

  if (insertMs > 30000) {
    notes.push(`slow: ${insertMs}ms (>30s)`);
  }

  return {
    size,
    heap_before_mb: mb(memBefore.heapUsed),
    heap_after_mb: mb(memAfter.heapUsed),
    heap_delta_mb: mb(memAfter.heapUsed - memBefore.heapUsed),
    rss_before_mb: mb(memBefore.rss),
    rss_after_mb: mb(memAfter.rss),
    rss_delta_mb: mb(memAfter.rss - memBefore.rss),
    insert_ms: insertMs,
    success,
    error,
    notes,
  };
}

function recommendMaxBatch(results: ProbeResult[]): {
  empirical_max: number;
  recommended: number;
  rationale: string;
} {
  const successful = results.filter((r) =>
    r.success && r.notes.length === 0
  );
  if (successful.length === 0) {
    return {
      empirical_max: 0,
      recommended: 200,
      rationale: "No size succeeded cleanly. Conservative default 200 (audit recommendation).",
    };
  }
  const max = Math.max(...successful.map((r) => r.size));
  // Half, rounded down to multiple of 50
  const half = Math.floor((max / 2) / 50) * 50;
  return {
    empirical_max: max,
    recommended: half,
    rationale: `50% of max successful size (${max}), rounded down to multiple of 50.`,
  };
}

async function main() {
  console.log("Memory probing — synthetic bulk inserts at:", SIZES.join(", "));
  console.log("Sentinel title for cleanup:", SENTINEL_TITLE, "\n");

  let summary: { id: string; institution_id: string } | null = null;
  const results: ProbeResult[] = [];

  try {
    summary = await setupSummary();
    console.log(`Test summary created: ${summary.id}\n`);

    for (const size of SIZES) {
      console.log(`Probing size ${size}...`);
      const r = await probeOnce(summary.id, size);
      results.push(r);
      console.log(
        `  heap_delta=${r.heap_delta_mb}MB rss_delta=${r.rss_delta_mb}MB ` +
          `insert=${r.insert_ms}ms success=${r.success}` +
          (r.notes.length > 0 ? ` notes=[${r.notes.join("; ")}]` : ""),
      );
      // Allow GC + DB to settle
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    if (summary) {
      console.log(`\nCleanup: deleting synthetic summary ${summary.id}`);
      try {
        await cleanup(summary.id);
        console.log("✓ cleanup ok");
      } catch (e) {
        console.error("⚠ cleanup failed:", (e as Error).message);
        console.error("  Manual cleanup SQL:");
        console.error(`    DELETE FROM chunks WHERE summary_id = '${summary.id}';`);
        console.error(`    DELETE FROM summaries WHERE id = '${summary.id}';`);
      }
    }
  }

  const rec = recommendMaxBatch(results);

  console.log("\n" + "=".repeat(70));
  console.log("MEMORY PROBING RESULTS:");
  console.log("  size  | heap_delta_mb | rss_delta_mb | insert_ms | status");
  console.log("  ".padEnd(70, "-"));
  for (const r of results) {
    const status = r.success ? (r.notes.length > 0 ? "warn" : "ok") : "FAIL";
    console.log(
      `  ${r.size.toString().padStart(5)} | ` +
        `${r.heap_delta_mb.toString().padStart(13)} | ` +
        `${r.rss_delta_mb.toString().padStart(12)} | ` +
        `${r.insert_ms.toString().padStart(9)} | ${status}`,
    );
  }
  console.log("\n  Recommendation:");
  console.log(`    MAX_BATCH_INSERT_CHUNKS = ${rec.recommended}`);
  console.log(`    Rationale: ${rec.rationale}`);

  await ensureDir("./out");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `./out/03-probe-memory-bulk-insert-${ts}.json`;
  await Deno.writeTextFile(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        sizes_tested: SIZES,
        results,
        recommendation: rec,
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
