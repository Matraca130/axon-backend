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

import { fetchWithRetry as _fetchWithRetry } from "./lib/fetch-retry.ts";
import { parseLlmJson } from "./lib/parse-llm-json.ts";

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
// Shared implementation in lib/fetch-retry.ts. Claude retries on 429, 503, 529.

import { fetchWithRetry as _fetchWithRetry } from "./lib/fetch-with-retry.ts";

export function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxRetries = 3,
): Promise<Response> {
  return _fetchWithRetry(url, init, timeoutMs, [429, 529, 503], "Claude", maxRetries);
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

/**
 * Internal text generation -- called by the public generateText() wrapper.
 * Handles a single model attempt (no cross-model fallback).
 */
async function generateTextInternal(
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

/**
 * Public text generation with automatic fallback tier-down.
 * If the target model (sonnet/opus) fails, falls back to haiku.
 * If haiku itself fails, the error propagates normally.
 */
export async function generateText(
  opts: ClaudeGenerateOpts,
): Promise<ClaudeGenerateResult> {
  const targetModel = opts.model ?? "sonnet";
  try {
    return await generateTextInternal({ ...opts, model: targetModel });
  } catch (err) {
    if (targetModel === "haiku") throw err; // No further fallback
    console.warn(
      `[AI Fallback] ${targetModel} failed: ${(err as Error).message}. Falling back to haiku.`,
    );
    return await generateTextInternal({ ...opts, model: "haiku" });
  }
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
    lowerTask.includes("reporte") ||
    lowerTask.includes("informe") ||
    lowerTask.includes("analysis") ||
    lowerTask.includes("análisis") ||
    lowerTask.includes("analisis") ||
    lowerTask.includes("explain in depth") ||
    lowerTask.includes("explicar en profundidad") ||
    lowerTask.includes("explicar en detalle") ||
    lowerTask.includes("compare and contrast") ||
    lowerTask.includes("comparar y contrastar") ||
    lowerTask.includes("comparar")
  ) {
    return "opus";
  }

  // Haiku for simple tasks
  if (
    lowerTask.includes("format") ||
    lowerTask.includes("formatear") ||
    lowerTask.includes("formato") ||
    lowerTask.includes("translate") ||
    lowerTask.includes("traducir") ||
    lowerTask.includes("traducción") ||
    lowerTask.includes("traduccion") ||
    lowerTask.includes("summarize briefly") ||
    lowerTask.includes("resumir brevemente") ||
    lowerTask.includes("resumir") ||
    lowerTask.includes("list") ||
    lowerTask.includes("listar") ||
    lowerTask.includes("enumerar")
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
const STREAM_TIMEOUT_MS = 60_000;

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

  // Task 4.7: AbortController with 60s timeout for streaming requests
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(timer);
      const errBody = await res.text();
      throw new Error(`Claude streaming failed (${res.status}): ${errBody.slice(0, 200)}`);
    }

    if (!res.body) {
      clearTimeout(timer);
      throw new Error("Claude streaming response has no body");
    }

    // Clear the timeout once we start reading — the stream itself handles its own lifecycle
    clearTimeout(timer);
    return res.body;
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`Claude streaming timeout after ${STREAM_TIMEOUT_MS}ms`);
    }
    throw e;
  }
}

// ─── Parse JSON safely from Claude output ─────────────────
// Strips markdown code fences (```json / ```) before parsing.

export const parseClaudeJson = parseLlmJson;
