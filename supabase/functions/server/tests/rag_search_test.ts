import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

Deno.test("rag-search module exports ragSearch function", async () => {
  const mod = await import("../lib/rag-search.ts");
  assertEquals(typeof mod.ragSearch, "function");
});

Deno.test("RagSearchResult interface is exported (module loads cleanly)", async () => {
  // Importing the module validates that all types and exports resolve without errors
  const mod = await import("../lib/rag-search.ts");
  // ragSearch is the only runtime export; RagSearchResult is a type-only export
  assertEquals(typeof mod.ragSearch, "function");
});
