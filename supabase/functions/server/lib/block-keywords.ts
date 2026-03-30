/**
 * block-keywords.ts — Extract {{keyword}} markers from summary block content.
 *
 * Pure utility with zero framework dependencies. Importable in both
 * route handlers and Deno-native tests.
 *
 * The regex scan mirrors the frontend's extractKeywordsFromBlock
 * (keyword-block-mapping.ts) so both sides agree on which keywords
 * belong to which block.
 */

// ─── Keyword marker regex ─────────────────────────────────────────
const KEYWORD_MARKER_RE = /\{\{([^}]+)\}\}/g;

/** Block shape accepted by extractKeywordsFromBlock (framework-agnostic). */
export interface BlockLike {
  type: string;
  content: Record<string, unknown>;
}

/**
 * Extract keyword names from a block's content fields based on block type.
 *
 * Scans text fields for `{{keyword_name}}` markers using a regex that
 * matches the frontend's keyword-block-mapping.ts. Returns raw names
 * (not lowercased) — callers should lowercase for matching.
 *
 * @param block - A summary block with type and content fields
 * @returns Array of keyword names found (may contain duplicates)
 */
export function extractKeywordsFromBlock(block: BlockLike): string[] {
  const found: string[] = [];
  const c = block.content;

  /** Scan a string field for {{keyword}} markers using matchAll (no global state issues). */
  const scan = (value: unknown): void => {
    if (typeof value !== "string") return;
    for (const match of value.matchAll(KEYWORD_MARKER_RE)) {
      found.push(match[1]);
    }
  };

  /** Scan an array of objects for specific fields. */
  const scanArray = (arr: unknown, fields: string[]): void => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      for (const field of fields) {
        scan((item as Record<string, unknown>)[field]);
      }
    }
  };

  // Scan fields based on block type (matches frontend keyword-block-mapping.ts)
  switch (block.type) {
    case "prose":
    case "text":
      scan(c.body);
      break;
    case "key_point":
      scan(c.title);
      scan(c.explanation);
      break;
    case "callout":
      scan(c.title);
      scan(c.body);
      break;
    case "two_column":
      scan(c.left);
      scan(c.right);
      break;
    case "stages":
      scanArray(c.stages, ["title", "description"]);
      break;
    case "list_detail":
      scanArray(c.items, ["title", "detail"]);
      break;
    case "comparison":
      scanArray(c.items, ["title", "description"]);
      break;
    case "grid":
      scanArray(c.cells, ["title", "body"]);
      break;
    case "heading":
      scan(c.text);
      break;
    default:
      // Unknown block type — scan common fields as fallback
      scan(c.body);
      scan(c.title);
      scan(c.text);
      break;
  }

  return found;
}

/**
 * Calculate mastery per block given keyword→subtopic and subtopic→p_know maps.
 *
 * Algorithm: for each block, find its keywords (via extractKeywordsFromBlock),
 * resolve each keyword to subtopics, collect all p_know values, and return
 * AVG(p_know). Uses AVG because it gives equal weight to each subtopic,
 * reflecting overall knowledge breadth across the block's concepts.
 *
 * @returns Record<block_id, mastery> where mastery is 0–1 or -1 (no data)
 */
export function calculateBlockMastery(
  blocks: (BlockLike & { id: string })[],
  kwToSubtopics: Map<string, string[]>,
  subtopicPKnow: Map<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};

  for (const block of blocks) {
    const kwNames = extractKeywordsFromBlock(block).map((k) => k.toLowerCase());

    if (kwNames.length === 0) {
      result[block.id] = -1;
      continue;
    }

    // Collect p_know values via keyword → subtopics → BKT states
    const pKnowValues = kwNames
      .flatMap((kwName) => kwToSubtopics.get(kwName) || [])
      .map((stId) => subtopicPKnow.get(stId))
      .filter((pk): pk is number => pk !== undefined);

    if (pKnowValues.length === 0) {
      result[block.id] = -1;
      continue;
    }

    const avg = pKnowValues.reduce((sum, v) => sum + v, 0) / pKnowValues.length;
    result[block.id] = Math.round(avg * 10000) / 10000;
  }

  return result;
}
