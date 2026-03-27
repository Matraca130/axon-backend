/**
 * flashcard-image-generator.ts — Image generation pipeline for flashcards
 *
 * Generates AI images for flashcards and uploads them to Supabase Storage.
 * Uses Gemini image generation (via gemini-image.ts, created by AI-05).
 *
 * Storage path: flashcard-images/{institutionId}/{flashcardId}/original.png
 * Serves variants via Supabase Image Transformations (no extra files stored).
 *
 * FC-02
 */

import { type SupabaseClient } from "npm:@supabase/supabase-js";
import { generateImage, IMAGE_MODEL } from "./gemini-image.ts";

// ─── Types ──────────────────────────────────────────────────────────

export interface ImageGenerationResult {
  imageUrl: string;       // Base URL of PNG in Storage (no transforms)
  model: string;
  promptUsed: string;
}

export interface FlashcardImageRequest {
  flashcardId: string;
  institutionId: string;
  topic: string;
  content: string;        // flashcard text for context
  imagePrompt?: string;   // custom prompt from professor
  stylePackUrls?: string[];
}

// ─── Image Transformation Helpers ───────────────────────────────────

/**
 * Append Supabase Image Transformation query params to a base storage URL.
 * Does NOT store extra files — transformations are computed on-the-fly by Supabase.
 */
export function getTransformedImageUrl(
  baseUrl: string,
  opts: { width?: number; quality?: number; format?: "avif" | "webp" | "origin" } = {},
): string {
  const { width = 800, quality = 80, format = "avif" } = opts;
  const params = new URLSearchParams();
  params.set("width", String(width));
  params.set("quality", String(quality));
  if (format !== "origin") params.set("format", format);
  return `${baseUrl}?${params.toString()}`;
}

/** Pre-configured variant generators for common use cases. */
export const imageVariants = {
  full:      (url: string) => getTransformedImageUrl(url, { width: 800, quality: 80, format: "avif" }),
  fullWebp:  (url: string) => getTransformedImageUrl(url, { width: 800, quality: 85, format: "webp" }),
  thumb:     (url: string) => getTransformedImageUrl(url, { width: 200, quality: 60, format: "avif" }),
  thumbWebp: (url: string) => getTransformedImageUrl(url, { width: 200, quality: 70, format: "webp" }),
} as const;

// ─── Prompt Builder ─────────────────────────────────────────────────

/**
 * Build the image generation prompt. If the request includes a custom
 * imagePrompt from the professor, use it directly. Otherwise, generate
 * a medical-education-oriented prompt from the topic and content.
 */
export function buildImagePrompt(request: FlashcardImageRequest): string {
  if (request.imagePrompt?.trim()) {
    return request.imagePrompt.trim();
  }

  return [
    `Create a clear, professional medical education illustration for a flashcard.`,
    `Topic: ${request.topic}.`,
    `Content: ${request.content.slice(0, 500)}.`,
    `Style: Clean, labeled diagram suitable for studying. Use a white background`,
    `with high-contrast colors. Include relevant anatomical or conceptual labels.`,
    `The image should help a medical student understand and memorize the concept.`,
  ].join(" ");
}

// ─── Main Pipeline ──────────────────────────────────────────────────

/**
 * Generate an image for a flashcard and upload it to Supabase Storage.
 *
 * Pipeline:
 *   1. Build prompt (custom or auto-generated)
 *   2. Call Gemini image generation
 *   3. Upload PNG to Storage (upsert)
 *   4. Return public URL + metadata
 */
export async function generateFlashcardImage(
  supabase: SupabaseClient,
  request: FlashcardImageRequest,
): Promise<ImageGenerationResult> {
  // 1. Build prompt
  const prompt = buildImagePrompt(request);

  // 2. Fetch style reference images if provided (URLs → Uint8Array[])
  let referenceImages: Uint8Array[] | undefined;
  if (request.stylePackUrls?.length) {
    referenceImages = await Promise.all(
      request.stylePackUrls.map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`[FlashcardImage] Failed to fetch style reference ${url}: ${res.status}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      }),
    );
  }

  // 3. Generate image via Gemini
  const generated = await generateImage({
    prompt,
    referenceImages,
  });

  // 4. Upload PNG to Supabase Storage
  const storagePath = `${request.institutionId}/${request.flashcardId}/original.png`;

  const { error: uploadError } = await supabase.storage
    .from("flashcard-images")
    .upload(storagePath, generated.imageBuffer, {
      contentType: "image/png",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`[FlashcardImage] Storage upload failed: ${uploadError.message}`);
  }

  // 5. Get public URL
  const { data: publicUrlData } = supabase.storage
    .from("flashcard-images")
    .getPublicUrl(storagePath);

  const imageUrl = publicUrlData.publicUrl;

  return {
    imageUrl,
    model: IMAGE_MODEL,
    promptUsed: prompt,
  };
}
