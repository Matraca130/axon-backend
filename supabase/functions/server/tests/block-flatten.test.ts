/**
 * block-flatten.test.ts — 29 tests for flattenBlocksToMarkdown()
 *
 * TDD Red Phase: these tests are written BEFORE block-flatten.ts exists.
 * The import is commented out until TASK_8 creates the implementation.
 *
 * Run: deno test supabase/functions/server/tests/block-flatten.test.ts --allow-env --allow-net --allow-read
 *
 * Fase 4, TASK_2
 */

import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { BLOCKS, makeBlockList } from "./block-fixtures.ts";
import type { TestBlock } from "./block-fixtures.ts";

import { flattenBlocksToMarkdown } from "../block-flatten.ts";

// ═══════════════════════════════════════════════════════════════
// 1. Prose
// ═══════════════════════════════════════════════════════════════

Deno.test("T01 · prose: title as ## heading + body content", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("prose"));
  assertStringIncludes(result, "## Anatomía del SNC");
  assertStringIncludes(result, "médula espinal");
});

Deno.test("T02 · prose: strips {{keyword}} markers", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("prose"));
  assertStringIncludes(result, "sistema nervioso central");
  assertStringIncludes(result, "encéfalo");
  assert(!result.includes("{{"), "Should not contain opening {{ markers");
  assert(!result.includes("}}"), "Should not contain closing }} markers");
});

// ═══════════════════════════════════════════════════════════════
// 2. Key Point
// ═══════════════════════════════════════════════════════════════

Deno.test("T03 · key_point: includes CONCEPTO CLAVE + importance", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("key_point"));
  assertStringIncludes(result, "CONCEPTO CLAVE");
  assertStringIncludes(result, "critical");
  assertStringIncludes(result, "Sinapsis Neuronal");
});

// ═══════════════════════════════════════════════════════════════
// 3. Stages
// ═══════════════════════════════════════════════════════════════

Deno.test("T04 · stages: lists items with numbers", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("stages"));
  assertStringIncludes(result, "Mielinización");
  assertStringIncludes(result, "Fase 1");
  assertStringIncludes(result, "Fase 2");
  assertStringIncludes(result, "Fase 3");
});

Deno.test("T05 · stages: strips {{keyword}} markers in item descriptions", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("stages"));
  assertStringIncludes(result, "oligodendrocitos");
  assert(!result.includes("{{"), "Should not contain {{ markers");
  assert(!result.includes("}}"), "Should not contain }} markers");
});

// ═══════════════════════════════════════════════════════════════
// 4. Comparison
// ═══════════════════════════════════════════════════════════════

Deno.test("T06 · comparison: headers and rows pipe-separated", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("comparison"));
  assertStringIncludes(result, "SNC vs SNP");
  assertStringIncludes(result, "Característica");
  assertStringIncludes(result, "|");
  assertStringIncludes(result, "Oligodendrocitos");
});

// ═══════════════════════════════════════════════════════════════
// 5. List Detail
// ═══════════════════════════════════════════════════════════════

Deno.test("T07 · list_detail: intro + items with bullet", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("list_detail"));
  assertStringIncludes(result, "neurotransmisores");
  assertStringIncludes(result, "Dopamina");
  assertStringIncludes(result, "Regula el placer");
});

// ═══════════════════════════════════════════════════════════════
// 6. Grid
// ═══════════════════════════════════════════════════════════════

Deno.test("T08 · grid: items with label + detail", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("grid"));
  assertStringIncludes(result, "Lóbulos Cerebrales");
  assertStringIncludes(result, "Frontal");
  assertStringIncludes(result, "Funciones ejecutivas");
  assertStringIncludes(result, "Occipital");
});

// ═══════════════════════════════════════════════════════════════
// 7. Two Column
// ═══════════════════════════════════════════════════════════════

Deno.test("T09 · two_column: both columns present", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("two_column"));
  assertStringIncludes(result, "Neurona Motora");
  assertStringIncludes(result, "Neurona Sensorial");
  assertStringIncludes(result, "SNC hacia los músculos");
  assertStringIncludes(result, "receptores sensoriales");
});

// ═══════════════════════════════════════════════════════════════
// 8. Callout
// ═══════════════════════════════════════════════════════════════

Deno.test("T10 · callout tip: includes [TIP] + content", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("callout_tip"));
  assertStringIncludes(result, "[TIP]");
  assertStringIncludes(result, "esclerosis múltiple");
});

Deno.test("T11 · callout without title: does not crash", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("callout_no_title"));
  assertStringIncludes(result, "pares craneales");
});

// ═══════════════════════════════════════════════════════════════
// 9. Image Reference
// ═══════════════════════════════════════════════════════════════

Deno.test("T12 · image_reference: placeholder text", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("image_reference"));
  assertStringIncludes(result, "neurona");
  // Should have some kind of image placeholder marker
  assert(
    result.includes("[Imagen") || result.includes("[Image"),
    "Should contain image placeholder marker",
  );
});

// ═══════════════════════════════════════════════════════════════
// 10. Section Divider
// ═══════════════════════════════════════════════════════════════

