#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
/**
 * scripts/backfill-contextual.ts — Contextual Retrieval mass backfill
 *
 * Production tool for backfilling `contextual_content` / `contextual_embedding`
 * across previously-ingested chunks. Uses the service_role client directly
 * (no JWT, no rate limit) so it's intended to be run from an operator
 * machine with secrets in env, NOT exposed as an HTTP route.
 *
 * USAGE:
 *   deno run --allow-env --allow-net --allow-read \
 *     scripts/backfill-contextual.ts \
 *     --institution=<uuid> \
 *     [--summary=<uuid>] \
 *     [--batch=50] \
 *     [--pause-ms=500] \
 *     [--max-batches=0] \
 *     [--dry-run]
 *
 * REQUIRED ENV:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY   (for Haiku contextualization)
 *   OPENAI_API_KEY      (for contextual embeddings)
 *
 * SAFETY:
 *   - Does NOT touch the existing `embedding` column — chunks remain
 *     retrievable even if contextualization fails.
 *   - --dry-run counts pending chunks and estimates cost without calling
 *     any LLM or modifying any row.
 *   - Default pause between batches is 500ms (configurable via --pause-ms)
 *     to stay well under Anthropic and OpenAI rate limits.
 *   - Resume-safe: the partial index `idx_chunks_needs_contextual` always
 *     surfaces chunks still pending, so re-running picks up where a prior
 *     run left off without bookkeeping.
 *
 * COST ESTIMATE (for --dry-run):
 *   Haiku 4.5 input $0.80/MTok, output $4/MTok. With prompt caching the
 *   document portion is amortized ~10x after the first chunk of a summary.
 *   Per-chunk average ~$0.0005 (Haiku) + ~$0.00007 (OpenAI embed) ≈ $0.0006.
 *   20k chunks ≈ $12. Budget $15 to be safe.
 */

import { createClient } from "npm:@supabase/supabase-js";
import {
  contextualizeChunks,
  CONTEXTUALIZER_FALLBACK_MODEL,
} from "../supabase/functions/server/contextualizer.ts";
import { generateEmbeddings } from "../supabase/functions/server/openai-embeddings.ts";
import { flattenBlocksToMarkdown } from "../supabase/functions/server/block-flatten.ts";

// ─── Argument parsing ─────────────────────────────────────────────

interface CliArgs {
  institution: string;
  summary: string | null;
  batch: number;
  pauseMs: number;
  maxBatches: number; // 0 = unlimited
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: Partial<CliArgs> = {
    summary: null,
    batch: 50,
    pauseMs: 500,
    maxBatches: 0,
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg.startsWith("--institution=")) {
      parsed.institution = arg.slice("--institution=".length);
    } else if (arg.startsWith("--summary=")) {
      parsed.summary = arg.slice("--summary=".length);
    } else if (arg.startsWith("--batch=")) {
      parsed.batch = Number(arg.slice("--batch=".length));
    } else if (arg.startsWith("--pause-ms=")) {
      parsed.pauseMs = Number(arg.slice("--pause-ms=".length));
    } else if (arg.startsWith("--max-batches=")) {
      parsed.maxBatches = Number(arg.slice("--max-batches=".length));
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      Deno.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      Deno.exit(2);
    }
  }

  if (!parsed.institution) {
    console.error("Missing required --institution=<uuid>");
    printUsage();
    Deno.exit(2);
  }

  if (!Number.isFinite(parsed.batch) || parsed.batch! <= 0 || parsed.batch! > 200) {
    console.error("--batch must be between 1 and 200");
    Deno.exit(2);
  }

  return parsed as CliArgs;
}

function printUsage(): void {
  console.log(`
USAGE:
  deno run --allow-env --allow-net --allow-read \\
    scripts/backfill-contextual.ts \\
    --institution=<uuid> [options]

OPTIONS:
  --summary=<uuid>        Only process chunks of this summary.
  --batch=<n>             Chunks per RPC call (default: 50, max: 200).
  --pause-ms=<n>          Pause between batches in ms (default: 500).
  --max-batches=<n>       Stop after N batches (default: 0 = unlimited).
  --dry-run               Count pending chunks and estimate cost. No writes.
  -h, --help              Show this message.

ENV:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY
`);
}

