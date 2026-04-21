/**
 * block-flatten.ts — Convert summary blocks to markdown text
 *
 * flattenBlocksToMarkdown(blocks) → string
 *
 * Takes an array of summary_blocks rows and produces a single
 * markdown string suitable for embedding and RAG retrieval.
 *
 * Features:
 *   - Sorts by order_index
 *   - Per-type flatten logic for all 10 educational types
 *   - Legacy type support (text, heading)
 *   - Strips {{keyword}} markers
 *   - Blocks separated by \n\n---\n\n
 *   - Graceful fallback for unknown types (JSON.stringify)
 *   - Null/undefined content handling
 *
 * Fase 4, TASK_8
 */

// ─── Types ──────────────────────────────────────────────────────

interface Block {
  type: string;
  content: Record<string, unknown> | null | undefined;
  order_index: number;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Strip {{keyword}} markers → plain text.
 * "The {{sistema nervioso central}} is..." → "The sistema nervioso central is..."
 */
function stripKeywordMarkers(text: string): string {
  return text.replace(/\{\{([^}]+)\}\}/g, "$1");
}

/**
 * Strip HTML tags from legacy content.
 * "<p>Hello <strong>world</strong></p>" → "Hello world"
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Safe string accessor — handles null/undefined/non-string values.
 */
function str(val: unknown): string {
  if (val == null) return "";
  return String(val);
}

// ─── Per-Type Flatten Functions ─────────────────────────────────

// Canonical schema (per skills/crearresumen/references/block-content-schema.md)
// uses `content` for the main body text. Legacy generations wrote `body` or
// `text`. Read all three in priority order so both shapes round-trip correctly —
// without this fallback chain, the prose body in ~255/258 prose blocks + most
// callout + key_point blocks in prod silently dropped from the RAG index.
function proseBody(c: Record<string, unknown>): string {
  return stripKeywordMarkers(str(c.content ?? c.body ?? c.text));
}

function flattenProse(c: Record<string, unknown>): string {
  const title = str(c.title);
  return `## ${title}\n\n${proseBody(c)}`;
}

function flattenKeyPoint(c: Record<string, unknown>): string {
  const title = str(c.title);
  const importance = str(c.importance);
  return `CONCEPTO CLAVE (${importance}): ${title}\n\n${proseBody(c)}`;
}

function flattenStages(c: Record<string, unknown>): string {
  const title = str(c.title);
  // `items` is canonical; some blocks use `stages` alias.
  const rawItems = c.items ?? c.stages;
  const items = Array.isArray(rawItems)
    ? (rawItems as Array<Record<string, unknown>>)
    : [];
  const lines = items
    .filter((item) => item != null)
    .map((item) => {
      // Canonical: item.title + item.content. Legacy: item.label + item.description.
      const label = str(item.title ?? item.label);
      const desc = stripKeywordMarkers(str(item.content ?? item.description));
      return `- ${label}: ${desc}`;
    });
  return `## ${title}\n\n${lines.join("\n")}`;
}

function flattenComparison(c: Record<string, unknown>): string {
  const title = str(c.title);
  const headers = (c.headers as string[]) || [];
  const rows = (c.rows as string[][]) || [];

  if (headers.length === 0) return `## ${title}`;

  const headerLine = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const rowLines = rows
    .filter((row) => Array.isArray(row))
    .map((row) => `| ${row.join(" | ")} |`);

  return `## ${title}\n\n${headerLine}\n${separator}\n${rowLines.join("\n")}`;
}

function flattenListDetail(c: Record<string, unknown>): string {
  // Canonical schema also has `title`. Keep it in flatten output so RAG can
  // retrieve by section header, not just intro prose.
  const title = str(c.title);
  const intro = str(c.intro);
  const items = (c.items as Array<Record<string, unknown>>) || [];
  const lines = items.map((item) => {
    // Canonical schema uses {label, detail}. Legacy variant used {term, detail}.
    const term = str(item.label ?? item.term);
    const detail = stripKeywordMarkers(str(item.detail));
    return `- **${term}**: ${detail}`;
  });
  const headerParts: string[] = [];
  if (title) headerParts.push(`## ${title}`);
  if (intro) headerParts.push(intro);
  const header = headerParts.join("\n\n");
  return header ? `${header}\n\n${lines.join("\n")}` : lines.join("\n");
}

function flattenGrid(c: Record<string, unknown>): string {
  const title = str(c.title);
  const items = (c.items as Array<Record<string, unknown>>) || [];
  const lines = items.map((item) => {
    const label = str(item.label);
    const detail = str(item.detail);
    return `- **${label}**: ${detail}`;
  });
  return `## ${title}\n\n${lines.join("\n")}`;
}

