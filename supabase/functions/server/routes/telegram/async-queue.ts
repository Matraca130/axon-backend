/**
 * routes/telegram/async-queue.ts -- Background job processor for Telegram
 *
 * Handles async tool operations too slow for inline webhook processing:
 *   - generate_content (~10s): flashcard/quiz generation
 *   - generate_weekly_report (~15s): study analytics report
 *
 * Architecture:
 *   - Jobs enqueued in whatsapp_jobs table with channel='telegram'
 *     (shared table, differentiated by channel column added in migration)
 *   - Jobs polled by POST /telegram/process-queue (called by pg_cron)
 *   - Each job processed, result sent to user via Telegram
 *   - Retry logic: 3 attempts
 *
 * Modeled on whatsapp/async-queue.ts -- same CAS pattern, same job table.
 * Uses sendTextPlain() instead of waClient.sendText() for delivery.
 */

import { getAdminClient } from "../../db.ts";
import { generateText } from "../../claude-ai.ts";
import { sendTextPlain } from "./tg-client.ts";

// --- Types ---

interface TelegramJobPayload {
  type: "generate_content" | "generate_weekly_report";
  channel: "telegram";
  user_id: string;
  chat_id: number;
  // generate_content specific
  action?: "flashcard" | "quiz";
  summary_id?: string;
}

interface JobRow {
  id: number;
  payload: TelegramJobPayload;
  status: string;
  attempts: number;
  max_attempts: number;
  error_message: string | null;
  created_at: string;
}

// --- Constants ---

const MAX_ATTEMPTS = 3;

// --- Enqueue ---

/**
 * Enqueue an async job for background processing.
 * Called from handler.ts when a tool returns isAsync=true.
 */
export async function enqueueJob(payload: TelegramJobPayload): Promise<boolean> {
  const db = getAdminClient();

  try {
    const { error } = await db.from("whatsapp_jobs").insert({
      payload,
      status: "pending",
      attempts: 0,
      max_attempts: MAX_ATTEMPTS,
      channel: "telegram",
    });

    if (error) {
      console.error(`[TG-Queue] Enqueue failed: ${error.message}`);
      return false;
    }

    console.log(`[TG-Queue] Job enqueued: ${payload.type} for user ${payload.user_id} (chat ${payload.chat_id})`);
    return true;
  } catch (e) {
    console.error(`[TG-Queue] Enqueue error: ${(e as Error).message}`);
    return false;
  }
}

// --- Process Next Job ---

/**
 * Polls for the next pending Telegram job and processes it.
 * Returns true if a job was processed, false if queue is empty.
 * Uses CAS pattern (pending -> processing) to prevent double-processing.
 */
export async function processNextJob(): Promise<boolean> {
  const db = getAdminClient();

  const { data: jobs, error: fetchErr } = await db
    .from("whatsapp_jobs")
    .select("*")
    .eq("status", "pending")
    .eq("channel", "telegram")
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

    console.log(`[TG-Queue] Job ${job.id} completed: ${job.payload.type}`);
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

      // Best-effort error notification
      try {
        await sendTextPlain(
          job.payload.chat_id,
          "No pude completar tu solicitud despues de varios intentos. Intenta de nuevo mas tarde.",
        );
      } catch { /* best-effort */ }

      console.error(`[TG-Queue] Job ${job.id} failed permanently: ${errorMsg}`);
    } else {
      await db
        .from("whatsapp_jobs")
        .update({
          status: "pending",
          error_message: `Attempt ${newAttempts}: ${errorMsg.slice(0, 300)}`,
        })
        .eq("id", job.id);

      console.warn(`[TG-Queue] Job ${job.id} failed (attempt ${newAttempts}/${job.max_attempts}): ${errorMsg}`);
    }

    return true;
  }
}

// --- Job Executor ---

