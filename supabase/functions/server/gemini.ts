/**
 * gemini.ts — AI API helpers for Axon v4.5
 *
 * Functions:
 *   generateText()        — Gemini 2.5 Flash for text/JSON generation
 *   generateEmbedding()   — OpenAI text-embedding-3-large (1536d) for vector embeddings
 *   extractTextFromPdf()  — Gemini 2.5 Flash multimodal PDF text extraction (Fase 7)
 *
 * Environment:
 *   GEMINI_API_KEY  — for generateText() and extractTextFromPdf()
 *   OPENAI_API_KEY  — for generateEmbedding()
 *
 * History:
 *   LA-02 FIX: Added AbortController timeout (15s generate, 10s embed)
 *   LA-06 FIX: Added retry with exponential backoff for 429/503
 *   D-16 FIX: Use gemini-embedding-001 (correct model name per 2026 docs)
 *   D-17 FIX: Switch from gemini-2.0-flash to gemini-2.5-flash
 *   D-18 FIX: Export GENERATE_MODEL so _meta always reports correct model
 *   D45-D49: PDF extraction via Gemini multimodal (Fase 7)
 *   D57: Migrate embeddings to OpenAI text-embedding-3-large (1536d)
 *   D59: Retry with exponential backoff for OpenAI embedding calls
 *   D60: Centralized EMBEDDING_DIMENSIONS constant
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// D-17 + D-18: Single source of truth for the generation model name
export const GENERATE_MODEL = "gemini-2.5-flash";

// ─── D57 + D60: OpenAI Embedding Config (centralized) ──────────
export const EMBEDDING_MODEL = "text-embedding-3-large";
export const EMBEDDING_DIMENSIONS = 1536;
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

function getApiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("[Axon Fatal] GEMINI_API_KEY not configured in secrets");
  return key;
}

function getOpenAiKey(): string {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("[Axon Fatal] OPENAI_API_KEY not configured in secrets");
  return key;
}

// Exported so diagnostic route can use it
export { getApiKey };

// ─── LA-02 + LA-06 FIX: Fetch with timeout + retry ─────────────

async function fetchWithRetry(
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
          `[AI API] ${res.status}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(
          `AI API timeout after ${timeoutMs}ms (attempt ${attempt + 1})`,
        );
      }
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(
          `[AI API] Network error, retry ${attempt + 1}/${maxRetries} in ${delay}ms: ${(e as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw new Error("AI API: max retries exceeded");
}

// ─── Text Generation (Gemini) ───────────────────────────────────

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

// ─── Embeddings (OpenAI text-embedding-3-large) ─────────────────
//
// D57: Migrated from Gemini embedding-001 (768d) to OpenAI
//      text-embedding-3-large with Matryoshka truncation to 1536d.
//
// The taskType parameter is kept for backward compatibility with
// all callers (auto-ingest.ts, retrieval-strategies.ts, ingest.ts)
// but is NOT used by OpenAI — their embedding model handles
// query vs document distinction internally.
//
// G5 FIX: Validates output dimension matches EMBEDDING_DIMENSIONS.

export async function generateEmbedding(
  text: string,
  _taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_QUERY",
): Promise<number[]> {
  const key = getOpenAiKey();

  const res = await fetchWithRetry(
    OPENAI_EMBEDDINGS_URL,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    },
    10_000,
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI Embedding error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const values = data.data?.[0]?.embedding;
  if (!values || !Array.isArray(values)) {
    throw new Error("No embedding values returned from OpenAI");
  }
  if (values.length === 0) {
    throw new Error("Empty embedding vector returned from OpenAI");
  }

  // G5: Dimension validation guard
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `[Axon] Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${values.length}`,
    );
  }

  return values;
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
