/**
 * gemini-image.ts — Gemini image generation client for Axon
 *
 * Uses the Gemini 2.0 Flash preview model with image generation capabilities
 * to produce PNG images from text prompts, optionally guided by reference images
 * for style transfer.
 *
 * Reuses fetchWithRetry and getApiKey from gemini.ts for consistent retry/auth
 * handling across all Gemini API calls.
 *
 * Environment: Reads GEMINI_API_KEY from Deno.env (set via supabase secrets).
 */

import { fetchWithRetry, getApiKey } from "./gemini.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const IMAGE_MODEL = "gemini-2.0-flash-preview-image-generation";
const IMAGE_TIMEOUT_MS = 30_000; // Image generation is slower than text
const DEFAULT_TEMPERATURE = 0.4;

// ─── Public interfaces ───────────────────────────────────────────

export interface GeminiImageRequest {
  prompt: string;
  referenceImages?: Uint8Array[]; // For style transfer
  temperature?: number;           // Default 0.4
}

export interface GeminiImageResponse {
  imageBuffer: Uint8Array; // PNG bytes
  mimeType: string;        // "image/png"
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Encode a Uint8Array to base64 string (Deno-compatible). */
function uint8ToBase64(bytes: Uint8Array): string {
  // Deno supports the standard btoa + String.fromCharCode approach
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a base64 string to Uint8Array (Deno-compatible). */
function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Image Generation ────────────────────────────────────────────

/**
 * Generate an image using Gemini 2.0 Flash image generation.
 *
 * Builds a multimodal request with the text prompt and optional reference
 * images, then parses the response for inlineData containing the generated
 * PNG image.
 *
 * @throws Error if the API returns an error, times out, or produces no image.
 */
export async function generateImage(
  request: GeminiImageRequest,
): Promise<GeminiImageResponse> {
  const key = getApiKey();
  const url = `${GEMINI_BASE}/${IMAGE_MODEL}:generateContent?key=${key}`;

  // Build parts array: text prompt + optional reference images
  const parts: Record<string, unknown>[] = [{ text: request.prompt }];

  if (request.referenceImages?.length) {
    for (const imgBytes of request.referenceImages) {
      parts.push({
        inline_data: {
          mime_type: "image/png",
          data: uint8ToBase64(imgBytes),
        },
      });
    }
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: request.temperature ?? DEFAULT_TEMPERATURE,
    },
  };

  console.log(
    `[Gemini Image] Generating image, prompt length=${request.prompt.length}, ` +
    `referenceImages=${request.referenceImages?.length ?? 0}`,
  );

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    IMAGE_TIMEOUT_MS,
    1, // maxRetries — retry once on 429/503
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(
      `Gemini image generation error ${res.status}: ${errBody}`,
    );
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];

  // Check for blocked content
  const blockReason =
    candidate?.finishReason ?? data.promptFeedback?.blockReason;
  if (blockReason && blockReason !== "STOP") {
    throw new Error(
      `Gemini image generation blocked: ${blockReason}. ` +
      "The prompt may contain content flagged by safety filters.",
    );
  }

  // Find the part containing inlineData (the generated image)
  const candidateParts: Array<Record<string, unknown>> =
    candidate?.content?.parts ?? [];

  const imagePart = candidateParts.find(
    (p: Record<string, unknown>) => p.inlineData || p.inline_data,
  );

  if (!imagePart) {
    throw new Error(
      "Gemini image generation returned no image. " +
      "The model may have refused the prompt or returned text only. " +
      `Candidate parts: ${JSON.stringify(candidateParts.map((p) => Object.keys(p)))}`,
    );
  }

  // Gemini API may use camelCase or snake_case depending on version
  const inlineData = (imagePart.inlineData ?? imagePart.inline_data) as {
    data: string;
    mimeType?: string;
    mime_type?: string;
  };

  const mimeType = inlineData.mimeType ?? inlineData.mime_type ?? "image/png";
  const imageBuffer = base64ToUint8(inlineData.data);

  console.log(
    `[Gemini Image] Generated image: ${mimeType}, ${imageBuffer.length} bytes`,
  );

  return {
    imageBuffer,
    mimeType,
  };
}
