/**
 * tests/unit/e2e-block-processing.test.ts — 20 tests for block-flatten.ts
 *
 * Tests cover: all 10 educational block types, 2 legacy types, edge cases
 * (null content, unknown types, empty input), keyword marker stripping,
 * HTML sanitization, ordering, and separator formatting.
 *
 * ZERO dependency on db.ts — runs without env vars.
 * Run: deno test tests/unit/e2e-block-processing.test.ts --no-check
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

import { flattenBlocksToMarkdown } from "../../supabase/functions/server/block-flatten.ts";

// ═══ EMPTY INPUT ═══

Deno.test("flattenBlocksToMarkdown: empty array returns empty string", () => {
  assertEquals(flattenBlocksToMarkdown([]), "");
});

Deno.test("flattenBlocksToMarkdown: null/undefined input returns empty string", () => {
  assertEquals(flattenBlocksToMarkdown(null as unknown as []), "");
  assertEquals(flattenBlocksToMarkdown(undefined as unknown as []), "");
});

// ═══ NULL CONTENT ═══

Deno.test("flattenBlocksToMarkdown: block with null content is skipped", () => {
  const blocks = [
    { type: "prose", content: null, order_index: 0 },
    { type: "prose", content: { title: "Visible", body: "Content here" }, order_index: 1 },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.includes("Visible"), "Should include the non-null block");
  assert(!result.includes("null"), "Should not contain literal 'null'");
});

Deno.test("flattenBlocksToMarkdown: block with undefined content is skipped", () => {
  const blocks = [
    { type: "prose", content: undefined, order_index: 0 },
  ];
  assertEquals(flattenBlocksToMarkdown(blocks), "");
});

// ═══ PROSE TYPE ═══

Deno.test("flattenBlocksToMarkdown: prose type produces ## title and body", () => {
  const blocks = [{
    type: "prose",
    content: { title: "Mitosis", body: "La mitosis es un proceso de division celular." },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.startsWith("## Mitosis"), "Should start with h2 header");
  assert(result.includes("La mitosis es un proceso"), "Should include body text");
});

// ═══ KEY POINT TYPE ═══

Deno.test("flattenBlocksToMarkdown: key_point includes importance and title", () => {
  const blocks = [{
    type: "key_point",
    content: { title: "ATP", body: "La molecula de energia.", importance: "high" },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.includes("CONCEPTO CLAVE (high)"), "Should include importance label");
  assert(result.includes("ATP"), "Should include title");
  assert(result.includes("La molecula de energia"), "Should include body");
});

// ═══ STAGES TYPE ═══

Deno.test("flattenBlocksToMarkdown: stages type lists items with labels", () => {
  const blocks = [{
    type: "stages",
    content: {
      title: "Fases de la Mitosis",
      items: [
        { label: "Profase", description: "Los cromosomas se condensan." },
        { label: "Metafase", description: "Se alinean en el centro." },
      ],
    },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.includes("## Fases de la Mitosis"), "Should include title");
  assert(result.includes("- Profase: Los cromosomas se condensan."), "Should include stage items");
  assert(result.includes("- Metafase: Se alinean en el centro."), "Should include second item");
});

// ═══ COMPARISON TYPE (TABLE) ═══

Deno.test("flattenBlocksToMarkdown: comparison type produces markdown table", () => {
  const blocks = [{
    type: "comparison",
    content: {
      title: "Mitosis vs Meiosis",
      headers: ["Caracteristica", "Mitosis", "Meiosis"],
      rows: [
        ["Divisiones", "1", "2"],
        ["Resultado", "2 celulas", "4 celulas"],
      ],
    },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.includes("## Mitosis vs Meiosis"), "Should include title");
  assert(result.includes("| Caracteristica | Mitosis | Meiosis |"), "Should include header row");
  assert(result.includes("| --- | --- | --- |"), "Should include separator row");
  assert(result.includes("| Divisiones | 1 | 2 |"), "Should include data rows");
});

Deno.test("flattenBlocksToMarkdown: comparison with empty headers returns title only", () => {
  const blocks = [{
    type: "comparison",
    content: { title: "Empty Comparison", headers: [], rows: [] },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assertEquals(result, "## Empty Comparison");
});

// ═══ LIST DETAIL TYPE ═══

Deno.test("flattenBlocksToMarkdown: list_detail produces bold terms with details", () => {
  const blocks = [{
    type: "list_detail",
    content: {
      intro: "Organelos principales:",
      items: [
        { term: "Mitocondria", detail: "Produce ATP" },
        { term: "Ribosoma", detail: "Sintetiza proteinas" },
      ],
    },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.includes("Organelos principales:"), "Should include intro");
  assert(result.includes("- **Mitocondria**: Produce ATP"), "Should format as bold term");
  assert(result.includes("- **Ribosoma**: Sintetiza proteinas"), "Should include all items");
});

// ═══ TWO COLUMN TYPE ═══

Deno.test("flattenBlocksToMarkdown: two_column produces h3 headers for left and right", () => {
  const blocks = [{
    type: "two_column",
    content: {
      left: { title: "Procariota", body: "Sin nucleo" },
      right: { title: "Eucariota", body: "Con nucleo" },
    },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.includes("### Procariota"), "Should have left h3 header");
  assert(result.includes("### Eucariota"), "Should have right h3 header");
  assert(result.includes("Sin nucleo"), "Should include left body");
  assert(result.includes("Con nucleo"), "Should include right body");
});

// ═══ CALLOUT TYPE ═══

Deno.test("flattenBlocksToMarkdown: callout includes variant and body", () => {
  const blocks = [{
    type: "callout",
    content: { variant: "warning", title: "Importante", body: "No confundir mitosis con meiosis." },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.includes("[WARNING]"), "Should include uppercase variant");
  assert(result.includes("Importante:"), "Should include title");
  assert(result.includes("No confundir"), "Should include body");
});

Deno.test("flattenBlocksToMarkdown: callout without title omits colon", () => {
  const blocks = [{
    type: "callout",
    content: { variant: "info", title: "", body: "Nota breve." },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assertEquals(result, "[INFO] Nota breve.");
});

// ═══ IMAGE REFERENCE TYPE ═══

Deno.test("flattenBlocksToMarkdown: image_reference produces alt and caption", () => {
  const blocks = [{
    type: "image_reference",
    content: { alt: "Diagrama de celula", caption: "Figura 1: Estructura celular" },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.includes("[Imagen: Diagrama de celula]"), "Should include alt text");
  assert(result.includes("Figura 1: Estructura celular"), "Should include caption");
});

// ═══ SECTION DIVIDER TYPE ═══

Deno.test("flattenBlocksToMarkdown: section_divider with label", () => {
  const blocks = [{
    type: "section_divider",
    content: { label: "Parte 2" },
    order_index: 0,
  }];
  assertEquals(flattenBlocksToMarkdown(blocks), "--- Parte 2 ---");
});

Deno.test("flattenBlocksToMarkdown: section_divider without label is skipped", () => {
  const blocks = [{
    type: "section_divider",
    content: { label: "" },
    order_index: 0,
  }];
  assertEquals(flattenBlocksToMarkdown(blocks), "");
});

// ═══ KEYWORD MARKER STRIPPING ═══

Deno.test("flattenBlocksToMarkdown: strips {{keyword}} markers from prose body", () => {
  const blocks = [{
    type: "prose",
    content: { title: "Tema", body: "El {{sistema nervioso central}} controla el {{cerebro}}." },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assert(!result.includes("{{"), "Should not contain {{ markers");
  assert(!result.includes("}}"), "Should not contain }} markers");
  assert(result.includes("sistema nervioso central"), "Should preserve keyword text");
  assert(result.includes("cerebro"), "Should preserve keyword text");
});

// ═══ LEGACY HTML STRIPPING ═══

Deno.test("flattenBlocksToMarkdown: legacy text type strips HTML tags", () => {
  const blocks = [{
    type: "text",
    content: { html: "<p>Hello <strong>world</strong></p><br/><p>Second paragraph</p>" },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assert(!result.includes("<p>"), "Should not contain HTML tags");
  assert(!result.includes("<strong>"), "Should not contain HTML tags");
  assert(result.includes("Hello world"), "Should preserve text content");
  assert(result.includes("Second paragraph"), "Should preserve second paragraph");
});

// ═══ ORDERING ═══

Deno.test("flattenBlocksToMarkdown: sorts by order_index ascending", () => {
  const blocks = [
    { type: "prose", content: { title: "Third", body: "C" }, order_index: 2 },
    { type: "prose", content: { title: "First", body: "A" }, order_index: 0 },
    { type: "prose", content: { title: "Second", body: "B" }, order_index: 1 },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  const firstIdx = result.indexOf("First");
  const secondIdx = result.indexOf("Second");
  const thirdIdx = result.indexOf("Third");
  assert(firstIdx < secondIdx, "First should come before Second");
  assert(secondIdx < thirdIdx, "Second should come before Third");
});

// ═══ UNKNOWN TYPE FALLBACK ═══

Deno.test("flattenBlocksToMarkdown: unknown type falls back to JSON.stringify", () => {
  const blocks = [{
    type: "future_type",
    content: { data: "test" },
    order_index: 0,
  }];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.includes('"data"'), "Should JSON stringify unknown type content");
  assert(result.includes('"test"'), "Should include content values");
});

// ═══ SEPARATOR ═══

Deno.test("flattenBlocksToMarkdown: multiple blocks separated by \\n\\n---\\n\\n", () => {
  const blocks = [
    { type: "prose", content: { title: "A", body: "First" }, order_index: 0 },
    { type: "prose", content: { title: "B", body: "Second" }, order_index: 1 },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.includes("\n\n---\n\n"), "Blocks should be separated by ---");
  const parts = result.split("\n\n---\n\n");
  assertEquals(parts.length, 2, "Should produce exactly 2 parts");
});
