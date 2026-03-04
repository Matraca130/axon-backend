/**
 * gemini.ts — Gemini API helpers for Axon v4.4
 *
 * Two functions:
 *   generateText()      — Gemini 2.0 Flash for text/JSON generation
 *   generateEmbedding() — text-embedding-004 for vector embeddings (768d)
 *
 * Environment: Reads GEMINI_API_KEY from Deno.env (set via supabase secrets).
 *
 * Rate limits (free tier):
 *   - gemini-2.0-flash: 15 RPM, 1M tokens/min, 1500 RPD
 *   - text-embedding-004: 1500 RPM, 100 RPD (batch)
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function getApiKey(): string {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("[Axon Fatal] GEMINI_API_KEY not configured in secrets");
  return key;
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

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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
  const model = "text-embedding-004";
  const url = `${GEMINI_BASE}/${model}:embedContent?key=${key}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      taskType,
    }),
  });

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
