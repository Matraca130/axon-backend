/**
 * semantic-chunker.ts — Embedding-based semantic chunking for Axon RAG
 *
 * Splits markdown text into chunks based on SEMANTIC similarity between
 * consecutive paragraphs, not just structural markers. When similarity
 * between two paragraphs drops below a threshold, a chunk boundary is
 * placed there.
 *
 * Algorithm:
 *   1. Normalize line endings
 *   2. Split by "\n\n" (paragraphs)
 *   3. Mark headers (# lines) as mandatory boundaries
 *   4. Pre-merge tiny paragraphs (<minParagraphChars) with next
 *   5. Guard: if paragraph count > maxParagraphs → fallback to recursive
 *   6. Embed each paragraph via injected embedFn
 *   7. Compute cosine similarity between consecutive embeddings
 *   8. Identify boundaries: similarity < threshold OR mandatory (header)
 *   9. Group paragraphs between boundaries into chunks
 *   10. Split oversized chunks at lowest-similarity internal point
 *   11. Merge undersized chunks with neighbor
 *   12. Add overlap between consecutive chunks
 *   13. Return ChunkResult[] with strategy = "semantic"
 *
 * Dependencies:
 *   - chunker.ts: ChunkResult (type), ChunkOptions (type), addOverlap (fn),
 *                 chunkMarkdown (fallback)
 *   - embedFn: injected async function, NOT imported from gemini.ts
 *
 * Error strategy:
 *   - If ANY embedding call fails → fallback to recursive chunking
 *   - Logs warning on fallback (non-fatal)
 *   - Never throws (returns valid ChunkResult[] always)
 *
 * Performance:
 *   - N paragraphs = N embedding calls (sequential, ~200ms each)
 *   - Typical summary (10-20 paragraphs) = 2-4 seconds chunking
 *   - Max 100 paragraphs = ~20 seconds (fire-and-forget acceptable)
 *   - Above 100 paragraphs → auto-fallback to recursive (zero cost)
 *   - Limit is based on edge function timeout (60s), not API plan tier.
 *     Callers can override maxParagraphs via options for custom setups.
 *
 * Decisions: D31-D44 (see RAG_ROADMAP.md)
 *
 * Fase 5 continuation — Semantic Chunking (#23)
 */

import {
  chunkMarkdown,
  addOverlap,
  type ChunkResult,
  type ChunkOptions,
} from "./chunker.ts";

// ─── Public Types ───────────────────────────────────────────────────

export interface SemanticChunkOptions extends ChunkOptions {
  similarityThreshold?: number;
  minParagraphChars?: number;
  maxParagraphs?: number;
}

const SEMANTIC_DEFAULTS = {
  similarityThreshold: 0.35,
  minParagraphChars: 80,
  maxParagraphs: 100,
} as const;

// ─── Cosine Similarity ─────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Entry Point ────────────────────────────────────────────────────

