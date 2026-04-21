/**
 * infographic-images.ts — Infographic generation endpoints
 *
 * POST /server/summaries/:id/generate-infographics
 *   → Auto-selects top 2 concepts, generates Instagram-style infographics
 *   → Returns array of { image_url, concept_title, concept_index }
 *
 * POST /server/summaries/:id/generate-infographic
 *   → Single infographic with custom concept (manual mode)
 *   → Body: { conceptTitle, conceptDescription, keyElements, customPrompt? }
 *
 * Auth: professor, admin, or owner role in the summary's institution.
 * Storage: infographic-images/{institutionId}/{summaryId}/{conceptIndex}.png
 */

import { Hono } from "npm:hono";
import { authenticate, ok, err, PREFIX, getAdminClient } from "../../db.ts";
import { safeErr } from "../../lib/safe-error.ts";
import { isUuid } from "../../validate.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import {
  generateInfographicsForSummary,
  generateInfographic,
} from "../../infographic-image-generator.ts";
import type { Context } from "npm:hono";

export const infographicImageRoutes = new Hono();

// ─── Helper: resolve summary context ────────────────────────────────

async function resolveSummaryContext(
  admin: ReturnType<typeof getAdminClient>,
  summaryId: string,
) {
  // Fetch summary → institution + topic
  const { data: summary, error: sumErr } = await admin
    .from("summaries")
    .select("id, institution_id, topic_id, title")
    .eq("id", summaryId)
    .single();

  if (sumErr || !summary) return null;

  // Resolve topic name
  let topicName = "Tema médico";
  let category = "Medicina";

  if (summary.topic_id) {
    const { data: topic } = await admin
      .from("topics")
      .select("name, section_id")
      .eq("id", summary.topic_id)
      .single();

    if (topic?.name) topicName = topic.name;

    // Resolve section → semester → course for category
    if (topic?.section_id) {
      const { data: section } = await admin
        .from("sections")
        .select("name, semester_id")
        .eq("id", topic.section_id)
        .single();

      if (section?.semester_id) {
        const { data: semester } = await admin
          .from("semesters")
          .select("course_id")
          .eq("id", section.semester_id)
          .single();

        if (semester?.course_id) {
          const { data: course } = await admin
            .from("courses")
            .select("name")
            .eq("id", semester.course_id)
            .single();

          if (course?.name) category = course.name;
        }
      }

      // Use section name as more specific category if available
      if (section?.name) category = section.name;
    }
  }

  return { summary, topicName, category };
}

// ─── POST /server/summaries/:id/generate-infographics ───────────────
// Auto mode: selects top 2 concepts and generates infographics

infographicImageRoutes.post(
  `${PREFIX}/summaries/:id/generate-infographics`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const summaryId = c.req.param("id");
    if (!isUuid(summaryId)) return err(c, "summary id must be a valid UUID", 400);

    // Parse optional body
    let body: { maxImages?: number };
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const admin = getAdminClient();

    // Resolve summary context
    const ctx = await resolveSummaryContext(admin, summaryId);
    if (!ctx) return err(c, "Summary not found", 404);

    // Validate role
    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      ctx.summary.institution_id,
      CONTENT_WRITE_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }

    try {
      const results = await generateInfographicsForSummary(
        admin,
        summaryId,
        ctx.summary.institution_id,
        ctx.topicName,
        ctx.category,
        body.maxImages,
      );

      // Log generation
      for (const result of results) {
        await admin
          .from("image_generation_log")
          .insert({
            summary_id: summaryId,
            institution_id: ctx.summary.institution_id,
            user_id: user.id,
            image_url: result.imageUrl,
            model: result.model,
            prompt_used: result.promptUsed,
            image_type: "infographic",
            created_at: new Date().toISOString(),
          })
          .then(({ error: logErr }) => {
            if (logErr) {
              console.warn(
                `[Infographic] Log insert failed: ${logErr.message}`,
              );
            }
          });
      }

      return ok(c, {
        infographics: results.map((r) => ({
          image_url: r.imageUrl,
          concept_title: r.conceptTitle,
          concept_index: r.conceptIndex,
          model: r.model,
        })),
        summary_id: summaryId,
        topic: ctx.topicName,
        category: ctx.category,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      console.error(
        `[Infographic] Batch generation failed for summary ${summaryId}:`,
        message,
      );
      return err(c, `Infographic generation failed: ${message}`, 500);
    }
  },
);

// ─── POST /server/summaries/:id/generate-infographic ────────────────
// Manual mode: single infographic with custom concept

infographicImageRoutes.post(
  `${PREFIX}/summaries/:id/generate-infographic`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;

    const summaryId = c.req.param("id");
    if (!isUuid(summaryId)) return err(c, "summary id must be a valid UUID", 400);

    let body: {
      conceptTitle?: string;
      conceptDescription?: string;
      keyElements?: string[];
      conceptIndex?: number;
      customPrompt?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return err(c, "Invalid JSON body", 400);
    }

    if (!body.conceptTitle) {
      return err(c, "conceptTitle is required", 400);
    }

    const admin = getAdminClient();

    const ctx = await resolveSummaryContext(admin, summaryId);
    if (!ctx) return err(c, "Summary not found", 404);

    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      ctx.summary.institution_id,
      CONTENT_WRITE_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }

    try {
      const result = await generateInfographic(admin, {
        summaryId,
        institutionId: ctx.summary.institution_id,
        topic: ctx.topicName,
        category: ctx.category,
        conceptTitle: body.conceptTitle,
        conceptDescription: body.conceptDescription ?? body.conceptTitle,
        keyElements: body.keyElements ?? [body.conceptTitle],
        conceptIndex: body.conceptIndex ?? 0,
        customPrompt: body.customPrompt,
      });

      // Log
      await admin
        .from("image_generation_log")
        .insert({
          summary_id: summaryId,
          institution_id: ctx.summary.institution_id,
          user_id: user.id,
          image_url: result.imageUrl,
          model: result.model,
          prompt_used: result.promptUsed,
          image_type: "infographic",
          created_at: new Date().toISOString(),
        })
        .then(({ error: logErr }) => {
          if (logErr) {
            console.warn(`[Infographic] Log insert failed: ${logErr.message}`);
          }
        });

      return ok(c, {
        image_url: result.imageUrl,
        concept_title: result.conceptTitle,
        concept_index: result.conceptIndex,
        model: result.model,
        summary_id: summaryId,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      console.error(
        `[Infographic] Single generation failed for summary ${summaryId}:`,
        message,
      );
      return err(c, `Infographic generation failed: ${message}`, 500);
    }
  },
);
