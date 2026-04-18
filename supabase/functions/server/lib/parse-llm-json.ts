/**
 * parse-llm-json.ts — Parse JSON from LLM output, stripping markdown fences.
 *
 * Works with both Claude and Gemini responses. LLMs sometimes wrap JSON
 * in ```json ... ``` code blocks even when instructed not to.
 */

export function parseLlmJson<T = unknown>(text: string): T {
  let cleaned = text.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  return JSON.parse(cleaned.trim()) as T;
}
