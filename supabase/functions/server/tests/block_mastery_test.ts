/**
 * block_mastery_test.ts — Tests for block mastery calculation logic.
 *
 * Imports extractKeywordsFromBlock and calculateBlockMastery from
 * the shared lib/block-keywords.ts — tests the REAL production code,
 * not a duplicate.
 *
 * Run: deno test --allow-none block_mastery_test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractKeywordsFromBlock,
  calculateBlockMastery,
} from "../lib/block-keywords.ts";

// ─── extractKeywordsFromBlock tests ────────────────────────────────

Deno.test("extractKeywordsFromBlock — prose block extracts from body", () => {
  const block = {
    type: "prose",
    content: { body: "The {{Mitosis}} process involves {{Cell Division}}" },
  };
  const result = extractKeywordsFromBlock(block);
  assertEquals(result, ["Mitosis", "Cell Division"]);
});

Deno.test("extractKeywordsFromBlock — key_point scans title and explanation", () => {
  const block = {
    type: "key_point",
    content: {
      title: "About {{ATP}}",
      explanation: "{{ATP}} is the energy currency of {{Cells}}",
    },
  };
  const result = extractKeywordsFromBlock(block);
  assertEquals(result, ["ATP", "ATP", "Cells"]);
});

Deno.test("extractKeywordsFromBlock — callout scans title and body", () => {
  const block = {
    type: "callout",
    content: { title: "Note: {{DNA}}", body: "Remember {{RNA}} too" },
  };
  const result = extractKeywordsFromBlock(block);
  assertEquals(result, ["DNA", "RNA"]);
});

Deno.test("extractKeywordsFromBlock — two_column scans left and right", () => {
  const block = {
    type: "two_column",
    content: { left: "{{Prokaryote}}", right: "{{Eukaryote}}" },
  };
  const result = extractKeywordsFromBlock(block);
  assertEquals(result, ["Prokaryote", "Eukaryote"]);
});

Deno.test("extractKeywordsFromBlock — stages scans title and description", () => {
  const block = {
    type: "stages",
    content: {
      stages: [
        { title: "{{Prophase}}", description: "Chromosomes condense" },
        { title: "{{Metaphase}}", description: "Align at {{Equator}}" },
      ],
    },
  };
  const result = extractKeywordsFromBlock(block);
  assertEquals(result, ["Prophase", "Metaphase", "Equator"]);
});

Deno.test("extractKeywordsFromBlock — list_detail scans items title and detail", () => {
  const block = {
    type: "list_detail",
    content: {
      items: [
        { title: "{{Mitosis}}", detail: "Cell division for growth" },
        { title: "{{Meiosis}}", detail: "Produces {{Gametes}}" },
      ],
    },
  };
  const result = extractKeywordsFromBlock(block);
  assertEquals(result, ["Mitosis", "Meiosis", "Gametes"]);
});

Deno.test("extractKeywordsFromBlock — comparison scans items", () => {
  const block = {
    type: "comparison",
    content: {
      items: [
        { title: "{{DNA}}", description: "Double-stranded" },
        { title: "{{RNA}}", description: "Single-stranded" },
      ],
    },
  };
  const result = extractKeywordsFromBlock(block);
  assertEquals(result, ["DNA", "RNA"]);
});

Deno.test("extractKeywordsFromBlock — grid scans cells", () => {
  const block = {
    type: "grid",
    content: {
      cells: [
        { title: "{{Nucleus}}", body: "Contains {{DNA}}" },
        { title: "{{Ribosome}}", body: "Makes {{Proteins}}" },
      ],
    },
  };
  const result = extractKeywordsFromBlock(block);
  assertEquals(result, ["Nucleus", "DNA", "Ribosome", "Proteins"]);
});

Deno.test("extractKeywordsFromBlock — heading scans text", () => {
  const block = {
    type: "heading",
    content: { text: "Chapter: {{Cell Biology}}" },
  };
  const result = extractKeywordsFromBlock(block);
  assertEquals(result, ["Cell Biology"]);
});

Deno.test("extractKeywordsFromBlock — no markers returns empty array", () => {
  const block = {
    type: "prose",
    content: { body: "Just plain text without any markers" },
  };
  const result = extractKeywordsFromBlock(block);
  assertEquals(result, []);
});

Deno.test("extractKeywordsFromBlock — unknown type scans common fields", () => {
  const block = {
    type: "custom_unknown",
    content: { body: "{{SomeKeyword}}", title: "{{Another}}" },
  };
  const result = extractKeywordsFromBlock(block);
  assertEquals(result, ["SomeKeyword", "Another"]);
});

// ─── calculateBlockMastery tests ──────────────────────────────────

Deno.test("calculateBlockMastery — happy path: blocks with keywords and BKT data", () => {
  const blocks = [
    { id: "b1", type: "prose", content: { body: "Learn about {{Mitosis}} and {{Meiosis}}" } },
    { id: "b2", type: "heading", content: { text: "{{DNA}} Structure" } },
  ];

  const kwToSubtopics = new Map<string, string[]>([
    ["mitosis", ["st1"]],
    ["meiosis", ["st2"]],
    ["dna", ["st3"]],
  ]);

  const subtopicPKnow = new Map<string, number>([
    ["st1", 0.8],
    ["st2", 0.6],
    ["st3", 0.9],
  ]);

  const result = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);
  // b1: avg(0.8, 0.6) = 0.7
  assertEquals(result["b1"], 0.7);
  // b2: avg(0.9) = 0.9
  assertEquals(result["b2"], 0.9);
});

Deno.test("calculateBlockMastery — empty blocks → empty object", () => {
  const result = calculateBlockMastery([], new Map(), new Map());
  assertEquals(result, {});
});

Deno.test("calculateBlockMastery — block without keywords → mastery -1", () => {
  const blocks = [
    { id: "b1", type: "prose", content: { body: "No keywords here" } },
  ];
  const result = calculateBlockMastery(blocks, new Map(), new Map());
  assertEquals(result["b1"], -1);
});

Deno.test("calculateBlockMastery — block with keywords but no BKT data → mastery -1", () => {
  const blocks = [
    { id: "b1", type: "prose", content: { body: "About {{Mitosis}}" } },
  ];
  const kwToSubtopics = new Map<string, string[]>([["mitosis", ["st1"]]]);
  const subtopicPKnow = new Map<string, number>();

  const result = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);
  assertEquals(result["b1"], -1);
});

Deno.test("calculateBlockMastery — keyword with no matching subtopics → mastery -1", () => {
  const blocks = [
    { id: "b1", type: "prose", content: { body: "About {{UnknownKeyword}}" } },
  ];
  const result = calculateBlockMastery(blocks, new Map(), new Map());
  assertEquals(result["b1"], -1);
});

Deno.test("calculateBlockMastery — case-insensitive keyword matching", () => {
  const blocks = [
    { id: "b1", type: "prose", content: { body: "{{Mitosis}} and {{MEIOSIS}}" } },
  ];
  const kwToSubtopics = new Map<string, string[]>([
    ["mitosis", ["st1"]],
    ["meiosis", ["st2"]],
  ]);
  const subtopicPKnow = new Map<string, number>([
    ["st1", 0.7],
    ["st2", 0.9],
  ]);

  const result = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);
  assertEquals(result["b1"], 0.8);
});

Deno.test("calculateBlockMastery — keyword with multiple subtopics averages all", () => {
  const blocks = [
    { id: "b1", type: "prose", content: { body: "{{CellDivision}}" } },
  ];
  const kwToSubtopics = new Map<string, string[]>([
    ["celldivision", ["st1", "st2", "st3"]],
  ]);
  const subtopicPKnow = new Map<string, number>([
    ["st1", 0.6],
    ["st2", 0.8],
    ["st3", 1.0],
  ]);

  const result = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);
  assertEquals(result["b1"], 0.8);
});

Deno.test("calculateBlockMastery — mixed blocks: some with data, some without", () => {
  const blocks = [
    { id: "b1", type: "prose", content: { body: "{{Mitosis}} info" } },
    { id: "b2", type: "heading", content: { text: "Introduction" } },
    { id: "b3", type: "callout", content: { title: "{{Unknown}}", body: "" } },
  ];

  const kwToSubtopics = new Map<string, string[]>([["mitosis", ["st1"]]]);
  const subtopicPKnow = new Map<string, number>([["st1", 0.75]]);

  const result = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);
  assertEquals(result["b1"], 0.75);
  assertEquals(result["b2"], -1);
  assertEquals(result["b3"], -1);
});
