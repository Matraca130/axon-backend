/**
 * gemini.ts — Gemini API helpers for Axon v4.4
 *
 * Two active functions:
 *   generateText()        — Gemini 2.5 Flash for text/JSON generation
 *   extractTextFromPdf()  — Gemini 2.5 Flash multimodal PDF text extraction (Fase 7)
 *
 * One REMOVED function:
 *   generateEmbedding()   — HARD ERROR: Use openai-embeddings.ts instead (D57)
 *     W7-RAG01 FIX: Now throws immediately instead of silently generating
 *     768d Gemini vectors. The pipeline uses 1536d OpenAI vectors.
 *     Calling this function would insert wrong-dimension vectors into
 *     pgvector columns, causing silent search degradation.
 *
 * Environment: Reads GEMINI_API_KEY from Deno.env (set via supabase secrets).
 *
 * LA-02 FIX: Added AbortController timeout (15s generate, 10s embed)
 * LA-06 FIX: Added retry with exponential backoff for 429/503
 * N3 FIX: Export fetchWithRetry so handler.ts can use it for callGemini
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export const GENERATE_MODEL = "gemini-2.5-flash";

function getApiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("[Axon Fatal] GEMINI_API_KEY not configured in secrets");
  return key;
}

export { getApiKey };

// ─── LA-02 + LA-06 FIX: Fetch with timeout + retry ─────────────
// N3 FIX: Now exported so handler.ts callGemini can use retry logic

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

      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(
          `[Gemini] ${res.status}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(
          `Gemini API timeout after ${timeoutMs}ms (attempt ${attempt + 1})`,
        );
      }
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(
          `[Gemini] Network error, retry ${attempt + 1}/${maxRetries} in ${delay}ms: ${(e as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Gemini: max retries exceeded");
}

// ─── Text Generation ────────────────────────────────────────────

interface GeminiGenerateOpts {
  prompt: string;
  systemPrompt?: string;
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
}

interface GeminiGenerateResult {
  text: string;
  tokensUsed: { input: number; output: number };
}

export async function generateText(
  opts: GeminiGenerateOpts,
): Promise<GeminiGenerateResult> {
  const key = getApiKey();
  const model = GENERATE_MODEL;
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${key}`;

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: opts.prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 2048,
      ...(opts.jsonMode && { responseMimeType: "application/json" }),
    },
  };

  if (opts.systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: opts.systemPrompt }],
    };
  }

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    15_000,
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts?.[0]?.text) {
    throw new Error("Gemini returned no content");
  }

  return {
    text: candidate.content.parts[0].text,
    tokensUsed: {
      input: data.usageMetadata?.promptTokenCount ?? 0,
      output: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
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

export function parseGeminiJson<T = unknown>(text: string): T {
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