export async function chunkSemantic(
  text: string,
  embedFn: (text: string) => Promise<number[]>,
  options?: SemanticChunkOptions,
): Promise<ChunkResult[]> {
  if (!text || text.trim().length === 0) return [];

  const normalized = text.replace(/\r\n/g, "\n").trim();

  const raw = {
    maxChunkSize: options?.maxChunkSize ?? 800,
    minChunkSize: options?.minChunkSize ?? 100,
    overlapSize: options?.overlapSize ?? 50,
    similarityThreshold: options?.similarityThreshold ?? SEMANTIC_DEFAULTS.similarityThreshold,
    minParagraphChars: options?.minParagraphChars ?? SEMANTIC_DEFAULTS.minParagraphChars,
    maxParagraphs: options?.maxParagraphs ?? SEMANTIC_DEFAULTS.maxParagraphs,
  };

  const opts = {
    maxChunkSize: Math.max(raw.maxChunkSize, 1),
    minChunkSize: Math.min(raw.minChunkSize, raw.maxChunkSize),
    overlapSize: Math.min(raw.overlapSize, Math.floor(raw.maxChunkSize / 4)),
    similarityThreshold: Math.max(0.1, Math.min(0.9, raw.similarityThreshold)),
    minParagraphChars: Math.max(20, raw.minParagraphChars),
    maxParagraphs: Math.max(5, raw.maxParagraphs),
  };

  // Step 1: Split into paragraphs
  const rawParagraphs = normalized
    .split("\n\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (rawParagraphs.length <= 1) {
    return rawParagraphs.length === 0
      ? []
      : [{
          content: rawParagraphs[0],
          order_index: 0,
          char_count: rawParagraphs[0].length,
          strategy: "semantic" as const,
        }];
  }

  // Step 2: Mark mandatory boundaries (headers)
  const isMandatoryBoundary = rawParagraphs.map((p) => /^#{1,6}\s/.test(p));

  // Step 3: Pre-merge tiny paragraphs
  const mergedParagraphs: string[] = [];
  const mergedBoundaries: boolean[] = [];

  let buffer = "";
  let bufferIsBoundary = false;

  for (let i = 0; i < rawParagraphs.length; i++) {
    const para = rawParagraphs[i];
    const isBound = isMandatoryBoundary[i];

    if (isBound && buffer.length > 0) {
      mergedParagraphs.push(buffer);
      mergedBoundaries.push(bufferIsBoundary);
      buffer = "";
      bufferIsBoundary = false;
    }

    if (buffer.length === 0) {
      buffer = para;
      bufferIsBoundary = isBound;
    } else {
      buffer = buffer + "\n\n" + para;
    }

    if (buffer.length >= opts.minParagraphChars) {
      mergedParagraphs.push(buffer);
      mergedBoundaries.push(bufferIsBoundary);
      buffer = "";
      bufferIsBoundary = false;
    }
  }

  if (buffer.length > 0) {
    if (mergedParagraphs.length > 0 && buffer.length < opts.minParagraphChars) {
      mergedParagraphs[mergedParagraphs.length - 1] += "\n\n" + buffer;
    } else {
      mergedParagraphs.push(buffer);
      mergedBoundaries.push(bufferIsBoundary);
    }
  }

  // Step 4: Paragraph count guard
  if (mergedParagraphs.length > opts.maxParagraphs) {
    console.warn(
      `[Semantic Chunker] ${mergedParagraphs.length} paragraphs exceeds ` +
        `maxParagraphs (${opts.maxParagraphs}). Falling back to recursive.`,
    );
    return fallbackToRecursive(normalized, options);
  }

  if (mergedParagraphs.length <= 1) {
    return mergedParagraphs.length === 0
      ? []
      : [{
          content: mergedParagraphs[0],
          order_index: 0,
          char_count: mergedParagraphs[0].length,
          strategy: "semantic" as const,
        }];
  }

  // Step 5: Embed each paragraph
  const embeddings: number[][] = [];

  try {
    for (const para of mergedParagraphs) {
      const embedding = await embedFn(para);
      embeddings.push(embedding);
    }
  } catch (e) {
    console.warn(
      `[Semantic Chunker] Embedding failed: ${(e as Error).message}. ` +
        `Falling back to recursive chunking.`,
    );
    return fallbackToRecursive(normalized, options);
  }

  // Step 6: Compute similarities
  const similarities: number[] = [];
  for (let i = 0; i < embeddings.length - 1; i++) {
    similarities.push(cosineSimilarity(embeddings[i], embeddings[i + 1]));
  }

  // Step 7: Identify boundaries
  const boundaryAfter: boolean[] = [];
  for (let i = 0; i < similarities.length; i++) {
    const isSemantic = similarities[i] < opts.similarityThreshold;
    const isMandatory = mergedBoundaries[i + 1] === true;
    boundaryAfter.push(isSemantic || isMandatory);
  }

  // Step 8: Group paragraphs into chunks
  const groups: Array<{ paragraphs: string[]; similarities: number[] }> = [];
  let currentGroup: string[] = [mergedParagraphs[0]];
  let currentSims: number[] = [];

  for (let i = 0; i < boundaryAfter.length; i++) {
    if (boundaryAfter[i]) {
      groups.push({ paragraphs: currentGroup, similarities: currentSims });
      currentGroup = [mergedParagraphs[i + 1]];
      currentSims = [];
    } else {
      currentGroup.push(mergedParagraphs[i + 1]);
      currentSims.push(similarities[i]);
    }
  }
  groups.push({ paragraphs: currentGroup, similarities: currentSims });

  // Step 9: Split oversized groups
  const sizedGroups: string[][] = [];
  for (const group of groups) {
    const subGroups = splitOversizedGroup(
      group.paragraphs,
      group.similarities,
      opts.maxChunkSize,
    );
    sizedGroups.push(...subGroups);
  }

  // Step 10: Join paragraphs into chunk text
  let chunks = sizedGroups.map((paras) => paras.join("\n\n"));

  // Step 11: Merge undersized chunks
  chunks = mergeSmallSemanticChunks(chunks, opts.minChunkSize);

  // Step 12: Add overlap
  chunks = addOverlap(chunks, opts.overlapSize);

  // Step 13: Build final results
  return chunks.map((content, i) => ({
    content,
    order_index: i,
    char_count: content.length,
    strategy: "semantic" as const,
  }));
}

// ─── Internal: Split Oversized Groups ──────────────────────────────

function splitOversizedGroup(
  paragraphs: string[],
  similarities: number[],
  maxSize: number,
): string[][] {
  const combinedLength = paragraphs.reduce((sum, p) => sum + p.length, 0)
    + (paragraphs.length - 1) * 2;

  if (combinedLength <= maxSize) return [paragraphs];
  if (paragraphs.length <= 1) return [paragraphs];
  if (similarities.length === 0) return [paragraphs];

  let minSim = Infinity;
  let splitIdx = Math.floor(paragraphs.length / 2);

  for (let i = 0; i < similarities.length; i++) {
    if (similarities[i] < minSim) {
      minSim = similarities[i];
      splitIdx = i + 1;
    }
  }

  if (splitIdx <= 0) splitIdx = 1;
  if (splitIdx >= paragraphs.length) splitIdx = paragraphs.length - 1;

  const leftParas = paragraphs.slice(0, splitIdx);
  const rightParas = paragraphs.slice(splitIdx);
  const leftSims = similarities.slice(0, splitIdx - 1);
  const rightSims = similarities.slice(splitIdx);

  return [
    ...splitOversizedGroup(leftParas, leftSims, maxSize),
    ...splitOversizedGroup(rightParas, rightSims, maxSize),
  ];
}

// ─── Internal: Merge Small Chunks ───────────────────────────────────

function mergeSmallSemanticChunks(
  chunks: string[],
  minSize: number,
): string[] {
  if (chunks.length <= 1) return chunks;

  const result: string[] = [];
  let buffer = "";

  for (const chunk of chunks) {
    if (buffer.length === 0) {
      buffer = chunk;
    } else {
      buffer = buffer + "\n\n" + chunk;
    }

    if (buffer.length >= minSize) {
      result.push(buffer);
      buffer = "";
    }
  }

  if (buffer.length > 0) {
    if (result.length > 0 && buffer.length < minSize) {
      result[result.length - 1] = result[result.length - 1] + "\n\n" + buffer;
    } else {
      result.push(buffer);
    }
  }

  return result;
}

// ─── Internal: Fallback ─────────────────────────────────────────────

function fallbackToRecursive(
  text: string,
  options?: ChunkOptions,
): ChunkResult[] {
  return chunkMarkdown(text, options);
}
