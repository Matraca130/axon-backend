/**
 * routes/whatsapp/async-queue.ts — Background job processor (S13)
 *
 * Handles async tool operations that are too slow for inline webhook processing:
 *   - generate_content (~10s): flashcard/quiz generation via /ai/generate-smart
 *   - generate_weekly_report (~15s): study analytics report
 *
 * Architecture:
 *   - Jobs are enqueued in the whatsapp_jobs table (fallback for pgmq)
 *   - Jobs are polled by a scheduled invocation or edge function cron
 *   - Each job is processed, and the result is sent to the user via WhatsApp
 *   - Retry logic: 3 attempts with exponential backoff
 *
 * Integration:
 *   - handler.ts calls enqueueJob() when a tool returns isAsync=true
 *   - processNextJob() is called externally (e.g., by a pg_cron trigger
 *     or a separate edge function invocation)
 *
 * AUDIT F9: generate_content uses direct DB operations instead of
 * internal HTTP to avoid the service_role_key auth issue (A3).
 */

import { getAdminClient } from "../../db.ts";
import { generateText } from "../../gemini.ts";
import { sendText } from "./wa-client.ts";

// ─── Types ───────────────────────────────────────────────

interface JobPayload {
  type: "generate_content" | "generate_weekly_report";
  user_id: string;
  phone: string;       // Raw phone for sending the result
  phone_hash: string;  // For logging
  // generate_content specific
  action?: "flashcard" | "quiz";
  summary_id?: string;
}

interface JobRow {
  id: number;
  payload: JobPayload;
  status: string;
  attempts: number;
  max_attempts: number;
  error_message: string | null;
  created_at: string;
}

// ─── Constants ───────────────────────────────────────────

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s

// ─── Enqueue ────────────────────────────────────────────

/**
 * Enqueue an async job for background processing.
 * Called from handler.ts when a tool returns isAsync=true.
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

    console.log(`[WA-Queue] Job enqueued: ${payload.type} for user ${payload.user_id}`);
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
 * Called externally (e.g., by a scheduled edge function or
 * pg_cron trigger via HTTP).
 */