Deno.test("T13 · section_divider with label", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("section_divider"));
  assertStringIncludes(result, "Médula Espinal");
});

Deno.test("T14 · section_divider empty → empty string", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("section_divider_empty"));
  assertEquals(result.trim(), "");
});

// ═══════════════════════════════════════════════════════════════
// 11. Legacy Types
// ═══════════════════════════════════════════════════════════════

Deno.test("T15 · legacy text: strips HTML tags", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("legacy_text"));
  assertStringIncludes(result, "texto legado");
  assertStringIncludes(result, "Segundo párrafo");
  assert(!result.includes("<strong>"), "Should not contain HTML tags");
  assert(!result.includes("<em>"), "Should not contain HTML tags");
  assert(!result.includes("<p>"), "Should not contain HTML tags");
});

Deno.test("T16 · legacy heading: produces text", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("legacy_heading"));
  assertStringIncludes(result, "Título Legado del Resumen");
});

// ═══════════════════════════════════════════════════════════════
// 12. Multiple Blocks + Ordering
// ═══════════════════════════════════════════════════════════════

Deno.test("T17 · multiple blocks separated by ---", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("prose", "key_point", "grid"));
  assertStringIncludes(result, "---");
  // All three block contents should be present
  assertStringIncludes(result, "Anatomía del SNC");
  assertStringIncludes(result, "CONCEPTO CLAVE");
  assertStringIncludes(result, "Lóbulos Cerebrales");
});

Deno.test("T18 · respects order_index sorting (reversed input → sorted output)", () => {
  // Create blocks with reversed order_index
  const blocks: TestBlock[] = [
    { ...BLOCKS.grid, order_index: 2 },
    { ...BLOCKS.prose, order_index: 0 },
    { ...BLOCKS.key_point, order_index: 1 },
  ];
  const result = flattenBlocksToMarkdown(blocks);

  // Prose (idx 0) should appear before key_point (idx 1) before grid (idx 2)
  const prosePos = result.indexOf("Anatomía del SNC");
  const keyPointPos = result.indexOf("CONCEPTO CLAVE");
  const gridPos = result.indexOf("Lóbulos Cerebrales");

  assert(prosePos < keyPointPos, "Prose (idx 0) should come before key_point (idx 1)");
  assert(keyPointPos < gridPos, "key_point (idx 1) should come before grid (idx 2)");
});

// ═══════════════════════════════════════════════════════════════
// 13. Edge Cases
// ═══════════════════════════════════════════════════════════════

Deno.test("T19 · empty array → empty string", () => {
  const result = flattenBlocksToMarkdown([]);
  assertEquals(result, "");
});

Deno.test("T20 · unknown block type → JSON.stringify fallback", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("unknown_type"));
  // Should not crash, and should contain something from the content
  assertStringIncludes(result, "bar");
});

Deno.test("T21 · content null/undefined → does not crash", () => {
  // Both null_content and undefined_content should be handled gracefully
  const result1 = flattenBlocksToMarkdown(makeBlockList("null_content"));
  assert(typeof result1 === "string", "Should return a string for null content");

  const result2 = flattenBlocksToMarkdown(makeBlockList("undefined_content"));
  assert(typeof result2 === "string", "Should return a string for undefined content");
});

// ═══════════════════════════════════════════════════════════════
// 14. Additional Edge Cases (REVIEW_8)
// ═══════════════════════════════════════════════════════════════

Deno.test("T23 · empty content object → does not crash", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("empty_content"));
  assert(typeof result === "string", "Should return a string for empty content");
});

Deno.test("T24 · empty type string → JSON fallback", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("empty_type"));
  assertStringIncludes(result, "test");
});

Deno.test("T25 · comparison with empty headers/rows → no crash", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("comparison_empty"));
  assertStringIncludes(result, "Empty Table");
});

Deno.test("T26 · stages with empty items → no crash", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("stages_empty_items"));
  assertStringIncludes(result, "Empty Stages");
});

Deno.test("T27 · stages with null item in array → filters gracefully", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("stages_null_item"));
  assertStringIncludes(result, "Valid");
});

Deno.test("T28 · mixed legacy + edu types in same array", () => {
  const result = flattenBlocksToMarkdown(
    makeBlockList("prose", "mixed_legacy_edu", "key_point"),
  );
  assertStringIncludes(result, "Anatomía del SNC");
  assertStringIncludes(result, "Legacy mixed with edu");
  assertStringIncludes(result, "CONCEPTO CLAVE");
});

