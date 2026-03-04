/**
 * gemini.ts — Gemini API helpers for Axon v4.4
 *
 * Two functions:
 *   generateText()      — Gemini 2.0 Flash for text/JSON generation
 *   generateEmbedding() — text-embedding-005 for vector embeddings (768d)
 *
 * Environment: Reads GEMINI_API_KEY from Deno.env (set via supabase secrets).
 *
 * Rate limits (free tier):
 *   - gemini-2.0-flash: 15 RPM, 1M tokens/min, 1500 RPD
 *   - text-embedding-005: 1500 RPM, 100 RPD (batch)
 *
 * LA-02 FIX: Added AbortController timeout (15s generate, 10s embed)
 * LA-06 FIX: Added retry with exponential backoff for 429/503
 * D-16 FIX: Switched to text-embedding-005 (004 deprecated/404)
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function getApiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("[Axon Fatal] GEMINI_API_KEY not configured in secrets");
  return key;
}

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

      // Retry on transient errors (429 rate-limited, 503 unavailable)
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
      // Retry on network errors
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
  const model = "gemini-2.0-flash";
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

  // LA-02 FIX: 15s timeout for text generation
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

// ─── Embeddings ─────────────────────────────────────────────────

export async function generateEmbedding(
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_QUERY",
): Promise<number[]> {
  const key = getApiKey();
  // D-16 FIX: text-embedding-004 was deprecated/404, use 005
  const model = "text-embedding-005";
  const url = `${GEMINI_BASE}/${model}:embedContent?key=${key}`;

  // LA-02 FIX: 10s timeout for embeddings
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType,
      }),
    },
    10_000,
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini Embedding error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const values = data.embedding?.values;
  if (!values || !Array.isArray(values) || values.length !== 768) {
    throw new Error(`Unexpected embedding dimensions: ${values?.length ?? 0} (expected 768)`);
  }
  return values;
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
