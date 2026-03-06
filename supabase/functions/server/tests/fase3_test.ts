/**
 * Tests for Fase 3 — Summary embeddings + Coarse-to-Fine search
 *
 * Tests cover the pure utility functions introduced in Fase 3:
 *
 *   truncateAtWord(text, maxChars)
 *     - Core text utility for preparing summary content for embedding
 *     - 8 tests covering: happy path, boundaries, edge cases
 *
 * Why only truncateAtWord?
 *   - embedSummaryContent() requires Gemini API + DB (integration test territory)
 *   - normalizeCoarseToFineResults() is private in chat.ts (implementation detail)
 *   - AutoIngestResult.summary_embedded is validated by TypeScript compilation
 *   - The SQL RPC is validated by the migration verification block
 *
 * Run: deno test supabase/functions/server/tests/fase3_test.ts
 *
 * Fase 3, sub-task 3.6 — Bloque 2
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ═════════════════════════════════════════════════════════════════
// Environment Setup — MUST happen before dynamic import
// ═════════════════════════════════════════════════════════════════
//
// auto-ingest.ts imports db.ts which checks env vars at module load.
// We set fake values to satisfy the guard. The tests here are pure
// (no DB/API calls), so these values are never actually used.
//
// Same pattern as summary_hook_test.ts.

Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key-for-testing");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key-for-testing");

// ═════════════════════════════════════════════════════════════════
// Dynamic Import — after env vars are set
// ═════════════════════════════════════════════════════════════════
//
// Import chain: auto-ingest.ts → db.ts (env guard)
//               auto-ingest.ts → gemini.ts (lazy API key check, OK)
//               auto-ingest.ts → chunker.ts (pure, no env)

const { truncateAtWord } = await import("../auto-ingest.ts");

// Also verify the type includes summary_embedded (compilation check).
// If this import succeeds without TS errors, the type is correct.
import type { AutoIngestResult } from "../auto-ingest.ts";

// Type-level assertion: if summary_embedded didn't exist on
// AutoIngestResult, this line would fail TypeScript compilation.
const _typeCheck: AutoIngestResult["summary_embedded"] extends boolean
  ? true
  : never = true;
void _typeCheck; // Suppress unused variable warning

// ═════════════════════════════════════════════════════════════════
// truncateAtWord() — Word-boundary safe text truncation
// ═════════════════════════════════════════════════════════════════
//
// Function signature: truncateAtWord(text: string, maxChars: number): string
//
// Contract:
//   1. If text.length <= maxChars → return text unchanged
//   2. Otherwise, find last space at or before maxChars
//   3. If no space found (cutPoint <= 0) → hard cut at maxChars
//   4. Return text.slice(0, cutPoint)
//
// Used by: embedSummaryContent() to truncate summary content to 8000
// chars before sending to Gemini embedding-001 (~10K token limit).

Deno.test("T1 · truncateAtWord — text shorter than maxChars → returns unchanged", () => {
  // Razonamiento: Si el texto cabe completamente, la función debe
  // ser un no-op. Esta es la happy path más común: la mayoría de
  // summaries tienen menos de 8000 chars.
  const input = "Hello world";
  const result = truncateAtWord(input, 100);
  assertEquals(result, "Hello world");
  assertEquals(result.length, 11);
});

Deno.test("T2 · truncateAtWord — text exactly maxChars → returns unchanged", () => {
  // Razonamiento: Boundary condition. La condición es `<=`, no `<`.
  // "Hello" tiene 5 chars, maxChars=5 → 5 <= 5 → true → return as-is.
  const input = "Hello";
  const result = truncateAtWord(input, 5);
  assertEquals(result, "Hello");
});

Deno.test("T3 · truncateAtWord — cuts at last space before maxChars", () => {
  // Razonamiento: Core behavior. El texto tiene 15 chars, maxChars=13.
  // "Hello world foo"
  //  01234567890123456
  //            ^    ^ maxChars=13 está en posición 13 ("f")
  //  Espacios en pos 5 y 11.
  //  lastIndexOf(" ", 13) = 11 (el espacio entre "world" y "foo")
  //  slice(0, 11) = "Hello world"
  const input = "Hello world foo";
  const result = truncateAtWord(input, 13);
  assertEquals(result, "Hello world");
});

Deno.test("T4 · truncateAtWord — no spaces in text → hard cut at maxChars", () => {
  // Razonamiento: Edge case para URLs, slugs, texto CJK sin espacios,
  // o una sola palabra muy larga. lastIndexOf(" ", maxChars) = -1,
  // que es <= 0 → hard cut.
  // Ejemplo: "abcdefghij" (10 chars), maxChars=5 → "abcde"
  const input = "abcdefghij";
  const result = truncateAtWord(input, 5);
  assertEquals(result, "abcde");
  assertEquals(result.length, 5);
});

Deno.test("T5 · truncateAtWord — empty string → returns empty", () => {
  // Razonamiento: Defensive case. Aunque embedSummaryContent tiene
  // guards contra strings vacíos, truncateAtWord debe manejarlos
  // gracefully. "" length 0 <= maxChars → early return.
  const result = truncateAtWord("", 100);
  assertEquals(result, "");
});

Deno.test("T6 · truncateAtWord — space at position 0 then long word → hard cut", () => {
  // Razonamiento: Edge case donde lastIndexOf(" ", maxChars) = 0.
  // " superlongword" (15 chars), maxChars=5.
  // lastIndexOf(" ", 5) busca el último espacio en posiciones 0-5.
  // Encuentra el espacio en pos 0.
  // cutPoint = 0, que es <= 0 → hard cut at maxChars.
  // slice(0, 5) = " supe"
  //
  // ¿Por qué hard cut y no slice(0, 0) = ""?
  // Porque devolver string vacío sería peor que devolver contenido
  // parcial. El embedding de " supe" es inútil, pero al menos no
  // causa un error en generateEmbedding (que valida length > 0).
  const input = " superlongword";
  const result = truncateAtWord(input, 5);
  assertEquals(result, " supe");
  assertEquals(result.length, 5);
});

Deno.test("T7 · truncateAtWord — multiple spaces, cuts at correct one", () => {
  // Razonamiento: Verifica que lastIndexOf encuentra el ÚLTIMO
  // espacio antes del límite, no el primero.
  // "a b c d e f g" (13 chars), maxChars=7.
  //  0123456789012
  //  a b c d e f g
  //  Espacios en: 1, 3, 5, 7, 9, 11
  //  lastIndexOf(" ", 7) → pos 7 (espacio entre "d" y "e")
  //  slice(0, 7) = "a b c d"
  const input = "a b c d e f g";
  const result = truncateAtWord(input, 7);
  assertEquals(result, "a b c d");
});

Deno.test("T8 · truncateAtWord — very large maxChars with short text → no-op", () => {
  // Razonamiento: Simula el caso real más común.
  // SUMMARY_EMBED_MAX_CHARS = 8000, pero la mayoría de summaries
  // tienen ~2000-4000 chars. La función debe ser un no-op eficiente.
  const input = "La célula eucariota posee un núcleo definido.";
  const result = truncateAtWord(input, 8000);
  assertEquals(result, input);
});