async function executeJob(payload: TelegramJobPayload): Promise<void> {
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

// --- Generate Content (flashcard/quiz) ---

async function executeGenerateContent(payload: TelegramJobPayload): Promise<void> {
  const db = getAdminClient();
  const { user_id, action, summary_id, chat_id } = payload;

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
        "Genera 5 flashcards de estudio basadas en este contenido:\n\n" +
        `Titulo: ${summary.title}\n${contentSlice}\n\n` +
        'Formato JSON:\n[{"front": "pregunta", "back": "respuesta"}]',
      systemPrompt:
        "Eres un generador de flashcards educativas. Genera preguntas claras " +
        "y respuestas concisas en espanol. Retorna SOLO JSON valido.",
      jsonMode: true,
      temperature: 0.5,
      maxTokens: 1500,
    });

    try {
      const cards = JSON.parse(text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, ""));
      if (Array.isArray(cards) && cards.length > 0) {
        const rows = cards.slice(0, 10).map((card: { front: string; back: string }) => ({
          summary_id,
          front: (card.front || "").slice(0, 1000),
          back: (card.back || "").slice(0, 2000),
          source: "ai",
          created_by: user_id,
        }));

        const { error: insertErr } = await db.from("flashcards").insert(rows);
        if (insertErr) {
          console.warn(`[TG-Queue] Flashcard insert failed: ${insertErr.message}`);
        }

        await sendTextPlain(
          chat_id,
          `${rows.length} flashcards generadas!\n\n` +
          `Sobre: "${summary.title}"\n\n` +
          'Decime "que debo estudiar" para empezar a repasarlas.',
        );
        return;
      }
    } catch (parseErr) {
      console.warn(`[TG-Queue] Flashcard parse failed: ${(parseErr as Error).message}`);
    }

    await sendTextPlain(chat_id, `Flashcards generadas sobre "${summary.title}". Decime "estudiar" para verlas.`);

  } else if (action === "quiz") {
    await sendTextPlain(
      chat_id,
      `Quiz generado sobre "${summary.title}". Abri la app para resolverlo.`,
    );
  }
}

// --- Weekly Report ---

async function executeWeeklyReport(payload: TelegramJobPayload): Promise<void> {
  const db = getAdminClient();
  const { user_id, chat_id } = payload;

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [sessionsRes, progressRes] = await Promise.all([
    db.from("study_sessions")
      .select("id, session_type, completed_at, total_reviews, correct_reviews")
      .eq("student_id", user_id)
      .gte("created_at", weekAgo),

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

  const { text: analysis } = await generateText({
    prompt:
      "Datos de estudio semanal del alumno:\n" +
      `- Sesiones: ${totalSessions}\n` +
      `- Reviews: ${totalReviews}\n` +
      `- Precision: ${accuracy}%\n` +
      `- Topics debiles: ${weakTopics.join(", ") || "ninguno"}\n\n` +
      "Genera un reporte motivacional breve (max 500 chars) con:\n" +
      "1. Resumen de logros\n2. Area de mejora\n3. Consejo para la proxima semana",
    systemPrompt:
      "Eres Axon, un tutor motivador. Escribi en espanol informal (tuteo). " +
      "Maximo 500 caracteres. Usa emojis moderados.",
    temperature: 0.6,
    maxTokens: 300,
  });

  const report =
    "Reporte Semanal\n\n" +
    `${totalSessions} sesiones\n` +
    `${totalReviews} reviews\n` +
    `${accuracy}% precision\n\n` +
    `${analysis}`;

  await sendTextPlain(chat_id, report.slice(0, 4096));
}

// --- Batch Processor ---

export async function processPendingJobs(maxJobs = 5): Promise<number> {
  let processed = 0;
  for (let i = 0; i < maxJobs; i++) {
    const hadJob = await processNextJob();
    if (!hadJob) break;
    processed++;
  }
  if (processed > 0) {
    console.log(`[TG-Queue] Batch processed ${processed} jobs`);
  }
  return processed;
}
