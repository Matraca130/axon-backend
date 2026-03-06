/**
 * chunker.ts — Intelligent markdown chunking for Axon RAG
 *
 * Pure function module, zero network/DB dependencies.
 * Receives markdown text, returns an array of semantically coherent chunks
 * optimised for embedding + vector retrieval.
 *
 * Algorithm: Recursive Character Splitting
 *   1. Split by "\n## " (h2 headings) → sections
 *   2. If section > maxChunkSize → split by "\n### " (h3)
 *   3. If still large → split by "\n\n" (paragraphs)
 *   4. If still large → split by ". " (sentences)
 *   5. If still large → split by " " (words) — last resort
 *   6. Merge chunks < minChunkSize with the next chunk
 *   7. Add overlap: last N chars of previous chunk prepended to next
 *
 * Quality guarantees:
 *   - Never cuts mid-sentence (sentence boundary is a separator level)
 *   - Preserves markdown headers in the first chunk of each section
 *   - Overlap ensures retrieval context continuity across boundaries
 *   - Tracks which splitting strategy was used per chunk
 *
 * Fase 5 — Issue #30
 */

// ─── Public Types ───────────────────────────────────────────────────

export interface ChunkResult {
  /** Text content of the chunk */
  content: string;
  /** Sequential position (0-based) */
  order_index: number;
  /** Character count of content */
  char_count: number;
  /** Splitting strategy that produced this chunk */
  strategy: "recursive" | "semantic";
}

export interface ChunkOptions {
  /** Maximum chars per chunk (default: 800) */
  maxChunkSize?: number;
  /** Minimum chars per chunk — smaller ones get merged (default: 100) */
  minChunkSize?: number;
  /** Chars of overlap between consecutive chunks (default: 50) */
  overlapSize?: number;
}

const DEFAULTS = {
  maxChunkSize: 800,
  minChunkSize: 100,
  overlapSize: 50,
} as const;

// ─── Separator Hierarchy ────────────────────────────────────────────
//
// Ordered from coarsest (structural) to finest (character-level).
// Each level preserves more semantic coherence than the next.

const SEPARATORS = [
  "\n## ",   // H2 headings — major topic boundaries
  "\n### ",  // H3 headings — sub-topic boundaries
  "\n\n",    // Paragraph breaks
  ". ",      // Sentence boundaries
  " ",       // Word boundaries — last resort
] as const;

// ─── Entry Point ────────────────────────────────────────────────────

/**
 * Split markdown text into semantically coherent chunks for RAG embedding.
 *
 * @param text      Raw markdown content (typically summary title + content_markdown)
 * @param options   Override default chunk size / overlap parameters
 * @returns         Array of ChunkResult sorted by order_index
 *
 * @example
 *   const chunks = chunkMarkdown(summary.content_markdown);
 *   // → [{ content: "## Mitosis\n...", order_index: 0, char_count: 480, strategy: "recursive" }, ...]
 */
export function chunkMarkdown(
  text: string,
  options?: ChunkOptions,
): ChunkResult[] {
  // ── Guard: empty / whitespace-only input ──
  if (!text || text.trim().length === 0) return [];

  const opts = { ...DEFAULTS, ...options };

  // ── Step 1: Recursive split ──
  const rawFragments = recursiveSplit(text.trim(), SEPARATORS, 0, opts);

  // ── Step 2: Merge small chunks ──
  const merged = mergeSmallChunks(rawFragments, opts.minChunkSize);

  // ── Step 3: Add overlap ──
  const withOverlap = addOverlap(merged, opts.overlapSize);

  // ── Step 4: Build final results ──
  return withOverlap.map((content, i) => ({
    content,
    order_index: i,
    char_count: content.length,
    strategy: "recursive" as const,
  }));
}

// ─── Core: Recursive Splitting ──────────────────────────────────────

/**
 * Recursively split text using a hierarchy of separators.
 *
 * At each level:
 *   1. Split text by current separator
 *   2. Re-attach the separator to the start of each fragment (for headers)
 *      so that "## Mitosis" stays with its content
 *   3. For each fragment: if it fits → keep; if too large → recurse deeper
 *   4. If we're at the last separator (" ") and still too large → hard split
 */
