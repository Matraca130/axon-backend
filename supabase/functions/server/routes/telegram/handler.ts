/**
 * routes/telegram/handler.ts — Telegram bot orchestrator with Claude AI
 *
 * Core message handler with Claude AI agentic loop (tool_use).
 * Supports: text, voice (transcribed via Gemini multimodal), callback queries.
 *
 * Architecture:
 *   - Session management in telegram_sessions table
 *   - Claude AI with tool_use for intelligent responses
 *   - Model selection: sonnet for chat, haiku for simple tasks, opus for reports
 *   - Reuses RAG pipeline and DB queries from WhatsApp tools
 */

import { getAdminClient } from "../../db.ts";
import { getApiKey as getGeminiKey, GENERATE_MODEL, fetchWithRetry as geminiFetchWithRetry } from "../../gemini.ts";
import {
  chat as claudeChat,
  selectModelForTask,
  type ClaudeMessage,
  type ClaudeContentBlock,
} from "../../claude-ai.ts";
import { sendTextPlain, sendChatAction, downloadFile } from "./tg-client.ts";
import {
  TELEGRAM_TOOLS,
  TELEGRAM_SYSTEM_PROMPT,
  executeToolCall,
} from "./tools.ts";
import {
  enterReviewMode,
  handleReviewCallback,
  exitReviewMode,
  isExitCommand,
  type FlashcardItem,
} from "./review-flow.ts";
import { formatFlashcardSummary } from "./formatter.ts";
import { enqueueJob, processNextJob } from "./async-queue.ts";

// ─── Types ───────────────────────────────────────────────

export interface HandleMessageParams {
  chatId: number;
  userId: string;
  messageId: number;
  messageType: "text" | "voice" | "callback";
  text?: string;
  callbackData?: string;
  callbackQueryId?: string;
  voiceFileId?: string;
}

interface SessionRow {
  chat_id: number;
  user_id: string | null;
  history: ClaudeMessage[];
  current_tool: string | null;
  current_context: Record<string, unknown>;
  mode: string;
  last_message_id: string | null;
  version: number;
  updated_at: string;
  expires_at: string;
}

// ─── Constants ───────────────────────────────────────────

const MAX_AGENTIC_ITERATIONS = 5;
const MAX_HISTORY_TURNS = 8;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ─── Session Management ──────────────────────────────────

async function loadOrCreateSession(chatId: number, userId: string): Promise<SessionRow> {
  const db = getAdminClient();

  const { data: existing } = await db
    .from("telegram_sessions")
    .select("*")
    .eq("chat_id", chatId)
    .single();

  if (existing) return existing as SessionRow;

  const { data: created, error } = await db
    .from("telegram_sessions")
    .insert({
      chat_id: chatId,
      user_id: userId,
      history: [],
      current_context: {},
      mode: "conversation",
      version: 0,
    })
    .select("*")
    .single();

  if (error) {
    console.error(`[TG-Handler] Session create failed: ${error.message}`);
    throw error;
  }
  return created as SessionRow;
}

