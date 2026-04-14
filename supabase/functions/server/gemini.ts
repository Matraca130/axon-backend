/**
 * gemini.ts — Gemini API helpers for Axon v4.4
 *
 * ⚠️  MULTIMODAL / IMAGE ONLY — Text generation has moved to claude-ai.ts.
 *
 * Active functions:
 *   extractTextFromPdf()  — Gemini 2.5 Flash multimodal PDF text extraction (Fase 7)
 *   fetchWithRetry()      — Thin wrapper over lib/fetch-retry.ts (429, 503)
 *   parseGeminiJson()     — Backward-compat re-export of parseLlmJson
 *
 * REMOVED functions:
 *   generateText()        — Text generation migrated to claude-ai.ts
 *   generateEmbedding()   — HARD ERROR: Use openai-embeddings.ts instead (D57)
 *
 * Environment: Reads GEMINI_API_KEY from Deno.env (set via supabase secrets).
 */

import { fetchWithRetry as _fetchWithRetry } from "./lib/fetch-retry.ts";
import { parseLlmJson } from "./lib/parse-llm-json.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export const GENERATE_MODEL = "gemini-2.5-flash";

function getApiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("[Axon Fatal] GEMINI_API_KEY not configured in secrets");
  return key;
}

export { getApiKey };

// ─── Fetch with timeout + retry ─────────────
// Shared implementation in lib/fetch-retry.ts. Gemini retries on 429, 503.

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxRetries = 3,
): Promise<Response> {
  return _fetchWithRetry(url, init, timeoutMs, maxRetries, [429, 503]);
}

// ─── Embeddings (REMOVED — W7-RAG01) ────────────────────────────
//
// Previously: generateEmbedding() used Gemini embedding-001 (768d).
// Problem: The pipeline now uses OpenAI text-embedding-3-large (1536d).
// If anyone called this function, they'd insert 768d vectors into
// 1536d pgvector columns, causing silent search degradation.
//
// W7-RAG01 FIX: Function now throws immediately with a clear error.
// The export is preserved so any stale import gets a hard failure
// at call-time instead of a silent dimension mismatch.

/**
 * @deprecated REMOVED — Use openai-embeddings.ts generateEmbedding() instead.
 * This function now throws immediately to prevent dimension mismatch.
 * The Axon pipeline uses OpenAI text-embedding-3-large (1536d).
 * Gemini embedding-001 produces 768d vectors which are INCOMPATIBLE.
 */
export async function generateEmbedding(
  _text: string,
  _taskType?: string,
): Promise<never> {
  throw new Error(
    "[Axon Fatal] gemini.ts generateEmbedding() is REMOVED. " +
    "Use openai-embeddings.ts generateEmbedding() instead. " +
    "Gemini produces 768d vectors; the pipeline uses 1536d OpenAI vectors. " +
    "Mixing dimensions corrupts pgvector search silently. " +
    "See: W7-RAG01, D57.",
  );
}

// ─── PDF Text Extraction (Fase 7, D45-D49) ─────────────────────

const PDF_EXTRACT_PROMPT = [
  "Extract ALL text content from this PDF document.",
  "Rules:",
  "- Preserve the original structure (headings, lists, paragraphs)",
  "- Use markdown formatting (# for titles, ## for sections, - for lists)",
  "- Preserve tables as markdown tables when possible",
  "- Do NOT summarize, paraphrase, or add commentary",
  "- If pages contain images with embedded text, extract that text too",
  "- Return ONLY the extracted text content",
].join("\n");

const PDF_EXTRACT_TIMEOUT_MS = 30_000;

export interface PdfExtractResult {
  text: string;
  tokensUsed: { input: number; output: number };
}

export async function extractTextFromPdf(
  base64Data: string,
  mimeType: string = "application/pdf",
): Promise<PdfExtractResult> {
  const key = getApiKey();
  const model = GENERATE_MODEL;
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${key}`;

  const body = {
    contents: [
      {
        parts: [
          { text: PDF_EXTRACT_PROMPT },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Data,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
    },
  };

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    PDF_EXTRACT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini PDF extraction error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];

  if (!candidate?.content?.parts?.[0]?.text) {
    const blockReason = candidate?.finishReason ?? data.promptFeedback?.blockReason;
    if (blockReason && blockReason !== "STOP") {
      throw new Error(
        `Gemini PDF extraction blocked: ${blockReason}. ` +
          "The PDF may contain content flagged by safety filters.",
      );
    }
    throw new Error(
      "Gemini returned no content for PDF extraction. " +
        "The PDF may be empty, corrupted, or contain only images without recognizable text.",
    );
  }

  return {
    text: candidate.content.parts[0].text,
    tokensUsed: {
      input: data.usageMetadata?.promptTokenCount ?? 0,
      output: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

// ─── Parse JSON safely from Gemini output ───────────────────────
// Shared implementation in lib/parse-llm-json.ts. Re-exported for
// backward compatibility; no consumers currently import this name.

export const parseGeminiJson = parseLlmJson;