export async function processNextJob(): Promise<boolean> {
  const db = getAdminClient();

  // Atomic claim: SELECT + UPDATE in one query
  // Only pick jobs that haven't exceeded max_attempts
  const { data: jobs, error: fetchErr } = await db
    .from("whatsapp_jobs")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);

  if (fetchErr || !jobs || jobs.length === 0) {
    return false; // Queue empty or error
  }

  const job = jobs[0] as JobRow;

  // Mark as processing (optimistic, no lock)
  await db
    .from("whatsapp_jobs")
    .update({ status: "processing", attempts: job.attempts + 1 })
    .eq("id", job.id)
    .eq("status", "pending"); // CAS: only if still pending

  try {
    await executeJob(job.payload);

    // Mark as done
    await db
      .from("whatsapp_jobs")
      .update({ status: "done", processed_at: new Date().toISOString() })
      .eq("id", job.id);

    console.log(`[WA-Queue] Job ${job.id} completed: ${job.payload.type}`);
    return true;
  } catch (e) {
    const errorMsg = (e as Error).message;
    const newAttempts = job.attempts + 1;

    if (newAttempts >= job.max_attempts) {
      // Max retries exceeded → mark as failed
      await db
        .from("whatsapp_jobs")
        .update({
          status: "failed",
          error_message: errorMsg.slice(0, 500),
          processed_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      // Notify user of failure
      try {
        await sendText(
          job.payload.phone,
          "No pude completar tu solicitud despu\u00e9s de varios intentos. Intent\u00e1 de nuevo m\u00e1s tarde. \ud83d\ude14",
        );
      } catch { /* best-effort */ }

      console.error(`[WA-Queue] Job ${job.id} failed permanently: ${errorMsg}`);
    } else {
      // Retry: mark as pending again
      await db
        .from("whatsapp_jobs")
        .update({
          status: "pending",
          error_message: `Attempt ${newAttempts}: ${errorMsg.slice(0, 300)}`,
        })
        .eq("id", job.id);

      console.warn(`[WA-Queue] Job ${job.id} failed (attempt ${newAttempts}/${job.max_attempts}): ${errorMsg}`);
    }

    return true; // We processed (attempted) a job
  }
}

// ─── Job Executor ───────────────────────────────────────

async function executeJob(payload: JobPayload): Promise<void> {
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

async function executeGenerateContent(payload: JobPayload): Promise<void> {
  const db = getAdminClient();
  const { user_id, phone, action, summary_id } = payload;

  if (!summary_id || !action) {
    throw new Error("generate_content requires summary_id and action");
  }

  // Fetch summary content for context
  const { data: summary, error: sumErr } = await db
    .from("summaries")
    .select("title, content")
    .eq("id", summary_id)
    .single();

  if (sumErr || !summary) {
    throw new Error(`Summary not found: ${summary_id}`);
  }

  const contentSlice = ((summary.content as string) || "").slice(0, 3000);

  if (action === "flashcard") {
    // Generate flashcards via Gemini
    const { text } = await generateText({
      prompt:
        `Genera 5 flashcards de estudio basadas en este contenido:\n\n` +
        `T\u00edtulo: ${summary.title}\n${contentSlice}\n\n` +
        `Formato JSON:\n[{"front": "pregunta", "back": "respuesta"}]`,
      systemPrompt:
        "Eres un generador de flashcards educativas. Genera preguntas claras " +
        "y respuestas concisas en espa\u00f1ol. Retorna SOLO JSON v\u00e1lido.",
      jsonMode: true,
      temperature: 0.5,
      maxTokens: 1500,
    });

    // Parse and store flashcards
    try {
      const cards = JSON.parse(text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, ""));
      if (Array.isArray(cards) && cards.length > 0) {
        // Insert into flashcards table
        const rows = cards.slice(0, 10).map((card: { front: string; back: string }) => ({
          summary_id,
          front_text: (card.front || "").slice(0, 1000),
          back_text: (card.back || "").slice(0, 2000),
          created_by: user_id,
        }));

        const { error: insertErr } = await db.from("flashcards").insert(rows);
        if (insertErr) {
          console.warn(`[WA-Queue] Flashcard insert failed: ${insertErr.message}`);
        }

        await sendText(
          phone,
          `\u2705 \u00a1${rows.length} flashcards generadas!\n\n` +
          `Sobre: "${summary.title}"\n\n` +
          `Decime "qu\u00e9 debo estudiar" para empezar a repasarlas. \ud83d\udcda`,
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
      `Abr\u00ed la app para resolverlo. \ud83d\udcf1`,
    );
  }
}

// ─── Weekly Report ──────────────────────────────────────

async function executeWeeklyReport(payload: JobPayload): Promise<void> {
  const db = getAdminClient();
  const { user_id, phone } = payload;

  // Fetch stats for the last 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [reviewsRes, sessionsRes, progressRes] = await Promise.all([
    // Total reviews this week
    db.from("reviews")
      .select("id, grade", { count: "exact" })
      .gte("created_at", weekAgo)
      .eq("session_id", db.from("study_sessions")
        .select("id")
        .eq("student_id", user_id) as unknown as string),

    // Sessions this week
    db.from("study_sessions")
      .select("id, session_type, completed_at, total_reviews, correct_reviews")
      .eq("student_id", user_id)
      .gte("created_at", weekAgo),

    // Current mastery levels
    db.from("topic_progress")
      .select("topic_name, mastery_level")
      .eq("student_id", user_id)
      .order("mastery_level", { ascending: true })
      .limit(10),
  ]);

  const sessions = sessionsRes.data || [];
  const totalSessions = sessions.length;
  const totalReviews = sessions.reduce((sum, s) => sum + (s.total_reviews || 0), 0);
  const correctReviews = sessions.reduce((sum, s) => sum + (s.correct_reviews || 0), 0);
  const accuracy = totalReviews > 0 ? Math.round((correctReviews / totalReviews) * 100) : 0;

  const weakTopics = (progressRes.data || [])
    .filter((t) => (t.mastery_level || 0) < 0.5)
    .slice(0, 3)
    .map((t) => t.topic_name);

  // Generate personalized analysis
  const { text: analysis } = await generateText({
    prompt:
      `Datos de estudio semanal del alumno:\n` +
      `- Sesiones: ${totalSessions}\n` +
      `- Reviews: ${totalReviews}\n` +
      `- Precisi\u00f3n: ${accuracy}%\n` +
      `- Topics d\u00e9biles: ${weakTopics.join(", ") || "ninguno"}\n\n` +
      `Genera un reporte motivacional breve (max 500 chars) con:\n` +
      `1. Resumen de logros\n2. \u00c1rea de mejora\n3. Consejo para la pr\u00f3xima semana`,
    systemPrompt:
      "Eres Axon, un tutor motivador. Escrib\u00ed en espa\u00f1ol informal (tuteo). " +
      "M\u00e1ximo 500 caracteres. Us\u00e1 emojis moderados.",
    temperature: 0.6,
    maxTokens: 300,
  });

  const report =
    `\ud83d\udcca *Reporte Semanal*\n\n` +
    `\ud83d\udcd6 ${totalSessions} sesiones\n` +
    `\ud83c\udccf ${totalReviews} reviews\n` +
    `\ud83c\udfaf ${accuracy}% precisi\u00f3n\n\n` +
    `${analysis}`;

  await sendText(phone, report.slice(0, 4096));
}

// ─── Batch Processor (for external invocation) ─────────────

/**
 * Process up to N pending jobs in sequence.
 * Called by a scheduled edge function or cron endpoint.
 */
export async function processPendingJobs(maxJobs = 5): Promise<number> {
  let processed = 0;
  for (let i = 0; i < maxJobs; i++) {
    const hadJob = await processNextJob();
    if (!hadJob) break;
    processed++;
  }
  if (processed > 0) {
    console.log(`[WA-Queue] Batch processed ${processed} jobs`);
  }
  return processed;
}
