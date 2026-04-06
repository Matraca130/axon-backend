/**
 * summary-image-generator.ts — Image generation pipeline for summary blocks
 *
 * Generates AI images for `image_reference` blocks in summaries and uploads
 * them to Supabase Storage. Uses Gemini 3.1 Flash image generation
 * (via gemini-image.ts).
 *
 * Storage path: summary-images/{institutionId}/{summaryId}/{orderIndex}.png
 * Serves variants via Supabase Image Transformations (no extra files stored).
 *
 * Differs from flashcard-image-generator.ts in:
 *   - Prompt is optimized for medical diagrams/schematics (not flashcard art)
 *   - Updates summary_blocks.content JSONB (src field) instead of flashcards row
 *   - Uses AXON medical color vocabulary for consistent visual language
 *   - Storage bucket: summary-images (separate from flashcard-images)
 */

import { type SupabaseClient } from "npm:@supabase/supabase-js";
import { generateImage, IMAGE_MODEL } from "./gemini-image.ts";

// ─── Types ──────────────────────────────────────────────────────────

export interface SummaryImageResult {
  imageUrl: string;       // Public URL of PNG in Storage (no transforms)
  model: string;
  promptUsed: string;
}

export interface SummaryImageRequest {
  blockId: string;         // summary_blocks.id
  summaryId: string;       // summaries.id
  institutionId: string;
  orderIndex: number;      // summary_blocks.order_index (used in storage path)
  topic: string;           // topic name for prompt context
  blockTitle: string;      // image_reference block title
  blockAlt: string;        // image_reference block alt text (description)
  blockCaption: string;    // image_reference block caption
  customPrompt?: string;   // optional override prompt
}

// ─── AXON Medical Visual Vocabulary ─────────────────────────────────

const AXON_VISUAL_STYLE = `
Style requirements:
- Clean, professional medical education diagram on white background
- High-contrast colors with consistent medical color coding:
  * Red/orange = inflammation, infection, pathology, heat
  * Blue = normal fluid, veins, parasympathetic, cold
  * Yellow/gold = energy, glucose, positive result, metabolism
  * Purple/dark = death, necrosis, severe pathology
  * Green = healing, normal function, parasympathetic
- Include anatomical labels IN SPANISH
- Use arrows to show direction of flow, progression, or causation
- Labeled anatomical structures with clean lines
- No decorative elements — every visual element must convey medical information
- Suitable for a medical student studying for exams
`.trim();

// ─── Prompt Builder ─────────────────────────────────────────────────

/**
 * Build the image generation prompt for a summary block.
 * Uses the block's alt text and caption as the primary description,
 * enriched with the AXON visual vocabulary for consistent styling.
 */
export function buildSummaryImagePrompt(request: SummaryImageRequest): string {
  if (request.customPrompt?.trim()) {
    return `${request.customPrompt.trim()}\n\n${AXON_VISUAL_STYLE}`;
  }

  return [
    `Create a clear, professional medical education diagram.`,
    `Topic: ${request.topic}.`,
    `Diagram title: ${request.blockTitle}.`,
    `What to illustrate: ${request.blockAlt}.`,
    request.blockCaption
      ? `Additional context: ${request.blockCaption}.`
      : "",
    "",
    AXON_VISUAL_STYLE,
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Storage Helpers ────────────────────────────────────────────────

const BUCKET = "summary-images";

/**
 * Ensure the summary-images bucket exists. Creates it if missing.
 * Uses admin client to bypass RLS.
 */
async function ensureBucket(supabase: SupabaseClient): Promise<void> {
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === BUCKET);

  if (!exists) {
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: 5 * 1024 * 1024, // 5MB
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    });
    if (error && !error.message.includes("already exists")) {
      throw new Error(`[SummaryImage] Failed to create bucket: ${error.message}`);
    }
    console.log(`[SummaryImage] Created bucket: ${BUCKET}`);
  }
}

// ─── Main Pipeline ──────────────────────────────────────────────────

/**
 * Generate an image for a summary's image_reference block and upload
 * to Supabase Storage.
 *
 * Pipeline:
 *   1. Build medical-education prompt with AXON visual vocabulary
 *   2. Ensure storage bucket exists
 *   3. Call Gemini 3.1 Flash image generation
 *   4. Upload PNG to Storage (upsert)
 *   5. Update summary_blocks.content.src with public URL
 *   6. Return URL + metadata
 */
export async function generateSummaryImage(
  supabase: SupabaseClient,
  request: SummaryImageRequest,
): Promise<SummaryImageResult> {
  // 1. Build prompt
  const prompt = buildSummaryImagePrompt(request);

  console.log(
    `[SummaryImage] Generating for block ${request.blockId} ` +
    `(summary=${request.summaryId}, order=${request.orderIndex}), ` +
    `prompt length=${prompt.length}`,
  );

  // 2. Ensure bucket
  await ensureBucket(supabase);

  // 3. Generate image via Gemini
  const generated = await generateImage({ prompt });

  // 4. Upload PNG to Supabase Storage
  const storagePath = `${request.institutionId}/${request.summaryId}/${request.orderIndex}.png`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, generated.imageBuffer, {
      contentType: "image/png",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(
      `[SummaryImage] Storage upload failed: ${uploadError.message}`,
    );
  }

  // 5. Get public URL
  const { data: publicUrlData } = supabase.storage
    .from(BUCKET)
    .getPublicUrl(storagePath);

  const imageUrl = publicUrlData.publicUrl;

  // 6. Update summary_blocks.content.src with the image URL
  //    Fetch current content → merge src → write back (supabase-js doesn't
  //    support jsonb_set natively, so we do a read-modify-write).
  const { data: currentBlock, error: fetchErr } = await supabase
    .from("summary_blocks")
    .select("content")
    .eq("id", request.blockId)
    .single();

  if (fetchErr || !currentBlock?.content) {
    console.error(
      `[SummaryImage] Could not fetch block content: ${fetchErr?.message}`,
    );
    // Don't throw — image was uploaded, URL can be set manually
  } else {
    const updatedContent = {
      ...(currentBlock.content as Record<string, unknown>),
      src: imageUrl,
    };
    const { error: updateErr } = await supabase
      .from("summary_blocks")
      .update({ content: updatedContent })
      .eq("id", request.blockId);

    if (updateErr) {
      console.error(
        `[SummaryImage] Block content update failed: ${updateErr.message}`,
      );
      // Non-fatal — image is in storage, URL can be set via SQL
    }
  }

  console.log(
    `[SummaryImage] Done: ${imageUrl} (${generated.imageBuffer.length} bytes)`,
  );

  return {
    imageUrl,
    model: IMAGE_MODEL,
    promptUsed: prompt,
  };
}
