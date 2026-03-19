/**
 * tests/semantic_chunker_test.ts — Semantic chunking unit tests
 *
 * Tests for pure/deterministic functions in semantic-chunker.ts
 * and selectChunkStrategy in chunker.ts.
 *
 * Strategy: uses mock embedFn with 3-dimensional vectors.
 * No network calls. No Gemini API. No database.
 *
 * Run: deno test supabase/functions/server/tests/semantic_chunker_test.ts
 */

import {
  assertEquals,
  assertAlmostEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  chunkSemantic,
  cosineSimilarity,
} from "../semantic-chunker.ts";

import { selectChunkStrategy } from "../chunker.ts";

const TOPIC_A = [1, 0, 0];
const TOPIC_B = [0, 1, 0];
const TOPIC_C = [0, 0, 1];
const SIMILAR_A = [0.95, 0.31, 0];

function createMockEmbedFn(
  mapping: Record<string, number[]>,
  defaultVector: number[] = TOPIC_A,
) {
  let callCount = 0;
  const fn = async (text: string): Promise<number[]> => {
    callCount++;
    for (const [keyword, vector] of Object.entries(mapping)) {
      if (text.toLowerCase().includes(keyword.toLowerCase())) {
        return vector;
      }
    }
    return defaultVector;
  };
  return { fn, getCallCount: () => callCount };
}

// GROUP 1: cosineSimilarity

Deno.test("cosineSimilarity: identical vectors → 1.0", () => {
  assertAlmostEquals(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1.0, 1e-10);
});

Deno.test("cosineSimilarity: orthogonal vectors → 0.0", () => {
  assertAlmostEquals(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0.0, 1e-10);
});

Deno.test("cosineSimilarity: opposite vectors → -1.0", () => {
  assertAlmostEquals(cosineSimilarity([1, 0, 0], [-1, 0, 0]), -1.0, 1e-10);
});

Deno.test("cosineSimilarity: zero vector → 0.0", () => {
  assertEquals(cosineSimilarity([0, 0, 0], [1, 0, 0]), 0);
});

Deno.test("cosineSimilarity: different length vectors → 0.0", () => {
  assertEquals(cosineSimilarity([1, 0], [1, 0, 0]), 0);
});

// GROUP 2: chunkSemantic basic

Deno.test("chunkSemantic: empty text → empty array", async () => {
  const { fn } = createMockEmbedFn({});
  assertEquals((await chunkSemantic("", fn)).chunks.length, 0);
  assertEquals((await chunkSemantic("   \n\n  ", fn)).chunks.length, 0);
});

Deno.test("chunkSemantic: single paragraph → 1 chunk", async () => {
  const { fn } = createMockEmbedFn({});
  const text = "La mitosis es un proceso de division celular en el cual una celula madre se divide en dos celulas hijas identicas.";
  const { chunks: result } = await chunkSemantic(text, fn);
  assertEquals(result.length, 1);
  assertEquals(result[0].strategy, "semantic");
  assertEquals(result[0].content, text);
});

Deno.test("chunkSemantic: 2 different topics → 2 chunks", async () => {
  const { fn } = createMockEmbedFn({ "mitosis": TOPIC_A, "fotosintesis": TOPIC_B });
  const text = [
    "La mitosis es el proceso de division celular que produce dos celulas hijas identicas a la celula madre original.",
    "La fotosintesis es el proceso por el cual las plantas convierten la luz solar en energia quimica utilizando clorofila.",
  ].join("\n\n");
  const { chunks: result } = await chunkSemantic(text, fn, { maxChunkSize: 2000, minChunkSize: 10, overlapSize: 0 });
  assertEquals(result.length, 2);
  assertEquals(result[0].content.includes("mitosis"), true);
  assertEquals(result[1].content.includes("fotosintesis"), true);
});

Deno.test("chunkSemantic: 2 same topics → 1 chunk", async () => {
  const { fn } = createMockEmbedFn({ "mitosis": TOPIC_A, "celular": TOPIC_A });
  const text = [
    "La mitosis es el proceso de division celular que produce dos celulas hijas identicas a la celula madre original.",
    "La division celular por mitosis ocurre en cuatro fases principales: profase, metafase, anafase y telofase.",
  ].join("\n\n");
  const { chunks: result } = await chunkSemantic(text, fn, { maxChunkSize: 2000, minChunkSize: 10, overlapSize: 0 });
  assertEquals(result.length, 1);
});

// GROUP 3: boundaries and pre-merge

