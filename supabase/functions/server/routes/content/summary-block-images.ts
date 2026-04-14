/**
 * summary-block-images.ts — POST /server/summary-blocks/:id/generate-image
 *
 * Generates an AI image for a summary block of type "image_reference",
 * stores it in Supabase Storage, and updates the block's content.
 *
 * TODO: Implement full image generation pipeline.
 * Currently a stub to unblock Edge Function deployment.
 */

import { Hono } from "npm:hono";
import { authenticate, err, PREFIX } from "../../db.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import type { Context } from "npm:hono";

export const summaryBlockImageRoutes = new Hono();

summaryBlockImageRoutes.post(
  `${PREFIX}/summary-blocks/:id/generate-image`,
  async (c: Context) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const { db, user } = auth;

    const blockId = c.req.param("id");
    if (!blockId) return err(c, "Missing block ID", 400);

    // Resolve institution via block → summary
    const { data: block, error: blockErr } = await db
      .from("summary_blocks")
      .select("id, summary_id, type")
      .eq("id", blockId)
      .single();

    if (blockErr || !block) return err(c, "Block not found", 404);

    const { data: summary, error: sumErr } = await db
      .from("summaries")
      .select("institution_id")
      .eq("id", block.summary_id)
      .single();

    if (sumErr || !summary) return err(c, "Summary not found", 404);

    const roleCheck = await requireInstitutionRole(
      db,
      user.id,
      summary.institution_id,
      CONTENT_WRITE_ROLES,
    );
    if (isDenied(roleCheck)) {
      return err(c, roleCheck.message, roleCheck.status);
    }

    return err(c, "Image generation for summary blocks is not yet implemented", 501);
  },
);