function recursiveSplit(
  text: string,
  separators: readonly string[],
  level: number,
  opts: Required<ChunkOptions>,
): string[] {
  // Base case: text fits in one chunk
  if (text.length <= opts.maxChunkSize) {
    return [text];
  }

  // No more separators → hard split by maxChunkSize (absolute last resort)
  if (level >= separators.length) {
    return hardSplit(text, opts.maxChunkSize);
  }

  const separator = separators[level];
  const parts = text.split(separator);

  // If the separator didn't split anything useful → try next level
  if (parts.length <= 1) {
    return recursiveSplit(text, separators, level + 1, opts);
  }

  // Re-attach separator to each fragment (except the first)
  // This preserves headers: "## Mitosis\nContent" stays as "## Mitosis\nContent"
  const fragments: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0) {
      // First fragment: no separator prefix
      if (part.trim().length > 0) {
        fragments.push(part);
      }
    } else {
      // Subsequent fragments: re-attach separator
      const restored = separator.trimStart() + part;
      if (restored.trim().length > 0) {
        fragments.push(restored);
      }
    }
  }

  // Recurse: if any fragment is still too large, split it deeper
  const result: string[] = [];
  for (const frag of fragments) {
    if (frag.length <= opts.maxChunkSize) {
      result.push(frag);
    } else {
      // Go one level deeper in the separator hierarchy
      const subChunks = recursiveSplit(frag, separators, level + 1, opts);
      result.push(...subChunks);
    }
  }

  return result;
}

// ─── Hard Split (Last Resort) ───────────────────────────────────────

/**
 * Hard-split text into chunks of exactly maxSize chars.
 * Only used when all separators have been exhausted — extremely rare
 * for well-formed markdown.
 */
function hardSplit(text: string, maxSize: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + maxSize));
    offset += maxSize;
  }
  return chunks;
}

// ─── Merge Small Chunks ─────────────────────────────────────────────

/**
 * Merge chunks smaller than minSize with the next chunk.
 * Prevents low-information fragments that would waste embedding calls
 * and produce poor retrieval matches.
 */
function mergeSmallChunks(chunks: string[], minSize: number): string[] {
  if (chunks.length <= 1) return chunks;

  const result: string[] = [];
  let buffer = "";

  for (const chunk of chunks) {
    if (buffer.length === 0) {
      buffer = chunk;
    } else {
      buffer = buffer + "\n\n" + chunk;
    }

    // Flush buffer if it's large enough
    if (buffer.length >= minSize) {
      result.push(buffer);
      buffer = "";
    }
  }

  // Handle remaining buffer
  if (buffer.length > 0) {
    if (result.length > 0 && buffer.length < minSize) {
      // Merge with the last chunk instead of leaving a tiny trailing chunk
      result[result.length - 1] = result[result.length - 1] + "\n\n" + buffer;
    } else {
      result.push(buffer);
    }
  }

  return result;
}

// ─── Overlap ────────────────────────────────────────────────────────

/**
 * Add overlap between consecutive chunks.
 * The last N characters of chunk[i] are prepended to chunk[i+1].
 * This ensures that retrieval context isn't lost at chunk boundaries.
 *
 * The overlap text is separated by "\n...\n" to signal to the LLM
 * that this is continued context from the previous segment.
 */
function addOverlap(chunks: string[], overlapSize: number): string[] {
  if (chunks.length <= 1 || overlapSize <= 0) return chunks;

  const result: string[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prevChunk = chunks[i - 1];

    // Extract overlap from the end of the previous chunk
    // Try to start at a word boundary to avoid cutting mid-word
    let overlapStart = Math.max(0, prevChunk.length - overlapSize);

    // Snap to the nearest word boundary (space) after overlapStart
    const spaceIdx = prevChunk.indexOf(" ", overlapStart);
    if (spaceIdx !== -1 && spaceIdx < prevChunk.length) {
      overlapStart = spaceIdx + 1;
    }

    const overlapText = prevChunk.slice(overlapStart).trim();

    if (overlapText.length > 0) {
      result.push(overlapText + "\n...\n" + chunks[i]);
    } else {
      result.push(chunks[i]);
    }
  }

  return result;
}