// ─── Env check ────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`[FATAL] Missing env var: ${name}`);
    Deno.exit(2);
  }
  return v;
}

// ─── Types ────────────────────────────────────────────────────────

interface PendingChunk {
  chunk_id: string;
  summary_id: string;
  content: string;
  order_index: number;
  summary_title: string;
}

interface RunStats {
  batches: number;
  processed: number;
  succeeded: number;
  failed: number;
  fallback_count: number;
  summaries_touched: Set<string>;
}

// ─── Helpers ──────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function resolveSummaryFullText(db: any, summaryId: string): Promise<{ title: string; fullText: string } | null> {
  const { data: summary } = await db
    .from("summaries")
    .select("title, content_markdown")
    .eq("id", summaryId)
    .single();

  if (!summary) return null;

  const title = ((summary.title as string) ?? "").trim();
  const contentMarkdown = ((summary.content_markdown as string | null) ?? "").trim();

  let sourceText = "";

  const { data: blockRows } = await db
    .from("summary_blocks")
    .select("id, type, content, order_index")
    .eq("summary_id", summaryId)
    .eq("is_active", true)
    .order("order_index", { ascending: true });

  if (blockRows && blockRows.length > 0) {
    // deno-lint-ignore no-explicit-any
    const flattened = flattenBlocksToMarkdown(blockRows as any);
    if (flattened.trim().length > 0) sourceText = flattened;
  }

  if (sourceText.length === 0 && contentMarkdown.length > 0) {
    sourceText = contentMarkdown;
  }

  if (sourceText.length === 0) return null;

  return {
    title,
    fullText: title.length > 0 ? `${title}\n\n${sourceText}` : sourceText,
  };
}

async function processGroup(
  // deno-lint-ignore no-explicit-any
  db: any,
  summaryId: string,
  chunks: PendingChunk[],
  stats: RunStats,
): Promise<void> {
  const resolved = await resolveSummaryFullText(db, summaryId);
  if (!resolved) {
    console.warn(
      `  [skip] ${summaryId} — no readable source (blocks empty, content_markdown empty). ${chunks.length} chunks left pending.`,
    );
    stats.failed += chunks.length;
    return;
  }

  const { title, fullText } = resolved;

  const contextualResults = await contextualizeChunks(
    fullText,
    title,
    chunks.map((c) => c.content),
    3,
  );

  let contextualEmbeddings: number[][];
  try {
    contextualEmbeddings = await generateEmbeddings(
      contextualResults.map((r) => r.contextualContent),
    );
  } catch (e) {
    console.warn(
      `  [embed-fail] ${summaryId}: ${(e as Error).message}. Group failed.`,
    );
    stats.failed += chunks.length;
    return;
  }

  for (let i = 0; i < chunks.length; i++) {
    const ctx = contextualResults[i];
    const emb = contextualEmbeddings[i];
    stats.processed++;
    if (ctx.fellBack) stats.fallback_count++;

    const { error } = await db
      .from("chunks")
      .update({
        contextual_content: ctx.contextualContent,
        contextual_embedding: JSON.stringify(emb),
        contextual_model: ctx.model,
      })
      .eq("id", chunks[i].chunk_id);

    if (error) {
      stats.failed++;
      console.warn(`  [update-fail] ${chunks[i].chunk_id}: ${error.message}`);
    } else {
      stats.succeeded++;
    }
  }

  stats.summaries_touched.add(summaryId);
}

