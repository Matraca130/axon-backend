# PR #298 — Pre-flight Staging Measurements

Scripts to run **before** implementing PR #298 (perf(summary): publish + auto-ingest improvements).

> Audit reference: `docs/summary-performance-plan-audit.md` sections 3.1, 3.3, 3.4, 3.5

## Why these scripts

The audit identifies 4 pre-flight gaps that are **blocking**:

| Gap | What | This addresses |
|-----|------|---------------|
| H1 | Baseline measurement | `01-baseline-publish.ts` |
| H3/3.4 | Memory empirical limit | `03-probe-memory-bulk-insert.ts` |
| 3.3 | Embedding parity verification | `02-verify-embedding-parity.ts` |
| 3.5 | Post-change validation (run after impl) | `04-post-change-validation.ts` |

Without the data these scripts produce, we can't know:
- Whether the optimization actually helps (no baseline → no speedup proof)
- The empirical `MAX_BATCH_INSERT_CHUNKS` (audit says don't pick a round number by intuition)
- Whether the current embedding pipeline is sound (parity check)

## Prerequisites

```bash
# Required
deno --version        # need 1.45+
echo $SUPABASE_URL    # staging URL
echo $SUPABASE_SERVICE_ROLE_KEY  # full access key
echo $OPENAI_API_KEY  # for parity check (real embedding generation)

# Recommended
psql --version        # for direct DB queries (any version)
```

If env vars aren't set, copy `.env.staging.example` to `.env.staging` and fill in.

## Execution order

```
00-find-test-summary.ts      ← run first; identifies a target summary with ≥50 blocks
       ↓
01-baseline-publish.ts       ← H1 baseline timing
02-verify-embedding-parity   ← 3.3 parity check (5 summaries)
03-probe-memory-bulk-insert  ← 3.4 memory probing (synthetic 100/250/500/1000/2000)
       ↓
       (Claude implements 3 commits in parallel based on results)
       ↓
04-post-change-validation    ← 3.5 re-baseline + chunks.embedding NULL check
```

## How to run

Each script writes results to `./out/<script-name>-<timestamp>.json` AND prints a human-readable summary to stdout.

```bash
cd /workspace/Axon/backend  # or wherever you have this repo

# Step 0: identify a test summary
deno run --allow-env --allow-net --allow-write \
  scripts/diagnostics/pr298/00-find-test-summary.ts

# Step 1: baseline (uses TEST_SUMMARY_ID from output of step 0)
export TEST_SUMMARY_ID=<from step 0 output>
deno run --allow-env --allow-net --allow-write \
  scripts/diagnostics/pr298/01-baseline-publish.ts

# Step 2: parity (5 summaries with mixed block types)
deno run --allow-env --allow-net --allow-write \
  scripts/diagnostics/pr298/02-verify-embedding-parity.ts

# Step 3: memory probing (this writes synthetic data, then deletes it)
deno run --allow-env --allow-net --allow-write \
  scripts/diagnostics/pr298/03-probe-memory-bulk-insert.ts
```

## What to send back

Just paste the contents of these files (or the summary stdout):

```
out/00-find-test-summary-*.json
out/01-baseline-publish-*.json       ← single number: p50 publish elapsed_ms
out/02-verify-embedding-parity-*.json ← table: summary_id, block_id, similarity, pass
out/03-probe-memory-bulk-insert-*.json ← table: chunk_count, heap_mb, rss_mb, ms, status
```

With those 3 numbers/tables, I can implement the 3 commits with empirical guardrails instead of guesses.

## Safety notes

- All scripts use `SERVICE_ROLE_KEY` (bypasses RLS). **Run only against staging, never prod.**
- Script `00` is read-only.
- Script `01` triggers a real publish (re-publishing an already-published summary is idempotent in this codebase).
- Script `02` is read-only + calls OpenAI embeddings API (cost: ~$0.001 for 5 summaries).
- Script `03` writes synthetic chunks and **deletes them at the end** (with try/finally cleanup). If the script crashes, manually run:
  ```sql
  DELETE FROM chunks WHERE summary_id = (
    SELECT id FROM summaries WHERE title = '__pr298_memory_probe_synthetic__'
  );
  DELETE FROM summaries WHERE title = '__pr298_memory_probe_synthetic__';
  ```

## Branch info

This branch (`staging-diagnostics-pr298`) is **not for merge**. It exists only so you can pull the scripts. After we have the measurements, this branch can be deleted.
