/**
 * embedding-cache.ts — In-memory TTL cache for query embeddings
 *
 * Avoids redundant OpenAI API calls when the same text is embedded
 * multiple times within a short window (e.g., semantic chunker paragraphs
 * re-embedded in auto-ingest, or repeated RAG queries).
 *
 * Key: fast string hash of text, Value: { embedding, expiresAt }
 * TTL: 1 hour (configurable via TTL_MS)
 *
 * Uses a simple djb2-variant hash (not cryptographic) — fast and sufficient
 * for cache key purposes.
 */

// ─── Types ───────────────────────────────────────────────────────

interface CacheEntry {
  embedding: number[];
  expiresAt: number;
}

// ─── Constants ───────────────────────────────────────────────────

const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 500; // prevent unbounded memory growth

// ─── Cache Store ─────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

// ─── Fast String Hash (djb2 variant) ─────────────────────────────

function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // hash * 33 + charCode
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Look up a cached embedding by text content.
 * Returns null if not found or expired.
 */
export function getCachedEmbedding(text: string): number[] | null {
  const key = hashString(text);
  const entry = cache.get(key);

  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.embedding;
}

/**
 * Store an embedding in cache with TTL.
 * Evicts oldest entries if cache exceeds MAX_ENTRIES.
 */
export function setCachedEmbedding(text: string, embedding: number[]): void {
  const key = hashString(text);

  // Evict expired entries if we're at capacity
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) {
        cache.delete(k);
      }
    }
    // If still at capacity after evicting expired, remove oldest
    if (cache.size >= MAX_ENTRIES) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) {
        cache.delete(firstKey);
      }
    }
  }

  cache.set(key, {
    embedding,
    expiresAt: Date.now() + TTL_MS,
  });
}
