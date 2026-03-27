/**
 * flashcard-images.ts — POST /server/flashcards/:id/generate-image
 *
 * Generates an AI image for a flashcard, stores it in Supabase Storage,
 * and updates the flashcard row with the image URL and metadata.
 *
 * Auth: professor, admin, or owner role in the flashcard's institution.
 *
 * FC-02
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import { generateFlashcardImage } from "../../flashcard-image-generator.ts";
import type { Context } from "npm:hono";

export const flashcardImageRoutes = new Hono();

flashcardImageRoutes.post(
  `${PREFIX}/flashcards/:id/generate-image`,
  async (c: Context) => {
    // ── 1. Auth ─────────────────────────────────────────────
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const flashcardId = c.req.param("id");
    if (!flashcardId) return err(c, "Missing flashcard ID", 400);

    // ── 2. Parse body ───────────────────────────────────────
    let body: { imagePrompt?: string; stylePackId?: string };
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const admin = getAdminClient();

    // ── 3. Fetch flashcard + resolve institution ────────────
    const { data: flashcard, error: fcErr } = await admin
      .from("flashcards")
      .select("id, summary_id, front_text, back_text")
      .eq("id", flashcardId)
      .single();

    if (fcErr || !flashcard) {
      return err(c, "Flashcard not found", 404);
    }

    // Get summary to resolve institution_id and topic
    const { data: summary, error: sumErr } = await admin
      .from("summaries")
      .select("id, institution_id, topic_id")
      .eq("id", flashcard.summary_id)
      .single();

    if (sumErr || !summary) {
      return err(c, "Summary not found for flashcard", 404);
    }

    // ── 4. Validate role ────────────────────────────────────
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      summary.institution_id,
      CONTENT_WRITE_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }

    // ── 5. Resolve topic name ───────────────────────────────
    let topicName = "Medical topic";
    if (summary.topic_id) {
      const { data: topic } = await admin
        .from("topics")
        .select("name")
        .eq("id", summary.topic_id)
        .single();
      if (topic?.name) topicName = topic.name;
    }

    // ── 6. Fetch style pack reference images (if provided) ──
    let stylePackUrls: string[] | undefined;
    if (body.stylePackId) {
      const { data: stylePack } = await admin
        .from("style_packs")
        .select("reference_images")
        .eq("id", body.stylePackId)
        .single();

      if (stylePack?.reference_images && Array.isArray(stylePack.reference_images)) {
        stylePackUrls = stylePack.reference_images;
      }
    }

    // ── 7. Generate image ───────────────────────────────────
    try {
      const result = await generateFlashcardImage(admin, {
        flashcardId,
        institutionId: summary.institution_id,
        topic: topicName,
        content: `${flashcard.front_text ?? ""}\n${flashcard.back_text ?? ""}`.trim(),
        imagePrompt: body.imagePrompt,
        stylePackUrls,
      });

      // ── 8. Update flashcard row ─────────────────────────────
      const now = new Date().toISOString();

      const { error: updateErr } = await admin
        .from("flashcards")
        .update({
          image_url: result.imageUrl,
          image_prompt: result.promptUsed,
          image_model: result.model,
          image_generated_at: now,
          updated_at: now,
        })
        .eq("id", flashcardId);

      if (updateErr) {
        return safeErr(c, "Update flashcard image metadata", updateErr);
      }

      // ── 9. Log generation ───────────────────────────────────
      await admin
        .from("image_generation_log")
        .insert({
          flashcard_id: flashcardId,
          institution_id: summary.institution_id,
          user_id: user.id,
          image_url: result.imageUrl,
          model: result.model,
          prompt_used: result.promptUsed,
          style_pack_id: body.stylePackId ?? null,
          created_at: now,
        })
        .then(({ error: logErr }) => {
          if (logErr) {
            console.warn(
              `[FlashcardImage] Log insert failed for ${flashcardId}:`,
              logErr.message,
            );
          }
        });

      // ── 10. Return result ───────────────────────────────────
      return ok(c, {
        image_url: result.imageUrl,
        model: result.model,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      console.error(
        `[FlashcardImage] Generation failed for ${flashcardId}:`,
        message,
      );
      return err(c, `Image generation failed: ${message}`, 500);
    }
  },
);