function groupBySummary(pending: PendingChunk[]): Map<string, PendingChunk[]> {
  const groups = new Map<string, PendingChunk[]>();
  for (const chunk of pending) {
    const bucket = groups.get(chunk.summary_id);
    if (bucket) bucket.push(chunk);
    else groups.set(chunk.summary_id, [chunk]);
  }
  return groups;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Dry run ──────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function runDryRun(db: any, args: CliArgs): Promise<void> {
  console.log("[dry-run] Counting pending chunks...");

  // Uses the denormalized summaries.institution_id column — single inner join.
  let query = db
    .from("chunks")
    .select("id, summaries!inner(institution_id)", { count: "exact", head: true })
    .is("contextual_content", null)
    .not("embedding", "is", null);

  if (args.summary) {
    query = query.eq("summary_id", args.summary);
  } else {
    query = query.eq("summaries.institution_id", args.institution);
  }

  const { count, error } = await query;

  if (error) {
    console.error(`[dry-run] count query failed: ${error.message}`);
    Deno.exit(1);
  }

  const n = count ?? 0;
  const estCostUsd = (n * 0.0006).toFixed(2);

  console.log(`[dry-run] Pending chunks: ${n}`);
  console.log(`[dry-run] Estimated cost: ~$${estCostUsd} USD (Haiku + OpenAI embeds)`);
  console.log(`[dry-run] At batch=${args.batch}, would take ~${Math.ceil(n / args.batch)} batches`);
  console.log("[dry-run] No writes performed.");
}

// ─── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);

  const SUPABASE_URL = requireEnv("SUPABASE_URL");
  const SERVICE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  // Also check these here so we fail fast (contextualizer checks at call time)
  requireEnv("ANTHROPIC_API_KEY");
  requireEnv("OPENAI_API_KEY");

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`[backfill-contextual] institution=${args.institution}${args.summary ? ` summary=${args.summary}` : ""} batch=${args.batch} pause=${args.pauseMs}ms`);

  if (args.dryRun) {
    await runDryRun(db, args);
    return;
  }

  const t0 = Date.now();
  const stats: RunStats = {
    batches: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    fallback_count: 0,
    summaries_touched: new Set(),
  };

  while (true) {
    if (args.maxBatches > 0 && stats.batches >= args.maxBatches) {
      console.log(`[stop] reached --max-batches=${args.maxBatches}`);
      break;
    }

    const { data: pending, error: rpcErr } = await db.rpc(
      "get_chunks_for_contextual",
      {
        p_summary_id: args.summary ?? null,
        p_institution_id: args.summary ? null : args.institution,
        p_limit: args.batch,
      },
    );

    if (rpcErr) {
      console.error(`[fatal] RPC get_chunks_for_contextual failed: ${rpcErr.message}`);
      Deno.exit(1);
    }

    const pendingChunks = (pending ?? []) as PendingChunk[];

    if (pendingChunks.length === 0) {
      console.log("[done] no more pending chunks");
      break;
    }

    stats.batches++;
    const groups = groupBySummary(pendingChunks);
    const batchStart = Date.now();

    for (const [sid, chunks] of groups) {
      await processGroup(db, sid, chunks, stats);
    }

    const elapsed = Date.now() - batchStart;
    console.log(
      `[batch ${stats.batches}] chunks=${pendingChunks.length} summaries=${groups.size} ` +
        `ok=${stats.succeeded} fail=${stats.failed} fb=${stats.fallback_count} ${elapsed}ms`,
    );

    if (args.pauseMs > 0) await sleep(args.pauseMs);
  }

  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log("=== summary ===");
  console.log(`batches:           ${stats.batches}`);
  console.log(`chunks processed:  ${stats.processed}`);
  console.log(`  succeeded:       ${stats.succeeded}`);
  console.log(`  failed:          ${stats.failed}`);
  console.log(`fallback (Haiku):  ${stats.fallback_count} (marked as ${CONTEXTUALIZER_FALLBACK_MODEL})`);
  console.log(`summaries touched: ${stats.summaries_touched.size}`);
  console.log(`elapsed:           ${totalElapsed}s`);
  if (stats.processed > 0) {
    const fallbackPct = ((stats.fallback_count / stats.processed) * 100).toFixed(1);
    console.log(`fallback rate:     ${fallbackPct}%`);
    if (stats.fallback_count / stats.processed > 0.05) {
      console.warn("[WARN] Fallback rate >5% — check Anthropic API status / quota");
    }
  }
}

if (import.meta.main) {
  await main();
}
