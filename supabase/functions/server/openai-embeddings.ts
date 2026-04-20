/**
 * openai-embeddings.ts — OpenAI embedding helper for Axon
 *
 * Single function: generateEmbedding() using text-embedding-3-large
 * truncated to 1536 dimensions via Matryoshka Representation Learning.
 *
 * Decisions:
 *   D57: text-embedding-3-large truncated to 1536d
 *   D59: Retry with exponential backoff (3 attempts)
 *   D60: EMBEDDING_DIMENSIONS + EMBEDDING_MODEL as centralized constants
 *   D63: LLM generation stays in gemini.ts (only embeddings migrate)
 *
 * Environment: Reads OPENAI_API_KEY from Deno.env (set via supabase secrets).
 */

import { getCachedEmbedding, setCachedEmbedding } from "./lib/embedding-cache.ts";

// ─── Centralized Constants (D60) ────────────────────────────────

export const EMBEDDING_MODEL = "text-embedding-3-large";
export const EMBEDDING_DIMENSIONS = 1536;

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

// ─── API Key ────────────────────────────────────────────────────

function getOpenAIKey(): string {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("[Axon Fatal] OPENAI_API_KEY not configured in secrets");
  return key;
}

// ─── Generate Embedding ─────────────────────────────────────────

/**
 * Generate a 1536-dimensional embedding using OpenAI text-embedding-3-large.
 *
 * Unlike the Gemini version, this does NOT take a taskType parameter.
 * OpenAI's embedding models handle query/document distinction internally.
 *
 * @param text - The text to embed (max ~8191 tokens)
 * @returns number[] of exactly EMBEDDING_DIMENSIONS (1536) values
 *
 * @throws Error if all retries fail or dimension mismatch
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  // Check cache first to avoid redundant API calls
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  const key = getOpenAIKey();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(OPENAI_EMBEDDINGS_URL, {
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
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Retry on rate limit or server error
      if ((res.status === 429 || res.status === 503) && attempt < MAX_ATTEMPTS) {
        const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, 8000);
        console.warn(
          `[OpenAI Embed] ${res.status}, retry ${attempt + 1}/${MAX_ATTEMPTS} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`OpenAI Embedding error ${res.status}: ${errBody}`);
      }

      const data = await res.json();
      const embedding = data?.data?.[0]?.embedding;

      if (!embedding || !Array.isArray(embedding)) {
        throw new Error("OpenAI returned no embedding data");
      }

      // G5: Dimension validation
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${embedding.length}`,
        );
      }

      // Cache the result for future lookups
      setCachedEmbedding(text, embedding);

      return embedding;
    } catch (e) {
      clearTimeout(timer);

      if (e instanceof DOMException && e.name === "AbortError") {
        lastError = new Error(
          `OpenAI Embedding timeout after ${TIMEOUT_MS}ms (attempt ${attempt + 1})`,
        );
      } else {
        lastError = e as Error;
      }

      if (attempt < MAX_ATTEMPTS) {
        const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, 8000);
        console.warn(
          `[OpenAI Embed] Error, retry ${attempt + 1}/${MAX_ATTEMPTS} in ${delay}ms: ${lastError.message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }

  throw lastError ?? new Error("OpenAI Embedding: max retries exceeded");
}

// ─── Batch Embedding ────────────────────────────────────────────

/**
 * Generate embeddings for multiple texts in a single API call.
 * OpenAI supports up to 2048 inputs per request.
 * We batch in groups of 100 for safety and retry per batch.
 *
 * @param texts - Array of texts to embed
 * @returns number[][] of embeddings, one per input text (same order)
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) {
    const single = await generateEmbedding(texts[0]);
    return [single];
  }

  const BATCH_SIZE = 100;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchEmbeddings = await generateEmbeddingBatch(batch);
    results.push(...batchEmbeddings);
  }

  return results;
}

async function generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
  const key = getOpenAIKey();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS * 2);

    try {
      const res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: texts,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.status === 429 || res.status === 503) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[OpenAI Batch Embed] ${res.status}, retry ${attempt + 1}/${MAX_ATTEMPTS} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`OpenAI batch embedding failed (${res.status}): ${errBody}`);
      }

      const data = await res.json();
      // Sort by index to ensure correct ordering
      const sorted = data.data.sort(
        (a: { index: number }, b: { index: number }) => a.index - b.index,
      );
      const embeddings = sorted.map(
        (item: { embedding: number[] }) => item.embedding,
      );

      // Validate dimensions
      for (const emb of embeddings) {
        if (emb.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Batch embedding dimension mismatch: got ${emb.length}, expected ${EMBEDDING_DIMENSIONS}`,
          );
        }
      }

      return embeddings;
    } catch (e) {
      clearTimeout(timer);

      if (e instanceof DOMException && e.name === "AbortError") {
        lastError = new Error(
          `OpenAI Batch Embedding timeout after ${TIMEOUT_MS * 2}ms (attempt ${attempt + 1})`,
        );
      } else {
        lastError = e instanceof Error ? e : new Error(String(e));
      }

      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[OpenAI Batch Embed] Error, retry ${attempt + 1}/${MAX_ATTEMPTS} in ${delay}ms: ${lastError.message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error("Batch embedding failed after retries");
}
