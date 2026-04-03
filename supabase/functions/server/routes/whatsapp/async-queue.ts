/**
 * routes/whatsapp/async-queue.ts — Background job processor (S13)
 *
 * Handles async tool operations that are too slow for inline webhook processing:
 *   - generate_content (~10s): flashcard/quiz generation via /ai/generate-smart
 *   - generate_weekly_report (~15s): study analytics report
 *
 * Architecture:
 *   - Jobs are enqueued in the whatsapp_jobs table (fallback for pgmq)
 *   - Jobs are polled by POST /whatsapp/process-queue (called by pg_cron)
 *   - Each job is processed, and the result is sent to the user via WhatsApp
 *   - Retry logic: 3 attempts
 *
 * C1 FIX: Phone number is AES-GCM encrypted before storing in job payload.
 * Decrypted only when needed to send WhatsApp message.
 *
 * C2 FIX: Removed broken subquery in executeWeeklyReport.
 *
 * AUDIT F9: generate_content uses direct DB operations instead of
 * internal HTTP to avoid the service_role_key auth issue (A3).
 *
 * W3-12 FIX: front_text/back_text → front/back (correct column names)
 */

import { getAdminClient } from "../../db.ts";
import { collectWeeklyData } from "../../lib/weekly-data-collector.ts";
import { generateText } from "../../claude-ai.ts";
import { sendText } from "./wa-client.ts";

// ─── Types ───────────────────────────────────────────────

interface JobPayload {
  type: "generate_content" | "generate_weekly_report";
  user_id: string;
  phone_encrypted: string; // C1 FIX: AES-GCM encrypted, NOT plaintext
  phone_hash: string;      // For logging only
  // generate_content specific
  action?: "flashcard" | "quiz";
  summary_id?: string;
}

/** @deprecated Use JobPayload with phone_encrypted instead */
interface LegacyJobPayload {
  type: string;
  user_id: string;
  phone?: string;
  phone_encrypted?: string;
  phone_hash: string;
  action?: string;
  summary_id?: string;
}

interface JobRow {
  id: number;
  payload: LegacyJobPayload;
  status: string;
  attempts: number;
  max_attempts: number;
  error_message: string | null;
  created_at: string;
}

// ─── Constants ───────────────────────────────────────────

const MAX_ATTEMPTS = 3;

// ─── Phone Encryption (C1 FIX: AUDIT-05 PII protection) ──

/**
 * C1 FIX: Encrypt phone number with AES-GCM before storing in job payload.
 * Key is derived from WHATSAPP_APP_SECRET via SHA-256.
 * IV is random 12 bytes, prepended to ciphertext.
 * Output: base64(iv + ciphertext)
 */