async function updateSession(
  chatId: number,
  expectedVersion: number,
  updates: Partial<Pick<SessionRow, "history" | "mode" | "current_tool" | "current_context" | "last_message_id">>,
): Promise<boolean> {
  const db = getAdminClient();
  const { data, error } = await db
    .from("telegram_sessions")
    .update({
      ...updates,
      version: expectedVersion + 1,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .eq("chat_id", chatId)
    .eq("version", expectedVersion)
    .select("chat_id")
    .single();

  if (error || !data) {
    console.warn(`[TG-Handler] Optimistic lock failed for chat ${chatId} (v${expectedVersion})`);
    return false;
  }
  return true;
}

// ─── Voice Transcription via Gemini Multimodal ───────────

async function transcribeVoiceMessage(voiceFileId: string): Promise<string | null> {
  try {
    const { buffer, mimeType } = await downloadFile(voiceFileId);

    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      const chunk = bytes.subarray(i, Math.min(i + 8192, bytes.length));
      binary += String.fromCharCode(...chunk);
    }
    const audioBase64 = btoa(binary);

    const apiKey = getGeminiKey();
    const url = `${GEMINI_BASE}/${GENERATE_MODEL}:generateContent?key=${apiKey}`;

    const body = {
      contents: [{
        parts: [
          {
            text: "Transcribí este mensaje de voz en español. " +
              "Retorná SOLO la transcripción textual, sin explicaciones ni prefijos. " +
              "Si no podés entender el audio, respondé '[inaudible]'.",
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: audioBase64,
            },
          },
        ],
      }],
      generation_config: {
        temperature: 0.1,
        max_output_tokens: 512,
      },
    };

    const res = await geminiFetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      20_000,
      1,
    );

    if (!res.ok) {
      console.error(`[TG-Handler] Gemini STT failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text || text.includes("[inaudible]")) {
      return null;
    }

    console.warn(`[TG-Handler] Voice transcribed (${bytes.length} bytes): "${text.slice(0, 80)}..."`);
    return text.trim();
  } catch (e) {
    console.error(`[TG-Handler] Voice transcription failed: ${(e as Error).message}`);
    return null;
  }
}

// ─── Student Context Builder ─────────────────────────────

async function buildStudentContext(userId: string): Promise<string> {
  const db = getAdminClient();
  try {
    const profileRes = await db
      .from("profiles")
      .select("full_name")
      .eq("id", userId)
      .single();

    const name = profileRes.data?.full_name ?? "Alumno";

    const { data: membershipData } = await db
      .from("memberships")
      .select("institution_id")
      .eq("user_id", userId)
      .eq("is_active", true)
      .limit(5);

    const institutionIds = membershipData?.map((m) => m.institution_id) ?? [];
    let courses: string[] = [];

    if (institutionIds.length > 0) {
      const { data: courseData } = await db
        .from("courses")
        .select("name")
        .in("institution_id", institutionIds)
        .eq("is_active", true)
        .limit(10);
      courses = courseData?.map((c) => c.name as string).filter(Boolean) ?? [];
    }

    return [
      `Nombre: ${name}`,
      `Cursos: ${courses.length > 0 ? courses.join(", ") : "Ningún curso inscrito"}`,
    ].join("\n");
  } catch (e) {
    console.warn(`[TG-Handler] buildStudentContext failed: ${(e as Error).message}`);
    return "No se pudo cargar el contexto del alumno.";
  }
}

// ─── History Trimmer ─────────────────────────────────────

function trimHistory(history: ClaudeMessage[]): ClaudeMessage[] {
  const maxMessages = MAX_HISTORY_TURNS * 2;
  if (history.length <= maxMessages) return history;
  return history.slice(-maxMessages);
}

// ─── Main Handler ────────────────────────────────────────

export async function handleMessage(params: HandleMessageParams): Promise<void> {
  const { chatId, userId, messageId, messageType, text, callbackData, callbackQueryId, voiceFileId } = params;
  const startMs = Date.now();

  try {
    const session = await loadOrCreateSession(chatId, userId);
    let history: ClaudeMessage[] = Array.isArray(session.history) ? [...session.history] : [];

    // ── Flashcard review mode routing (guard clauses) ──
    if (session.mode === "flashcard_review") {
      // Callback button inside review mode → let review-flow handle it
      if (messageType === "callback" && callbackData) {
        const handled = await handleReviewCallback(
          chatId, userId, callbackData,
          session.current_context, session.version,
        );
        if (handled) {
          updateLogRecord(chatId, messageId, ["flashcard_review"], Date.now() - startMs);
          return;
        }
        // fall-through: callback not recognized by review-flow, continue normal path
      }

      // Explicit exit command → leave review mode
      if (text && isExitCommand(text)) {
        await exitReviewMode(chatId, session.current_context, session.version);
        updateLogRecord(chatId, messageId, ["review_exit"], Date.now() - startMs);
        return;
      }

      // Any other text → auto-exit review mode and fall through to conversation
      if (text) {
        await updateSession(chatId, session.version, {
          mode: "conversation", current_tool: null, current_context: {},
        });
        session.mode = "conversation";
        session.version += 1;
        session.current_context = {};
      }
    }

    // ── Build user message ──
    let userMessage = text ?? "";
    if (messageType === "callback" && callbackData) {
      userMessage = `[Botón seleccionado: ${callbackData}]`;
    } else if (messageType === "voice" && voiceFileId) {
      await sendChatAction(chatId, "typing");
      await sendTextPlain(chatId, "Transcribiendo tu audio... \ud83c\udfa4");
      const transcription = await transcribeVoiceMessage(voiceFileId);
      if (!transcription) {
        await sendTextPlain(chatId, "No pude entender el audio. Probá enviando tu pregunta por texto. \ud83d\ude14");
        updateLogRecord(chatId, messageId, ["voice_failed"], Date.now() - startMs);
        return;
      }
      userMessage = transcription;
      await sendTextPlain(chatId, `\ud83d\udcdd Escuché: "${transcription.slice(0, 200)}${transcription.length > 200 ? "..." : ""}"`);
    }

    if (!userMessage.trim()) {
      await sendTextPlain(chatId, "No entendí tu mensaje. Probá escribiendo tu pregunta. \ud83d\ude0a");
      return;
    }

    // ── Show typing indicator ──
    await sendChatAction(chatId, "typing");

    // ── Agentic Loop with Claude ──
    const studentContext = await buildStudentContext(userId);
    history.push({ role: "user", content: userMessage });

    let finalText = "";
    const toolsUsed: string[] = [];

    const systemPrompt = TELEGRAM_SYSTEM_PROMPT.replace(
      "{STUDENT_CONTEXT}",
      studentContext || "No hay contexto adicional del alumno.",
    );

    for (let iteration = 0; iteration < MAX_AGENTIC_ITERATIONS; iteration++) {
      const response = await claudeChat({
        messages: history,
        systemPrompt,
        tools: TELEGRAM_TOOLS,
        model: iteration === 0 ? selectModelForTask(userMessage) : "sonnet",
        temperature: 0.3,
        maxTokens: 1024,
      });

      // Extract tool_use blocks
      const toolUseBlock = response.content.find(
        (b) => b.type === "tool_use",
      ) as ClaudeContentBlock | undefined;

      const textBlock = response.content.find(
        (b) => b.type === "text",
      ) as ClaudeContentBlock | undefined;

      if (toolUseBlock?.name && toolUseBlock.id) {
        const toolName = toolUseBlock.name;
        const toolArgs = (toolUseBlock.input ?? {}) as Record<string, unknown>;
        toolsUsed.push(toolName);
        console.warn(`[TG-Handler] Tool #${iteration + 1}: ${toolName}(${JSON.stringify(toolArgs).slice(0, 100)})`);

        // Add assistant message with tool_use to history
        history.push({
          role: "assistant",
          content: response.content,
        });

        const toolResult = await executeToolCall(toolName, toolArgs, userId, session.current_context);

        // Handle async tools — enqueue for background processing
        if (toolResult.isAsync) {
          const asyncResult = toolResult.result as Record<string, unknown>;
          await sendTextPlain(chatId, (asyncResult?.message as string) ?? "Procesando... \u23f3");

          // Enqueue the job for background execution
          const enqueued = await enqueueJob({
            type: toolName as "generate_content" | "generate_weekly_report",
            channel: "telegram",
            user_id: userId,
            chat_id: chatId,
            action: (asyncResult?.action as "flashcard" | "quiz") ?? undefined,
            summary_id: (asyncResult?.summary_id as string) ?? undefined,
          });

          if (enqueued) {
            // Fire-and-forget: attempt immediate processing
            processNextJob().catch((e) =>
              console.warn(`[TG-Handler] Fire-and-forget queue failed: ${(e as Error).message}`)
            );
          }

          history.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUseBlock.id, content: JSON.stringify(toolResult.result) }],
          });
          break;
        }

        // Handle study queue → enter review mode
        if (toolName === "get_study_queue" && toolResult.result) {
          const queueResult = toolResult.result as { cards: FlashcardItem[]; count: number };
          if (queueResult.count > 0) {
            const entered = await enterReviewMode(chatId, userId, queueResult.cards, session.version);
            if (entered) {
              updateLogRecord(chatId, messageId, toolsUsed, Date.now() - startMs);
              return;
            }
            const formatted = formatFlashcardSummary(queueResult.cards, queueResult.count);
            (toolResult.result as Record<string, unknown>).formatted_summary = formatted;
          }
        }

        // Add tool_result to history
        history.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolUseBlock.id,
            content: JSON.stringify(
              toolResult.error ? { error: toolResult.error } : toolResult.result,
            ),
          }],
        });
        continue;
      }

      if (textBlock?.text) {
        finalText = textBlock.text;
        history.push({ role: "assistant", content: finalText });
        break;
      }

      // If response has text content directly
      if (response.stopReason === "end_turn" && response.content.length > 0) {
        const allText = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        if (allText) {
          finalText = allText;
          history.push({ role: "assistant", content: finalText });
          break;
        }
      }

      console.warn(`[TG-Handler] Claude empty at iteration ${iteration}`);
      break;
    }

    // ── Send response ──
    if (finalText) {
      const truncated = finalText.length > 4000 ? finalText.slice(0, 3997) + "..." : finalText;
      await sendTextPlain(chatId, truncated);
    }

    // ── Update session ──
    const updated = await updateSession(chatId, session.version, {
      history: trimHistory(history),
      last_message_id: String(messageId),
    });
    if (!updated) {
      console.warn(`[TG-Handler] Session save failed (concurrent), msg still processed`);
    }

    updateLogRecord(chatId, messageId, toolsUsed, Date.now() - startMs);
    console.warn(`[TG-Handler] Done in ${Date.now() - startMs}ms. Tools: [${toolsUsed.join(", ")}]`);
  } catch (e) {
    const errorMsg = (e as Error).message;
    console.error(`[TG-Handler] Fatal: ${errorMsg}`);
    try {
      await sendTextPlain(chatId, "Ups, algo salió mal. Intenta de nuevo en unos segundos. \ud83d\ude14");
    } catch { /* */ }

    const db = getAdminClient();
    db.from("telegram_message_log")
      .update({ success: false, error_message: errorMsg.slice(0, 500), latency_ms: Date.now() - startMs })
      .eq("tg_message_id", messageId)
      .then(() => {});
  }
}

// ─── Log Helper ──────────────────────────────────────────

function updateLogRecord(chatId: number, messageId: number, toolsUsed: string[], latencyMs: number): void {
  const db = getAdminClient();
  db.from("telegram_message_log")
    .update({
      tool_called: toolsUsed.length > 0 ? toolsUsed.join(",") : null,
      latency_ms: latencyMs,
      success: true,
    })
    .eq("tg_message_id", messageId)
    .then(({ error }) => {
      if (error) console.warn(`[TG-Handler] Log update failed: ${error.message}`);
    });
}