Deno.test("T29 · block with NaN order_index → sorted to end", () => {
  const blocks: TestBlock[] = [
    { ...BLOCKS.prose, order_index: NaN },
    { ...BLOCKS.key_point, order_index: 0 },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  const keyPointPos = result.indexOf("CONCEPTO CLAVE");
  const prosePos = result.indexOf("Anatomía del SNC");
  assert(keyPointPos < prosePos, "NaN order_index should sort to end");
});

Deno.test("T22 · realistic full summary (9 blocks, >200 chars, no {{ }})", () => {
  const result = flattenBlocksToMarkdown(
    makeBlockList(
      "prose",
      "key_point",
      "stages",
      "comparison",
      "list_detail",
      "grid",
      "two_column",
      "callout_tip",
      "image_reference",
    ),
  );

  assert(result.length > 200, `Expected >200 chars, got ${result.length}`);
  assert(!result.includes("{{"), "Should not contain {{ markers");
  assert(!result.includes("}}"), "Should not contain }} markers");

  // Verify key content from various blocks is present
  assertStringIncludes(result, "Anatomía del SNC");
  assertStringIncludes(result, "CONCEPTO CLAVE");
  assertStringIncludes(result, "Mielinización");
  assertStringIncludes(result, "SNC vs SNP");
  assertStringIncludes(result, "Dopamina");
  assertStringIncludes(result, "Lóbulos Cerebrales");
  assertStringIncludes(result, "Neurona Motora");
  assertStringIncludes(result, "esclerosis múltiple");
});

// ═══════════════════════════════════════════════════════════════
// Canonical schema — guards against block-flatten.ts drifting
// from the shape defined in
// skills/crearresumen/references/block-content-schema.md
//
// Before these tests landed, flattenProse/KeyPoint/Callout all read
// `c.body` but the real prod schema (255/258 prose blocks) uses
// `c.content`. The body text silently disappeared from every chunk
// that powers RAG retrieval.
// ═══════════════════════════════════════════════════════════════

Deno.test("C01 · prose canonical: body text appears in output", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("prose_canonical"));
  assertStringIncludes(result, "## Anatomía del SNC");
  assertStringIncludes(result, "médula espinal");
  assertStringIncludes(result, "señales eléctricas");
  assert(!result.includes("{{"), "keyword markers should be stripped");
});

Deno.test("C02 · key_point canonical: body text appears in output", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("key_point_canonical"));
  assertStringIncludes(result, "CONCEPTO CLAVE (critical)");
  assertStringIncludes(result, "Sinapsis Neuronal");
  assertStringIncludes(result, "punto de comunicación entre dos neuronas");
});

Deno.test("C03 · callout canonical: body text appears in output", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("callout_canonical"));
  assertStringIncludes(result, "[CLINICAL]");
  assertStringIncludes(result, "Dato Clínico");
  assertStringIncludes(result, "desmielinización del SNC");
  assert(!result.includes("{{"), "keyword markers should be stripped from callout");
});

Deno.test("C04 · stages canonical: item titles + content appear", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("stages_canonical"));
  assertStringIncludes(result, "## Proceso de Mielinización");
  // item.title + item.content (canonical), not item.label + item.description (legacy)
  assertStringIncludes(result, "Proliferación");
  assertStringIncludes(result, "oligodendrocitos");
  assertStringIncludes(result, "Envolvimiento");
  assertStringIncludes(result, "vaina de mielina");
  assertStringIncludes(result, "Compactación");
  assert(!result.includes("{{"), "keyword markers should be stripped from stages");
});

Deno.test("C05 · two_column canonical (prose): iterates c.columns[]", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("two_column_canonical_prose"));
  assertStringIncludes(result, "Vías de conducción");
  assertStringIncludes(result, "### Neurona Motora");
  assertStringIncludes(result, "músculos y glándulas");
  assertStringIncludes(result, "### Neurona Sensorial");
  assertStringIncludes(result, "receptores sensoriales");
});

Deno.test("C06 · two_column canonical (list_detail): iterates column.items[]", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("two_column_canonical_list"));
  assertStringIncludes(result, "## Sistema Autónomo");
  assertStringIncludes(result, "### Sistema Simpático");
  assertStringIncludes(result, "Midriasis");
  assertStringIncludes(result, "### Sistema Parasimpático");
  assertStringIncludes(result, "Miosis");
});

Deno.test("C07 · list_detail canonical: title + intro + items with keyword stripping", () => {
  const result = flattenBlocksToMarkdown(makeBlockList("list_detail_canonical"));
  assertStringIncludes(result, "## Neurotransmisores");
  assertStringIncludes(result, "principales neurotransmisores incluyen");
  assertStringIncludes(result, "**Dopamina**");
  assertStringIncludes(result, "placer");
  assert(!result.includes("{{"), "keyword markers should be stripped from list_detail");
});

Deno.test("C08 · canonical mixed bag: full summary content survives flattening", () => {
  const result = flattenBlocksToMarkdown(
    makeBlockList(
      "prose_canonical",
      "key_point_canonical",
      "stages_canonical",
      "two_column_canonical_prose",
      "callout_canonical",
    ),
  );
  assert(result.length > 500, `Expected >500 chars for 5 canonical blocks, got ${result.length}`);
  // Body text from every block must be reachable by RAG
  assertStringIncludes(result, "señales eléctricas");
  assertStringIncludes(result, "punto de comunicación");
  assertStringIncludes(result, "vaina de mielina");
  assertStringIncludes(result, "músculos y glándulas");
  assertStringIncludes(result, "desmielinización del SNC");
});
