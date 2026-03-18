/**
 * routes/ai/ingest-pdf.ts — PDF upload + text extraction + summary creation
 *
 * POST /ai/ingest-pdf
 *   FormData: file, institution_id, topic_id, title (optional)
 *
 * Fase 7, Feature #13. Decisions D47-D53.
 */

import { Hono } from "npm:hono";
import type { Context } from "npm:hono";
import {
  authenticate,
  getAdminClient,
  ok,
  err,
  PREFIX,
} from "../../db.ts";
import { isUuid } from "../../validate.ts";
import { safeErr } from "../../lib/safe-error.ts";
import {
  requireInstitutionRole,
  isDenied,
  CONTENT_WRITE_ROLES,
} from "../../auth-helpers.ts";
import { extractTextFromPdf } from "../../gemini.ts";
import { autoChunkAndEmbed } from "../../auto-ingest.ts";
import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";

export const aiIngestPdfRoutes = new Hono();

const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ["application/pdf"];
const STORAGE_BUCKET = "pdf-sources";

function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function validateTopicInstitution(
  adminDb: ReturnType<typeof getAdminClient>,
  topicId: string,
  institutionId: string,
): Promise<{ id: string; section_id: string } | null> {
  const { data, error } = await adminDb
    .from("topics")
    .select(`
      id, section_id,
      sections!inner (
        semesters!inner (
          courses!inner ( institution_id )
        )
      )
    `)
    .eq("id", topicId)
    .eq("sections.semesters.courses.institution_id", institutionId)
    .single();

  if (error || !data) return null;
  return { id: data.id as string, section_id: data.section_id as string };
}

aiIngestPdfRoutes.post(`${PREFIX}/ai/ingest-pdf`, async (c: Context) => {
  // Step 1: Auth
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const { user, db } = auth;

  // Step 2: Parse FormData
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (_e) {
    return err(c, "Invalid request: expected multipart/form-data with a PDF file", 400);
  }

  const file = formData.get("file");
  const institutionId = formData.get("institution_id") as string | null;
  const topicId = formData.get("topic_id") as string | null;
  const titleInput = formData.get("title") as string | null;

  // Step 3: Validate inputs
  if (!institutionId || !isUuid(institutionId)) {
    return err(c, "institution_id is required (UUID)", 400);
  }
  if (!topicId || !isUuid(topicId)) {
    return err(c, "topic_id is required (UUID)", 400);
  }

  // Role check (PF-05: DB before Gemini)
  const roleCheck = await requireInstitutionRole(db, user.id, institutionId, CONTENT_WRITE_ROLES);
  if (isDenied(roleCheck)) {
    return err(c, roleCheck.message, roleCheck.status);
  }

  // Step 4: Validate file
  if (!file || !(file instanceof File)) {
    return err(c, "file is required (PDF upload via FormData)", 400);
  }
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return err(c, `Invalid file type: ${file.type}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`, 400);
  }
  if (file.size > MAX_PDF_SIZE_BYTES) {
    const maxMB = (MAX_PDF_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    const fileMB = (file.size / (1024 * 1024)).toFixed(1);
    return err(c, `File too large: ${fileMB}MB (max ${maxMB}MB)`, 413);
  }
  if (file.size === 0) {
    return err(c, "File is empty (0 bytes)", 400);
  }

  // Step 5: Validate topic belongs to institution
  const adminDb = getAdminClient();
  const topic = await validateTopicInstitution(adminDb, topicId, institutionId);
  if (!topic) {
    return err(c, "topic_id not found or does not belong to this institution", 404);
  }

  // Step 6: Extract text from PDF
  let extractResult: { text: string; tokensUsed: { input: number; output: number } };
  try {
    const buffer = await file.arrayBuffer();
    const base64 = encodeBase64(new Uint8Array(buffer));
    extractResult = await extractTextFromPdf(base64, file.type);
  } catch (e) {
    const message = (e as Error).message;
    if (message.includes("timeout")) {
      return err(c, "PDF extraction timed out. Try a smaller PDF or split it into parts.", 504);
    }
    return err(c, `PDF text extraction failed: ${message}`, 502);
  }

  const extractedText = extractResult.text.trim();
  if (extractedText.length === 0) {
    return err(c, "PDF extraction returned empty text. The PDF may be image-only or corrupted.", 422);
  }

  // Step 7-8: Create summary
  const originalFilename = file.name || "upload.pdf";
  const title = titleInput?.trim() || titleFromFilename(originalFilename);

  const { data: maxOrderRow } = await adminDb
    .from("summaries")
    .select("order_index")
    .eq("topic_id", topicId)
    .order("order_index", { ascending: false })
    .limit(1)
    .single();

  const nextOrder = ((maxOrderRow?.order_index as number) ?? -1) + 1;
  const wordCount = extractedText.split(/\s+/).filter(Boolean).length;

  const { data: newSummary, error: insertErr } = await adminDb
    .from("summaries")
    .insert({
      topic_id: topicId,
      institution_id: institutionId,
      title,
      content_markdown: extractedText,
      source_type: "pdf",
      source_file_name: originalFilename,
      order_index: nextOrder,
      is_active: true,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (insertErr || !newSummary) {
    return safeErr(c, "Create summary", insertErr);
  }

  const summaryId = newSummary.id as string;

  // Step 9: Upload PDF to Storage (non-critical)
  let storagePath: string | null = null;
  try {
    const filePath = `${institutionId}/${summaryId}/${originalFilename}`;
    const fileBuffer = await file.arrayBuffer();
    const { error: uploadErr } = await adminDb.storage
      .from(STORAGE_BUCKET)
      .upload(filePath, fileBuffer, { contentType: file.type, upsert: false });

    if (uploadErr) {
      console.warn(`[Ingest-PDF] Storage upload failed for ${summaryId}: ${uploadErr.message}`);
    } else {
      storagePath = filePath;
      await adminDb.from("summaries").update({ source_file_path: storagePath }).eq("id", summaryId);
    }
  } catch (e) {
    console.warn(`[Ingest-PDF] Storage upload exception for ${summaryId}: ${(e as Error).message}`);
  }

  // Step 10: Fire-and-forget chunking
  let chunkingStatus = "skipped";
  try {
    const chunkPromise = autoChunkAndEmbed(summaryId, institutionId)
      .then((r) => {
        console.info(`[Ingest-PDF] Chunking done for ${summaryId}: ${r.chunks_created} chunks (${r.strategy_used}), ${r.embeddings_generated} embedded, ${r.elapsed_ms}ms`);
      })
      .catch((e) => {
        console.error(`[Ingest-PDF] Chunking failed for ${summaryId}: ${e.message}`);
      });

    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(chunkPromise);
    }
    chunkingStatus = "started";
  } catch (e) {
    console.warn(`[Ingest-PDF] Failed to start chunking for ${summaryId}: ${(e as Error).message}`);
  }

  // Step 11: Return result
  console.info(
    `[Ingest-PDF] Summary ${summaryId} created from PDF "${originalFilename}" ` +
      `(${wordCount} words, ${extractedText.length} chars, ` +
      `tokens: ${extractResult.tokensUsed.input}in/${extractResult.tokensUsed.output}out)`,
  );

  return ok(c, {
    summary_id: summaryId,
    title,
    source_type: "pdf",
    source_file_name: originalFilename,
    source_file_path: storagePath,
    word_count: wordCount,
    char_count: extractedText.length,
    tokens_used: extractResult.tokensUsed,
    chunking_status: chunkingStatus,
  });
});