function flattenTwoColumn(c: Record<string, unknown>): string {
  const title = str(c.title);

  // Canonical: c.columns is an array. Each column has {title, content_type,
  // items[] OR content}. Fall back to legacy {left, right} objects.
  const columns = Array.isArray(c.columns)
    ? (c.columns as Array<Record<string, unknown>>)
    : null;

  const parts: string[] = [];
  if (title) parts.push(`## ${title}`);

  if (columns) {
    for (const col of columns) {
      if (!col) continue;
      const colTitle = str(col.title);
      const colHeader = colTitle ? `### ${colTitle}` : "";

      if (Array.isArray(col.items)) {
        // content_type = "list_detail" style: iterate items
        const lines = (col.items as Array<Record<string, unknown>>)
          .filter((item) => item != null)
          .map((item) => {
            const label = str(item.label ?? item.term);
            const detail = stripKeywordMarkers(str(item.detail));
            return `- **${label}**: ${detail}`;
          });
        parts.push(colHeader ? `${colHeader}\n\n${lines.join("\n")}` : lines.join("\n"));
      } else {
        // content_type = "prose" style: body in col.content (canonical) or col.body (legacy)
        const colBody = stripKeywordMarkers(str(col.content ?? col.body));
        parts.push(colHeader ? `${colHeader}\n\n${colBody}` : colBody);
      }
    }
  } else {
    // Legacy shape: c.left + c.right objects with {title, body/content}
    const left = (c.left as Record<string, unknown>) || {};
    const right = (c.right as Record<string, unknown>) || {};
    const leftTitle = str(left.title);
    const leftBody = stripKeywordMarkers(str(left.content ?? left.body));
    const rightTitle = str(right.title);
    const rightBody = stripKeywordMarkers(str(right.content ?? right.body));
    parts.push(`### ${leftTitle}\n\n${leftBody}`);
    parts.push(`### ${rightTitle}\n\n${rightBody}`);
  }

  return parts.join("\n\n");
}

function flattenCallout(c: Record<string, unknown>): string {
  const variant = str(c.variant).toUpperCase();
  const title = str(c.title);
  const body = proseBody(c);

  if (title) {
    return `[${variant}] ${title}: ${body}`;
  }
  return `[${variant}] ${body}`;
}

function flattenImageReference(c: Record<string, unknown>): string {
  const alt = str(c.alt);
  const caption = str(c.caption);
  return `[Imagen: ${alt}] ${caption}`;
}

function flattenSectionDivider(c: Record<string, unknown>): string {
  const label = str(c.label);
  if (!label) return "";
  return `--- ${label} ---`;
}

// ─── Legacy Types ───────────────────────────────────────────────

function flattenLegacyText(c: Record<string, unknown>): string {
  const html = str(c.html);
  return stripHtml(html);
}

function flattenLegacyHeading(c: Record<string, unknown>): string {
  const text = str(c.text);
  const level = Number(c.level) || 2;
  const prefix = "#".repeat(Math.min(level, 6));
  return `${prefix} ${text}`;
}

// ─── Dispatcher ─────────────────────────────────────────────────

const FLATTEN_MAP: Record<string, (c: Record<string, unknown>) => string> = {
  prose: flattenProse,
  key_point: flattenKeyPoint,
  stages: flattenStages,
  comparison: flattenComparison,
  list_detail: flattenListDetail,
  grid: flattenGrid,
  two_column: flattenTwoColumn,
  callout: flattenCallout,
  image_reference: flattenImageReference,
  section_divider: flattenSectionDivider,
  // Legacy types
  text: flattenLegacyText,
  heading: flattenLegacyHeading,
};

function flattenBlock(block: Block): string {
  // Handle null/undefined content gracefully
  if (!block.content) return "";

  // Handle missing or empty type
  if (!block.type) return JSON.stringify(block.content);

  const fn = FLATTEN_MAP[block.type];
  if (fn) {
    return fn(block.content);
  }

  // Unknown type → JSON fallback
  return JSON.stringify(block.content);
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Convert an array of summary blocks to a single markdown string.
 *
 * - Sorts blocks by order_index
 * - Applies per-type flatten logic
 * - Strips {{keyword}} markers
 * - Separates blocks with \n\n---\n\n
 * - Returns empty string for empty/null input
 */
export function flattenBlocksToMarkdown(blocks: Block[]): string {
  if (!blocks || blocks.length === 0) return "";

  // Sort by order_index (ascending). Treat NaN/undefined as Infinity (end of list).
  const sorted = [...blocks].sort((a, b) => {
    const ai = Number.isFinite(a.order_index) ? a.order_index : Infinity;
    const bi = Number.isFinite(b.order_index) ? b.order_index : Infinity;
    return ai - bi;
  });

  // Flatten each block
  const parts = sorted
    .map(flattenBlock)
    .filter((s) => s.length > 0);

  if (parts.length === 0) return "";

  return parts.join("\n\n---\n\n");
}
