/**
 * tests/unit/block-keywords.test.ts — 25 tests for keyword extraction and mastery calculation
 */

import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  extractKeywordsFromBlock,
  calculateBlockMastery,
  BlockLike,
} from "../../supabase/functions/server/lib/block-keywords.ts";

Deno.test("K01 · prose: extracts keywords from body field", () => {
  const block: BlockLike = {
    type: "prose",
    content: {
      title: "No keywords here",
      body: "The {{nervous system}} controls {{brain}} and {{spinal cord}}",
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 3);
  assert(keywords.includes("nervous system"));
  assert(keywords.includes("brain"));
  assert(keywords.includes("spinal cord"));
});

Deno.test("K02 · text (legacy): extracts from body", () => {
  const block: BlockLike = {
    type: "text",
    content: {
      body: "The {{mitochondria}} is the {{powerhouse}}",
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 2);
  assert(keywords.includes("mitochondria"));
  assert(keywords.includes("powerhouse"));
});

Deno.test("K03 · key_point: scans title and explanation", () => {
  const block: BlockLike = {
    type: "key_point",
    content: {
      title: "The {{synapse}} concept",
      explanation: "A {{synapse}} is where {{neurons}} connect",
      importance: "critical",
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 3);
  assert(keywords.filter((k) => k === "synapse").length === 2);
  assert(keywords.includes("neurons"));
});

Deno.test("K04 · callout: scans title and body", () => {
  const block: BlockLike = {
    type: "callout",
    content: {
      variant: "warning",
      title: "Remember {{dopamine}}",
      body: "{{Dopamine}} affects mood and {{motivation}}",
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 3);
  assert(keywords.includes("dopamine"));
  assert(keywords.includes("Dopamine"));
  assert(keywords.includes("motivation"));
});

Deno.test("K05 · two_column: scans left and right fields", () => {
  const block: BlockLike = {
    type: "two_column",
    content: {
      left: "Left side has {{keyword1}}",
      right: "Right side has {{keyword2}}",
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 2);
  assert(keywords.includes("keyword1"));
  assert(keywords.includes("keyword2"));
});

Deno.test("K06 · stages: scans title and description fields in array", () => {
  const block: BlockLike = {
    type: "stages",
    content: {
      stages: [
        { title: "Stage {{one}}", description: "First {{phase}}" },
        { title: "Stage {{two}}", description: "Second {{phase}}" },
      ],
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 4);
  assert(keywords.includes("one"));
  assert(keywords.includes("two"));
  assert(keywords.filter((k) => k === "phase").length === 2);
});

Deno.test("K07 · list_detail: scans title and detail in items array", () => {
  const block: BlockLike = {
    type: "list_detail",
    content: {
      intro: "Terms:",
      items: [
        { title: "{{Dopamine}}", detail: "{{Reward}} chemical" },
        { title: "{{Serotonin}}", detail: "{{Mood}} regulator" },
      ],
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 4);
  assert(keywords.includes("Dopamine"));
  assert(keywords.includes("Reward"));
  assert(keywords.includes("Serotonin"));
  assert(keywords.includes("Mood"));
});

Deno.test("K08 · comparison: scans title and description in items", () => {
  const block: BlockLike = {
    type: "comparison",
    content: {
      items: [
        { title: "{{Item1}}", description: "Has {{feature}}" },
        { title: "{{Item2}}", description: "Lacks {{feature}}" },
      ],
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 4);
  assert(keywords.includes("Item1"));
  assert(keywords.includes("Item2"));
  assert(keywords.filter((k) => k === "feature").length === 2);
});

Deno.test("K09 · grid: scans title and body in cells array", () => {
  const block: BlockLike = {
    type: "grid",
    content: {
      cells: [
        { title: "{{FrontalLobe}}", body: "Controls {{movement}}" },
        { title: "{{TemporalLobe}}", body: "Handles {{memory}}" },
      ],
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 4);
  assert(keywords.includes("FrontalLobe"));
  assert(keywords.includes("TemporalLobe"));
  assert(keywords.includes("movement"));
  assert(keywords.includes("memory"));
});

Deno.test("K10 · heading: scans text field", () => {
  const block: BlockLike = {
    type: "heading",
    content: {
      text: "Introduction to {{neurons}}",
      level: 2,
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 1);
  assert(keywords.includes("neurons"));
});

Deno.test("K11 · unknown type: scans common fallback fields", () => {
  const block: BlockLike = {
    type: "custom_unknown",
    content: {
      body: "Has {{keyword1}}",
      title: "And {{keyword2}}",
      text: "And {{keyword3}}",
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 3);
  assert(keywords.includes("keyword1"));
  assert(keywords.includes("keyword2"));
  assert(keywords.includes("keyword3"));
});

Deno.test("K12 · no keywords: returns empty array", () => {
  const block: BlockLike = {
    type: "prose",
    content: {
      title: "Plain text",
      body: "This is plain text with no keywords",
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 0);
});

Deno.test("K13 · null content: returns empty array", () => {
  const block: BlockLike = {
    type: "prose",
    content: {} as Record<string, unknown>,
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 0);
});

Deno.test("K14 · case sensitive: preserves original case", () => {
  const block: BlockLike = {
    type: "prose",
    content: {
      title: "",
      body: "{{Dopamine}} vs {{dopamine}} vs {{DOPAMINE}}",
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 3);
  assert(keywords.includes("Dopamine"));
  assert(keywords.includes("dopamine"));
  assert(keywords.includes("DOPAMINE"));
});

Deno.test("K15 · whitespace in keywords: preserved as-is", () => {
  const block: BlockLike = {
    type: "prose",
    content: {
      title: "",
      body: "The {{central nervous system}} is important",
    },
  };
  const keywords = extractKeywordsFromBlock(block);
  assertEquals(keywords.length, 1);
  assert(keywords.includes("central nervous system"));
});

Deno.test("K16 · calculateBlockMastery: basic mastery calculation", () => {
  const blocks = [
    {
      id: "b1",
      type: "prose",
      content: {
        title: "Block",
        body: "Has {{keyword1}} and {{keyword2}}",
      },
    },
  ];

  const kwToSubtopics = new Map([
    ["keyword1", ["st1", "st2"]],
    ["keyword2", ["st3"]],
  ]);

  const subtopicPKnow = new Map([
    ["st1", 0.8],
    ["st2", 0.6],
    ["st3", 0.4],
  ]);

  const mastery = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);

  assertEquals(Object.keys(mastery).length, 1);
  assert(mastery["b1"] !== undefined);
  assertEquals(mastery["b1"], 0.6);
});

Deno.test("K17 · calculateBlockMastery: no keywords → -1", () => {
  const blocks = [
    {
      id: "b1",
      type: "prose",
      content: {
        title: "Block",
        body: "No keywords here",
      },
    },
  ];

  const kwToSubtopics = new Map();
  const subtopicPKnow = new Map();

  const mastery = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);

  assertEquals(mastery["b1"], -1);
});

Deno.test("K18 · calculateBlockMastery: keyword not in mapping → -1", () => {
  const blocks = [
    {
      id: "b1",
      type: "prose",
      content: {
        title: "Block",
        body: "Has {{unmapped_keyword}}",
      },
    },
  ];

  const kwToSubtopics = new Map();
  const subtopicPKnow = new Map();

  const mastery = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);

  assertEquals(mastery["b1"], -1);
});

Deno.test("K19 · calculateBlockMastery: case insensitive matching", () => {
  const blocks = [
    {
      id: "b1",
      type: "prose",
      content: {
        title: "Block",
        body: "Has {{Dopamine}}",
      },
    },
  ];

  const kwToSubtopics = new Map([
    ["dopamine", ["st1"]],
  ]);

  const subtopicPKnow = new Map([["st1", 0.7]]);

  const mastery = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);

  assertEquals(mastery["b1"], 0.7);
});

Deno.test("K20 · calculateBlockMastery: multiple blocks", () => {
  const blocks = [
    {
      id: "b1",
      type: "prose",
      content: {
        title: "Block 1",
        body: "Has {{kw1}}",
      },
    },
    {
      id: "b2",
      type: "prose",
      content: {
        title: "Block 2",
        body: "Has {{kw2}}",
      },
    },
  ];

  const kwToSubtopics = new Map([
    ["kw1", ["st1"]],
    ["kw2", ["st2"]],
  ]);

  const subtopicPKnow = new Map([
    ["st1", 0.8],
    ["st2", 0.4],
  ]);

  const mastery = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);

  assertEquals(mastery["b1"], 0.8);
  assertEquals(mastery["b2"], 0.4);
});

Deno.test("K21 · calculateBlockMastery: rounding to 4 decimals", () => {
  const blocks = [
    {
      id: "b1",
      type: "prose",
      content: {
        title: "Block",
        body: "Has {{kw}}",
      },
    },
  ];

  const kwToSubtopics = new Map([["kw", ["st1"]]]);
  const subtopicPKnow = new Map([["st1", 0.33333333]]);

  const mastery = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);

  assertEquals(mastery["b1"], 0.3333);
});

Deno.test("K22 · calculateBlockMastery: all keywords average correctly", () => {
  const blocks = [
    {
      id: "b1",
      type: "prose",
      content: {
        title: "Block",
        body: "Has {{kw1}}, {{kw2}}, {{kw3}}",
      },
    },
  ];

  const kwToSubtopics = new Map([
    ["kw1", ["st1"]],
    ["kw2", ["st2"]],
    ["kw3", ["st3"]],
  ]);

  const subtopicPKnow = new Map([
    ["st1", 0.9],
    ["st2", 0.5],
    ["st3", 0.1],
  ]);

  const mastery = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);

  assertEquals(mastery["b1"], 0.5);
});

Deno.test("K23 · calculateBlockMastery: subtopic not found → ignored", () => {
  const blocks = [
    {
      id: "b1",
      type: "prose",
      content: {
        title: "Block",
        body: "Has {{kw}}",
      },
    },
  ];

  const kwToSubtopics = new Map([["kw", ["st1", "st_missing"]]]);
  const subtopicPKnow = new Map([["st1", 0.8]]);

  const mastery = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);

  assertEquals(mastery["b1"], 0.8);
});

Deno.test("K24 · calculateBlockMastery: duplicate keywords handled", () => {
  const blocks = [
    {
      id: "b1",
      type: "prose",
      content: {
        title: "Block",
        body: "Has {{kw}} and {{kw}} again",
      },
    },
  ];

  const kwToSubtopics = new Map([["kw", ["st1", "st2"]]]);
  const subtopicPKnow = new Map([
    ["st1", 0.8],
    ["st2", 0.6],
  ]);

  const mastery = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);

  assertEquals(mastery["b1"], 0.7);
});

Deno.test("K25 · calculateBlockMastery: boundary values (0 and 1)", () => {
  const blocks = [
    {
      id: "b1",
      type: "prose",
      content: {
        title: "Block",
        body: "Has {{kw1}} and {{kw2}}",
      },
    },
  ];

  const kwToSubtopics = new Map([
    ["kw1", ["st1"]],
    ["kw2", ["st2"]],
  ]);

  const subtopicPKnow = new Map([
    ["st1", 0],
    ["st2", 1],
  ]);

  const mastery = calculateBlockMastery(blocks, kwToSubtopics, subtopicPKnow);

  assertEquals(mastery["b1"], 0.5);
});
