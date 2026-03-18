import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

Deno.test("generateText export exists and is a function", async () => {
  const mod = await import("../claude-ai.ts");
  assertEquals(typeof mod.generateText, "function");
});

Deno.test("chat export exists and is a function", async () => {
  const mod = await import("../claude-ai.ts");
  assertEquals(typeof mod.chat, "function");
});

Deno.test("selectModelForTask export exists and is a function", async () => {
  const mod = await import("../claude-ai.ts");
  assertEquals(typeof mod.selectModelForTask, "function");
});

Deno.test("getModelId export exists and is a function", async () => {
  const mod = await import("../claude-ai.ts");
  assertEquals(typeof mod.getModelId, "function");
});

Deno.test("fetchWithRetry export exists and is a function", async () => {
  const mod = await import("../claude-ai.ts");
  assertEquals(typeof mod.fetchWithRetry, "function");
});

Deno.test("parseClaudeJson export exists and is a function", async () => {
  const mod = await import("../claude-ai.ts");
  assertEquals(typeof mod.parseClaudeJson, "function");
});

Deno.test("ClaudeModel type allows valid model names", async () => {
  const mod = await import("../claude-ai.ts");
  // Verify getModelId accepts the three valid ClaudeModel values without throwing
  assertEquals(typeof mod.getModelId("opus"), "string");
  assertEquals(typeof mod.getModelId("sonnet"), "string");
  assertEquals(typeof mod.getModelId("haiku"), "string");
});

Deno.test("GENERATE_MODEL constant is defined", async () => {
  const mod = await import("../claude-ai.ts");
  assertEquals(typeof mod.GENERATE_MODEL, "string");
  // Should be a Claude model identifier
  assertEquals(mod.GENERATE_MODEL.startsWith("claude-"), true);
});