Deno.test("chunkSemantic: header forces mandatory boundary", async () => {
  const { fn } = createMockEmbedFn({}, TOPIC_A);
  const text = [
    "La mitosis es un proceso fundamental de la biologia celular que permite la reproduccion de las celulas somaticas.",
    "## Fases de la Mitosis\nLa profase es la primera fase de la mitosis donde los cromosomas se condensan y se hacen visibles.",
  ].join("\n\n");
  const { chunks: result } = await chunkSemantic(text, fn, { maxChunkSize: 2000, minChunkSize: 10, overlapSize: 0 });
  assertEquals(result.length, 2);
  assertEquals(result[1].content.includes("## Fases"), true);
});

Deno.test("chunkSemantic: tiny paragraphs get pre-merged", async () => {
  const { fn, getCallCount } = createMockEmbedFn({ "mitosis": TOPIC_A, "fotosintesis": TOPIC_B });
  const text = [
    "La mitosis es un proceso fundamental de la biologia celular que permite la reproduccion de celulas.",
    "OK",
    "Si, es correcto",
    "La fotosintesis es el proceso por el cual las plantas convierten la luz solar en energia quimica almacenada.",
  ].join("\n\n");
  await chunkSemantic(text, fn, { maxChunkSize: 2000, minChunkSize: 10, overlapSize: 0, minParagraphChars: 80 });
  assertEquals(getCallCount() < 4, true, `Expected fewer than 4 embed calls, got ${getCallCount()}`);
});

Deno.test("chunkSemantic: >maxParagraphs → fallback to recursive", async () => {
  const paragraphs: string[] = [];
  for (let i = 0; i < 60; i++) {
    paragraphs.push(`Parrafo numero ${i + 1}: Este es un parrafo suficientemente largo para evitar el pre-merge de parrafos diminutos.`);
  }
  const { fn, getCallCount } = createMockEmbedFn({});
  const { chunks: result } = await chunkSemantic(paragraphs.join("\n\n"), fn, { maxParagraphs: 50, overlapSize: 0 });
  assertEquals(getCallCount(), 0);
  assertEquals(result.length > 0, true);
  assertEquals(result[0].strategy, "recursive");
});

// GROUP 4: error handling

Deno.test("chunkSemantic: embedFn throws → fallback to recursive", async () => {
  const failingFn = async (_t: string): Promise<number[]> => { throw new Error("429"); };
  const text = [
    "La mitosis es un proceso fundamental de la biologia celular que permite la reproduccion de las celulas somaticas.",
    "La fotosintesis es el proceso por el cual las plantas convierten la luz solar en energia quimica utilizando clorofila.",
  ].join("\n\n");
  const { chunks: result } = await chunkSemantic(text, failingFn, { overlapSize: 0 });
  assertEquals(result.length > 0, true);
  assertEquals(result[0].strategy, "recursive");
});

Deno.test("chunkSemantic: partial embed failure → full fallback", async () => {
  let c = 0;
  const partialFn = async (_t: string): Promise<number[]> => { c++; if (c >= 3) throw new Error("503"); return TOPIC_A; };
  const text = [
    "La mitosis es un proceso fundamental de la biologia celular que permite la reproduccion de las celulas somaticas.",
    "La meiosis es un tipo especial de division celular que reduce el numero de cromosomas a la mitad para la reproduccion.",
    "La fotosintesis es el proceso por el cual las plantas convierten la luz solar en energia quimica utilizando clorofila.",
  ].join("\n\n");
  const { chunks: result } = await chunkSemantic(text, partialFn, { overlapSize: 0 });
  assertEquals(result[0].strategy, "recursive");
  assertEquals(c, 3);
});

// GROUP 5: selectChunkStrategy

Deno.test("selectChunkStrategy: short text → recursive", () => {
  assertEquals(selectChunkStrategy("short"), "recursive");
  assertEquals(selectChunkStrategy("x".repeat(3999)), "recursive");
  assertEquals(selectChunkStrategy(""), "recursive");
});

Deno.test("selectChunkStrategy: long text → semantic", () => {
  assertEquals(selectChunkStrategy("x".repeat(4000)), "semantic");
  assertEquals(selectChunkStrategy("x".repeat(10000)), "semantic");
});

Deno.test("selectChunkStrategy: forceStrategy overrides", () => {
  assertEquals(selectChunkStrategy("x".repeat(10000), "recursive"), "recursive");
  assertEquals(selectChunkStrategy("short", "semantic"), "semantic");
});