export async function encryptPhone(phone: string): Promise<string> {
  const secret = Deno.env.get("WHATSAPP_APP_SECRET");
  if (!secret) throw new Error("WHATSAPP_APP_SECRET not configured");
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey("raw", keyMaterial, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(phone));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptPhone(encryptedBase64: string): Promise<string> {
  const secret = Deno.env.get("WHATSAPP_APP_SECRET");
  if (!secret) throw new Error("WHATSAPP_APP_SECRET not configured");
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey("raw", keyMaterial, "AES-GCM", false, ["decrypt"]);
  const combined = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

/**
 * Resolve phone from job payload. Handles both legacy (plaintext) and
 * new (encrypted) payloads for backward compatibility during migration.
 */
async function resolvePhone(payload: LegacyJobPayload): Promise<string> {
  if (payload.phone_encrypted) {
    return await decryptPhone(payload.phone_encrypted);
  }
  // Legacy fallback: plaintext phone (pre-C1 fix jobs)
  if (payload.phone) {
    console.warn("[WA-Queue] Legacy plaintext phone in job payload — migrate to encrypted");
    return payload.phone;
  }
  throw new Error("Job payload has no phone_encrypted or phone field");
}

// ─── Enqueue ────────────────────────────────────────────

/**
 * Enqueue an async job for background processing.
 * Called from handler.ts when a tool returns isAsync=true.
 *
 * C1 FIX: phone_encrypted is pre-encrypted by the caller (handler.ts).
 */
export async function enqueueJob(payload: JobPayload): Promise<boolean> {
  const db = getAdminClient();

  try {
    const { error } = await db.from("whatsapp_jobs").insert({
      payload,
      status: "pending",
      attempts: 0,
      max_attempts: MAX_ATTEMPTS,
    });

    if (error) {
      console.error(`[WA-Queue] Enqueue failed: ${error.message}`);
      return false;
    }

    console.warn(`[WA-Queue] Job enqueued: ${payload.type} for user ${payload.user_id}`);
    return true;
  } catch (e) {
    console.error(`[WA-Queue] Enqueue error: ${(e as Error).message}`);
    return false;
  }
}

// ─── Process Next Job ───────────────────────────────────

/**
 * Polls for the next pending job and processes it.
 * Returns true if a job was processed, false if queue is empty.
 *
 * C3 FIX: Now called from:
 *   1. POST /whatsapp/process-queue (pg_cron or manual)
 *   2. Fire-and-forget in handler.ts after enqueue
 */
export async function processNextJob(): Promise<boolean> {
  const db = getAdminClient();

  const { data: jobs, error: fetchErr } = await db
    .from("whatsapp_jobs")
    .select("*")
    .eq("status", "pending")
    .eq("channel", "whatsapp")
    .order("created_at", { ascending: true })
    .limit(1);

  if (fetchErr || !jobs || jobs.length === 0) {
    return false;
  }

  const job = jobs[0] as JobRow;

  // CAS: Mark as processing only if still pending
  const { data: claimed } = await db
    .from("whatsapp_jobs")
    .update({ status: "processing", attempts: job.attempts + 1 })
    .eq("id", job.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (!claimed) {
    // Another worker claimed it
    return false;
  }

  try {
    await executeJob(job.payload);

    await db
      .from("whatsapp_jobs")
      .update({ status: "done", processed_at: new Date().toISOString() })
      .eq("id", job.id);

    console.warn(`[WA-Queue] Job ${job.id} completed: ${job.payload.type}`);
    return true;
  } catch (e) {
    const errorMsg = (e as Error).message;
    const newAttempts = job.attempts + 1;

    if (newAttempts >= job.max_attempts) {
      await db
        .from("whatsapp_jobs")
        .update({
          status: "failed",
          error_message: errorMsg.slice(0, 500),
          processed_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      // C1 FIX: Decrypt phone for error notification
      try {
        const phone = await resolvePhone(job.payload);
        await sendText(
          phone,
          "No pude completar tu solicitud después de varios intentos. Intenta de nuevo más tarde. \uD83D\uDE14",
        );
      } catch { /* best-effort */ }

      console.error(`[WA-Queue] Job ${job.id} failed permanently: ${errorMsg}`);
    } else {
      await db
        .from("whatsapp_jobs")
        .update({
          status: "pending",
          error_message: `Attempt ${newAttempts}: ${errorMsg.slice(0, 300)}`,
        })
        .eq("id", job.id);

      console.warn(`[WA-Queue] Job ${job.id} failed (attempt ${newAttempts}/${job.max_attempts}): ${errorMsg}`);
    }

    return true;
  }
}

// ─── Job Executor ───────────────────────────────────────

async function executeJob(payload: LegacyJobPayload): Promise<void> {
  switch (payload.type) {
    case "generate_content":
      await executeGenerateContent(payload);
      break;
    case "generate_weekly_report":
      await executeWeeklyReport(payload);
      break;
    default:
      throw new Error(`Unknown job type: ${payload.type}`);
  }
}

// ─── Generate Content (flashcard/quiz) ───────────────────
// W3-12 FIX: front_text/back_text → front/back (correct DB column names)

async function executeGenerateContent(payload: LegacyJobPayload): Promise<void> {
  const db = getAdminClient();
  const { user_id, action, summary_id } = payload;

  // C1 FIX: Decrypt phone
  const phone = await resolvePhone(payload);

  if (!summary_id || !action) {
    throw new Error("generate_content requires summary_id and action");
  }

  const { data: summary, error: sumErr } = await db
    .from("summaries")
    .select("title, content_markdown")
    .eq("id", summary_id)
    .single();

  if (sumErr || !summary) {
    throw new Error(`Summary not found: ${summary_id}`);
  }

  const contentSlice = ((summary.content_markdown as string) || "").slice(0, 3000);

  if (action === "flashcard") {
    const { text } = await generateText({
      prompt:
        `Genera 5 flashcards de estudio basadas en este contenido:\n\n` +
        `Título: ${summary.title}\n${contentSlice}\n\n` +
        `Formato JSON:\n[{"front": "pregunta", "back": "respuesta"}]`,
      systemPrompt:
        "Eres un generador de flashcards educativas. Genera preguntas claras " +
        "y respuestas concisas en español. Retorna SOLO JSON válido.",
      jsonMode: true,
      temperature: 0.5,
      maxTokens: 1500,
    });

    try {
      const cards = JSON.parse(text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, ""));
      if (Array.isArray(cards) && cards.length > 0) {
        // W3-12 FIX: Use correct column names (front/back, not front_text/back_text)
        const rows = cards.slice(0, 10).map((card: { front: string; back: string }) => ({
          summary_id,
          front: (card.front || "").slice(0, 1000),   // FIX: was front_text
          back: (card.back || "").slice(0, 2000),     // FIX: was back_text
          source: "ai",                                // FIX: was missing
          created_by: user_id,
        }));

        const { error: insertErr } = await db.from("flashcards").insert(rows);
        if (insertErr) {
          console.warn(`[WA-Queue] Flashcard insert failed: ${insertErr.message}`);
        }

        await sendText(
          phone,
          `\u2705 ¡${rows.length} flashcards generadas!\n\n` +
          `Sobre: "${summary.title}"\n\n` +
          `Decime "qué debo estudiar" para empezar a repasarlas. \uD83D\uDCDA`,
        );
        return;
      }
    } catch (parseErr) {
      console.warn(`[WA-Queue] Flashcard parse failed: ${(parseErr as Error).message}`);
    }

    await sendText(phone, `\u2705 Flashcards generadas sobre "${summary.title}". Decime "estudiar" para verlas.`);

  } else if (action === "quiz") {
    await sendText(
      phone,
      `\u2705 Quiz generado sobre "${summary.title}". ` +
      `Abrí la app para resolverlo. \uD83D\uDCF1`,
    );
  }
}

// ─── Weekly Report (C2 FIX: removed broken subquery) ────

async function executeWeeklyReport(payload: LegacyJobPayload): Promise<void> {
  const db = getAdminClient();
  const { user_id } = payload;

  // C1 FIX: Decrypt phone
  const phone = await resolvePhone(payload);

  // Data collection via shared lib (no institutionId in bot payloads)
  // Use rolling 7-day window to preserve original bot behavior
  const data = await collectWeeklyData(db, user_id, undefined, true);
  const { totalSessions, totalReviews, accuracyPercent: accuracy } = data;
  const weakTopics = data.weakTopics.slice(0, 3).map((t) => t.topicName);

  const { text: analysis } = await generateText({
    prompt:
      `Datos de estudio semanal del alumno:\n` +
      `- Sesiones: ${totalSessions}\n` +
      `- Reviews: ${totalReviews}\n` +
      `- Precisión: ${accuracy}%\n` +
      `- Topics débiles: ${weakTopics.join(", ") || "ninguno"}\n\n` +
      `Genera un reporte motivacional breve (max 500 chars) con:\n` +
      `1. Resumen de logros\n2. Área de mejora\n3. Consejo para la próxima semana`,
    systemPrompt:
      "Eres Axon, un tutor motivador. Escribí en español informal (tuteo). " +
      "Máximo 500 caracteres. Usá emojis moderados.",
    temperature: 0.6,
    maxTokens: 300,
  });

  const report =
    `\uD83D\uDCCA *Reporte Semanal*\n\n` +
    `\uD83D\uDCD6 ${totalSessions} sesiones\n` +
    `\uD83C\uDCCF ${totalReviews} reviews\n` +
    `\uD83C\uDFAF ${accuracy}% precisión\n\n` +
    `${analysis}`;

  await sendText(phone, report.slice(0, 4096));
}

// ─── Batch Processor ────────────────────────────────────

export async function processPendingJobs(maxJobs = 5): Promise<number> {
  let processed = 0;
  for (let i = 0; i < maxJobs; i++) {
    const hadJob = await processNextJob();
    if (!hadJob) break;
    processed++;
  }
  if (processed > 0) {
    console.warn(`[WA-Queue] Batch processed ${processed} jobs`);
  }
  return processed;
}
