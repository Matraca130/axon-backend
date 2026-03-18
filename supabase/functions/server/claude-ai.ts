/**
 * claude-ai.ts — Anthropic Claude API helpers for Axon v4.4
 *
 * PRIMARY text generation provider for Axon:
 *   - Quiz & flashcard generation (/ai/generate, /ai/generate-smart, /ai/pre-generate)
 *   - RAG chat responses (/ai/rag-chat)
 *   - Retrieval strategies: multi-query, HyDE, re-ranking (retrieval-strategies.ts)
 *   - Telegram bot (agentic with tool_use)
 *
 * Gemini is used ONLY for multimodal/image tasks (PDF extraction).
 *
 * Supports model selection: opus, sonnet, haiku.
 * Default model for generation: sonnet (claude-sonnet-4-20250514).
 *
 * Environment: Reads ANTHROPIC_API_KEY from Deno.env (set via supabase secrets).
 */

const CLAUDE_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

// ─── Model Registry ──────────────────────────────────────

export type ClaudeModel = "opus" | "sonnet" | "haiku";

const MODEL_IDS: Record<ClaudeModel, string> = {
  opus: "claude-opus-4-20250514",
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-4-5-20251001",
};

export function getModelId(model: ClaudeModel): string {
  return MODEL_IDS[model];
}

// ─── Config ──────────────────────────────────────────────

function getApiKey(): string {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("[Axon Fatal] ANTHROPIC_API_KEY not configured in secrets");
  return key;
}

export { getApiKey as getClaudeApiKey };

// ─── Fetch with Timeout + Retry ──────────────────────────

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if ((res.status === 429 || res.status === 529 || res.status === 503) && attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(
          `[Claude] ${res.status}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(
          `Claude API timeout after ${timeoutMs}ms (attempt ${attempt + 1})`,
        );
      }
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(
          `[Claude] Network error, retry ${attempt + 1}/${maxRetries} in ${delay}ms: ${(e as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Claude: max retries exceeded");
}

// ─── Types ───────────────────────────────────────────────

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

export interface ClaudeContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ClaudeGenerateOpts {
  prompt: string;
  systemPrompt?: string;
  model?: ClaudeModel;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

interface ClaudeGenerateResult {
  text: string;
  tokensUsed: { input: number; output: number };
}

interface ClaudeChatOpts {
  messages: ClaudeMessage[];
  systemPrompt?: string;
  model?: ClaudeModel;
  tools?: ClaudeTool[];
  temperature?: number;
  maxTokens?: number;
}

export interface ClaudeChatResponse {
  content: ClaudeContentBlock[];
  stopReason: string;
  tokensUsed: { input: number; output: number };
}

// ─── Text Generation ─────────────────────────────────────

const CLAUDE_TIMEOUT_MS = 30_000;

export async function generateText(
  opts: ClaudeGenerateOpts,
): Promise<ClaudeGenerateResult> {
  const key = getApiKey();
  const modelId = getModelId(opts.model ?? "sonnet");
  const url = `${CLAUDE_BASE}/messages`;

  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: opts.maxTokens ?? 2048,
    messages: [{ role: "user", content: opts.prompt }],
  };

  if (opts.systemPrompt) {
    body.system = opts.systemPrompt;
  }

  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    },
    CLAUDE_TIMEOUT_MS,
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  const textBlock = data.content?.find((b: { type: string }) => b.type === "text");

  if (!textBlock?.text) {
    throw new Error("Claude returned no text content");
  }

  return {
    text: textBlock.text,
    tokensUsed: {
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    },
  };
}

// ─── Chat with Tools (Agentic) ──────────────────────────

export async function chat(
  opts: ClaudeChatOpts,
): Promise<ClaudeChatResponse> {
  const key = getApiKey();
  const modelId = getModelId(opts.model ?? "sonnet");
  const url = `${CLAUDE_BASE}/messages`;

  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: opts.maxTokens ?? 1024,
    messages: opts.messages,
  };

  if (opts.systemPrompt) {
    body.system = opts.systemPrompt;
  }

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
  }

  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    },
    CLAUDE_TIMEOUT_MS,
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();

  return {
    content: data.content ?? [],
    stopReason: data.stop_reason ?? "end_turn",
    tokensUsed: {
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    },
  };
}

// ─── Helper: Select model by task complexity ─────────────

/**
 * Selects the appropriate Claude model based on task complexity:
 * - haiku: simple lookups, formatting, quick responses
 * - sonnet: RAG, academic questions, moderate reasoning
 * - opus: complex analysis, multi-step reasoning, report generation
 */
export function selectModelForTask(task: string): ClaudeModel {
  const lowerTask = task.toLowerCase();

  // Opus for complex tasks
  if (
    lowerTask.includes("report") ||
    lowerTask.includes("analysis") ||
    lowerTask.includes("explain in depth") ||
    lowerTask.includes("compare and contrast")
  ) {
    return "opus";
  }

  // Haiku for simple tasks
  if (
    lowerTask.includes("format") ||
    lowerTask.includes("translate") ||
    lowerTask.includes("summarize briefly") ||
    lowerTask.includes("list")
  ) {
    return "haiku";
  }

  // Sonnet for everything else (good balance)
  return "sonnet";
}

// ─── Model constant for _meta logging ─────────────────────
// Matches the pattern used by gemini.ts GENERATE_MODEL.
// Used by generate.ts, generate-smart.ts, pre-generate.ts, chat.ts
// to log which model produced the output.

export const GENERATE_MODEL = "claude-sonnet-4-20250514";

// ─── Streaming Text Generation ──────────────────────────

/**
 * Streaming text generation via Anthropic Messages API.
 * Returns a ReadableStream that yields SSE-formatted chunks.
 */
export async function generateTextStream(
  opts: ClaudeGenerateOpts,
): Promise<ReadableStream<Uint8Array>> {
  const key = getApiKey();
  const modelId = getModelId(opts.model ?? "sonnet");
  const url = `${CLAUDE_BASE}/messages`;

  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: opts.maxTokens ?? 2048,
    messages: [{ role: "user", content: opts.prompt }],
    stream: true,
  };
  if (opts.systemPrompt) body.system = opts.systemPrompt;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude streaming failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  if (!res.body) {
    throw new Error("Claude streaming response has no body");
  }
  return res.body;
}

// ─── Parse JSON safely from Claude output ─────────────────
// Claude sometimes wraps JSON in markdown code blocks.
// Same logic as gemini.ts parseGeminiJson (drop-in replacement).

export function parseClaudeJson<T = unknown>(text: string): T {
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
