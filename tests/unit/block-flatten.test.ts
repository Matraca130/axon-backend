/**
 * tests/unit/block-flatten.test.ts — 24 tests for flattenBlocksToMarkdown()
 */

import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { flattenBlocksToMarkdown } from "../../supabase/functions/server/block-flatten.ts";

interface Block {
  type: string;
  content: Record<string, unknown> | null | undefined;
  order_index: number;
}

Deno.test("B01 · prose: title as ## heading with body", () => {
  const blocks: Block[] = [
    {
      type: "prose",
      content: {
        title: "Introduction",
        body: "This is the introduction paragraph with key concepts.",
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "## Introduction");
  assertStringIncludes(result, "introduction paragraph");
});

Deno.test("B02 · prose: strips {{keyword}} markers", () => {
  const blocks: Block[] = [
    {
      type: "prose",
      content: {
        title: "Anatomy",
        body: "The {{nervous system}} includes the {{brain}} and spinal cord.",
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "nervous system");
  assertStringIncludes(result, "brain");
  assert(!result.includes("{{"), "Should not have {{ markers");
  assert(!result.includes("}}"), "Should not have }} markers");
});

Deno.test("B03 · key_point: includes CONCEPTO CLAVE + importance", () => {
  const blocks: Block[] = [
    {
      type: "key_point",
      content: {
        title: "Synapsis",
        body: "Neural connection point",
        importance: "critical",
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "CONCEPTO CLAVE");
  assertStringIncludes(result, "critical");
  assertStringIncludes(result, "Synapsis");
});

Deno.test("B04 · stages: creates bullet list from items", () => {
  const blocks: Block[] = [
    {
      type: "stages",
      content: {
        title: "Development Phases",
        items: [
          { label: "Phase 1", description: "Early stage" },
          { label: "Phase 2", description: "Middle stage" },
          { label: "Phase 3", description: "Final stage" },
        ],
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "## Development Phases");
  assertStringIncludes(result, "- Phase 1: Early stage");
  assertStringIncludes(result, "- Phase 2: Middle stage");
  assertStringIncludes(result, "- Phase 3: Final stage");
});

Deno.test("B05 · stages: handles empty items array", () => {
  const blocks: Block[] = [
    {
      type: "stages",
      content: {
        title: "Empty Stages",
        items: [],
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "## Empty Stages");
});

Deno.test("B06 · comparison: creates markdown table", () => {
  const blocks: Block[] = [
    {
      type: "comparison",
      content: {
        title: "Comparison Table",
        headers: ["Item", "Feature A", "Feature B"],
        rows: [
          ["Item 1", "Yes", "No"],
          ["Item 2", "No", "Yes"],
        ],
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "## Comparison Table");
  assertStringIncludes(result, "| Item |");
  assertStringIncludes(result, "| Feature A |");
  assertStringIncludes(result, "---");
  assertStringIncludes(result, "Item 1");
});

Deno.test("B07 · list_detail: creates term-detail pairs", () => {
  const blocks: Block[] = [
    {
      type: "list_detail",
      content: {
        intro: "Key terms:",
        items: [
          { term: "Dopamine", detail: "Pleasure neurotransmitter" },
          { term: "Serotonin", detail: "Mood regulator" },
        ],
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "Key terms:");
  assertStringIncludes(result, "- **Dopamine**: Pleasure neurotransmitter");
  assertStringIncludes(result, "- **Serotonin**: Mood regulator");
});

Deno.test("B08 · grid: formats items with label and detail", () => {
  const blocks: Block[] = [
    {
      type: "grid",
      content: {
        title: "Brain Regions",
        items: [
          { label: "Frontal", detail: "Executive function" },
          { label: "Temporal", detail: "Memory" },
        ],
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "## Brain Regions");
  assertStringIncludes(result, "- **Frontal**: Executive function");
  assertStringIncludes(result, "- **Temporal**: Memory");
});

Deno.test("B09 · two_column: renders both left and right sections", () => {
  const blocks: Block[] = [
    {
      type: "two_column",
      content: {
        left: {
          title: "Left Column",
          body: "Left content here",
        },
        right: {
          title: "Right Column",
          body: "Right content here",
        },
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "### Left Column");
  assertStringIncludes(result, "Left content here");
  assertStringIncludes(result, "### Right Column");
  assertStringIncludes(result, "Right content here");
});

Deno.test("B10 · callout: includes variant + title + body", () => {
  const blocks: Block[] = [
    {
      type: "callout",
      content: {
        variant: "warning",
        title: "Important Note",
        body: "This is important information",
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "[WARNING]");
  assertStringIncludes(result, "Important Note");
  assertStringIncludes(result, "This is important information");
});

Deno.test("B11 · callout: handles missing title", () => {
  const blocks: Block[] = [
    {
      type: "callout",
      content: {
        variant: "info",
        title: "",
        body: "Information without title",
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "[INFO]");
  assertStringIncludes(result, "Information without title");
});

Deno.test("B12 · image_reference: shows alt text and caption", () => {
  const blocks: Block[] = [
    {
      type: "image_reference",
      content: {
        alt: "Brain diagram",
        caption: "Anatomical view of the brain",
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "[Imagen: Brain diagram]");
  assertStringIncludes(result, "Anatomical view of the brain");
});

Deno.test("B13 · section_divider: shows label with dashes", () => {
  const blocks: Block[] = [
    {
      type: "section_divider",
      content: {
        label: "New Section",
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "--- New Section ---");
});

Deno.test("B14 · section_divider: empty label returns empty string", () => {
  const blocks: Block[] = [
    {
      type: "section_divider",
      content: {
        label: "",
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertEquals(result, "");
});

Deno.test("B15 · legacy text: strips HTML tags", () => {
  const blocks: Block[] = [
    {
      type: "text",
      content: {
        html: "<p>This is <strong>bold</strong> text</p><p>Second paragraph</p>",
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "This is bold text");
  assertStringIncludes(result, "Second paragraph");
  assert(!result.includes("<"), "Should not contain HTML tags");
});

Deno.test("B16 · legacy heading: formats with hashes", () => {
  const blocks: Block[] = [
    {
      type: "heading",
      content: {
        text: "My Heading",
        level: 2,
      },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "## My Heading");
});

Deno.test("B17 · multiple blocks separated by ---", () => {
  const blocks: Block[] = [
    {
      type: "prose",
      content: { title: "Block 1", body: "Content 1" },
      order_index: 0,
    },
    {
      type: "key_point",
      content: { title: "Block 2", body: "Content 2", importance: "high" },
      order_index: 1,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "---");
  assertStringIncludes(result, "Block 1");
  assertStringIncludes(result, "Block 2");
});

Deno.test("B18 · respects order_index sorting", () => {
  const blocks: Block[] = [
    {
      type: "prose",
      content: { title: "Third", body: "third" },
      order_index: 2,
    },
    {
      type: "prose",
      content: { title: "First", body: "first" },
      order_index: 0,
    },
    {
      type: "prose",
      content: { title: "Second", body: "second" },
      order_index: 1,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  const pos1 = result.indexOf("## First");
  const pos2 = result.indexOf("## Second");
  const pos3 = result.indexOf("## Third");
  assert(pos1 < pos2 && pos2 < pos3, "Should be sorted by order_index");
});

Deno.test("B19 · empty array returns empty string", () => {
  const result = flattenBlocksToMarkdown([]);
  assertEquals(result, "");
});

Deno.test("B20 · null content handled gracefully", () => {
  const blocks: Block[] = [
    {
      type: "prose",
      content: null,
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assert(typeof result === "string", "Should return a string");
});

Deno.test("B21 · unknown type uses JSON fallback", () => {
  const blocks: Block[] = [
    {
      type: "custom_type",
      content: { foo: "bar", baz: 123 },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "bar");
  assertStringIncludes(result, "123");
});

Deno.test("B22 · NaN order_index sorts to end", () => {
  const blocks: Block[] = [
    {
      type: "prose",
      content: { title: "NaN", body: "nan" },
      order_index: NaN,
    },
    {
      type: "prose",
      content: { title: "Zero", body: "zero" },
      order_index: 0,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  const zeroPos = result.indexOf("## Zero");
  const nanPos = result.indexOf("## NaN");
  assert(zeroPos < nanPos, "NaN order_index should sort to end");
});

Deno.test("B23 · mixed legacy and modern types", () => {
  const blocks: Block[] = [
    {
      type: "prose",
      content: { title: "Modern", body: "modern content" },
      order_index: 0,
    },
    {
      type: "text",
      content: { html: "<p>Legacy content</p>" },
      order_index: 1,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assertStringIncludes(result, "Modern");
  assertStringIncludes(result, "Legacy content");
});

Deno.test("B24 · all block types in single document", () => {
  const blocks: Block[] = [
    {
      type: "prose",
      content: { title: "Intro", body: "Introduction" },
      order_index: 0,
    },
    {
      type: "key_point",
      content: { title: "Key", body: "Key content", importance: "high" },
      order_index: 1,
    },
    {
      type: "comparison",
      content: {
        title: "Comparison",
        headers: ["A", "B"],
        rows: [["1", "2"]],
      },
      order_index: 2,
    },
    {
      type: "callout",
      content: { variant: "warning", title: "Note", body: "Important" },
      order_index: 3,
    },
  ];
  const result = flattenBlocksToMarkdown(blocks);
  assert(result.length > 100, "Should produce substantial output");
  assert(result.includes("---"), "Should have separators");
  assertStringIncludes(result, "Intro");
  assertStringIncludes(result, "Key");
  assertStringIncludes(result, "Comparison");
  assertStringIncludes(result, "[WARNING]");
});
