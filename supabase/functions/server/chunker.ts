/**
 * chunker.ts — Intelligent markdown chunking for Axon RAG
 *
 * Pure function, no network calls. Receives markdown text,
 * returns an array of ChunkResult with content, order_index,
 * char_count, and strategy metadata.
 *
 * Algorithm: Recursive Character Splitting
 *   1. Split by "\n## " (h2 headings) → sections
 *   2. If section > maxChunkSize:
 *      a. Split by "\n### " (h3)
 *      b. If still large: split by "\n\n" (paragraphs)
 *      c. If still large: split by ". " (sentences)
 *      d. If still large: split by " " (words) — last resort
 *   3. Merge chunks < minChunkSize with the next chunk
 *   4. Add overlap: last N chars of previous chunk prepended to next
 *   5. Assign sequential order_index
 *
 * Quality rules:
 *   - Never cut mid-sentence (find nearest boundary)
 *   - Preserve headers (section header stays with first chunk)
 *   - Overlap is semantic (last N chars of previous chunk)
 *   - Empty/whitespace input returns []
 *
 * Fase 5 — Issue #30, sub-task 5.1
 */

// ─── Types ──────────────────────────────────────────────────────

export interface ChunkResult {
  content: string;
  order_index: number;
  char_count: number;
  strategy: "recursive" | "semantic";
}

export interface ChunkOptions {
  maxChunkSize?: number;
  minChunkSize?: number;
  overlapSize?: number;
  enableSemantic?: boolean;
}

const DEFAULTS: Required<ChunkOptions> = {
  maxChunkSize: 800,
  minChunkSize: 100,
  overlapSize: 50,
  enableSemantic: true,
};

// ─── Splitters (ordered by priority) ────────────────────────────

const SPLIT_HIERARCHY: Array<{ separator: string; keepSeparator: boolean }> = [
  { separator: "\n## ",  keepSeparator: true },   // h2 headings
  { separator: "\n### ", keepSeparator: true },   // h3 headings
  { separator: "\n\n",   keepSeparator: false },  // paragraphs
  { separator: ". ",     keepSeparator: true },   // sentences
  { separator: " ",      keepSeparator: false },  // words (last resort)
];

// ─── Core splitting logic ───────────────────────────────────────

/**
 * Split text by a separator, optionally keeping the separator
 * at the start of each resulting piece (for headers).
 */
function splitBySeparator(
  text: string,
  separator: string,
  keepSeparator: boolean,
): string[] {
  if (!text.includes(separator)) return [text];

  const parts = text.split(separator);
  const result: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0) {
      // First part has no separator before it
      if (part.trim().length > 0) result.push(part);
    } else {
      // Re-attach separator for headers
      const piece = keepSeparator ? separator.trimStart() + part : part;
      if (piece.trim().length > 0) result.push(piece);
    }
  }

  return result;
}

/**
 * Recursively split a piece of text until all pieces are
 * within maxChunkSize, using progressively finer separators.
 */
function recursiveSplit(
  text: string,
  maxSize: number,
  separatorIndex: number = 0,
): string[] {
  // Base case: text fits
  if (text.length <= maxSize) return [text];

  // Base case: no more separators to try
  if (separatorIndex >= SPLIT_HIERARCHY.length) {
    // Hard truncate as absolute last resort (shouldn't normally happen)
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxSize) {
      chunks.push(text.slice(i, i + maxSize));
    }
    return chunks;
  }

  const { separator, keepSeparator } = SPLIT_HIERARCHY[separatorIndex];
  const pieces = splitBySeparator(text, separator, keepSeparator);

  // If splitting didn't help (only 1 piece), try next separator
  if (pieces.length <= 1) {
    return recursiveSplit(text, maxSize, separatorIndex + 1);
  }

  // Recursively split any pieces that are still too large
  const result: string[] = [];
  for (const piece of pieces) {
    if (piece.length <= maxSize) {
      result.push(piece);
    } else {
      // Try next finer separator for this piece
      result.push(...recursiveSplit(piece, maxSize, separatorIndex + 1));
    }
  }

  return result;
}

// ─── Merge small chunks ─────────────────────────────────────────

/**
 * Merge consecutive chunks that are smaller than minChunkSize.
 * A small chunk gets merged with the NEXT chunk.
 */
function mergeSmallChunks(chunks: string[], minSize: number): string[] {
  if (chunks.length <= 1) return chunks;

  const result: string[] = [];
  let buffer = "";

  for (const chunk of chunks) {
    if (buffer.length > 0) {
      buffer = buffer.trimEnd() + "\n\n" + chunk.trimStart();
    } else {
      buffer = chunk;
    }

    if (buffer.length >= minSize) {
      result.push(buffer);
      buffer = "";
    }
  }

  // Remaining buffer: merge with last chunk or push as-is
  if (buffer.length > 0) {
    if (result.length > 0 && buffer.length < minSize) {
      result[result.length - 1] =
        result[result.length - 1].trimEnd() + "\n\n" + buffer.trimStart();
    } else {
      result.push(buffer);
    }
  }

  return result;
}

// ─── Overlap application ────────────────────────────────────────

/**
 * Add overlap from the end of each chunk to the beginning of the next.
 * The overlap text is taken from the last `overlapSize` characters of
 * the previous chunk, trimmed to a word boundary.
 */
function addOverlap(chunks: string[], overlapSize: number): string[] {
  if (overlapSize <= 0 || chunks.length <= 1) return chunks;

  const result: string[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const current = chunks[i];

    // Extract overlap from end of previous chunk
    let overlapText = prev.slice(-overlapSize);

    // Trim to word boundary (don't start mid-word)
    const firstSpace = overlapText.indexOf(" ");
    if (firstSpace > 0 && firstSpace < overlapText.length - 1) {
      overlapText = overlapText.slice(firstSpace + 1);
    }

    // Don't add overlap if current chunk already starts with the overlap text
    if (!current.startsWith(overlapText.trim())) {
      result.push("..." + overlapText.trimStart() + "\n" + current);
    } else {
      result.push(current);
    }
  }

  return result;
}

// ─── Main entry point ───────────────────────────────────────────

/**
 * Chunk markdown text into semantically coherent pieces.
 *
 * @param markdown - The markdown text to chunk
 * @param options  - Optional chunking parameters
 * @returns Array of ChunkResult, ordered by order_index
 */
export function chunkMarkdown(
  markdown: string,
  options?: ChunkOptions,
): ChunkResult[] {
  // Merge options with defaults
  const opts = { ...DEFAULTS, ...options };

  // Guard: empty or whitespace-only input
  if (!markdown || markdown.trim().length === 0) return [];

  const text = markdown.trim();

  // Step 1: Recursive split
  let rawChunks = recursiveSplit(text, opts.maxChunkSize);

  // Step 2: Merge small chunks
  rawChunks = mergeSmallChunks(rawChunks, opts.minChunkSize);

  // Step 3: Add overlap
  rawChunks = addOverlap(rawChunks, opts.overlapSize);

  // Step 4: Build ChunkResult array
  const results: ChunkResult[] = rawChunks.map((content, i) => ({
    content: content.trim(),
    order_index: i,
    char_count: content.trim().length,
    strategy: "recursive" as const,
  }));

  return results;
}
