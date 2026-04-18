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
import { getApiKey as getGeminiKey, GEMINI_GENERATE_MODEL as GENERATE_MODEL, fetchWithRetry as geminiFetchWithRetry } from "../../gemini.ts";
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

// ─── Agentic Loop Helpers ────────────────────────────────

/**
 * Outcome of processing a single tool_use block inside the agentic loop.
 * - "continue": tool executed, tool_result pushed to history, keep looping
 * - "break":    terminal condition reached (async enqueue), stop looping with finalText=""
 * - "return":   short-circuit the whole handler (e.g. entered review mode)
 */
type ToolStepOutcome =
  | { kind: "continue" }
  | { kind: "break" }
  | { kind: "return" };

interface ToolStepContext {
  chatId: number;
  userId: string;
  messageId: number;
  iteration: number;
  startMs: number;
  sessionVersion: number;
  sessionContext: Record<string, unknown>;
  history: ClaudeMessage[];
  toolsUsed: string[];
  responseContent: ClaudeContentBlock[];
  toolUseBlock: ClaudeContentBlock;
}

async function processToolUseBlock(ctx: ToolStepContext): Promise<ToolStepOutcome> {
  const { chatId, userId, messageId, iteration, startMs, sessionVersion, sessionContext,
          history, toolsUsed, responseContent, toolUseBlock } = ctx;

  const toolName = toolUseBlock.name!;
  const toolUseId = toolUseBlock.id!;
  const toolArgs = (toolUseBlock.input ?? {}) as Record<string, unknown>;
  toolsUsed.push(toolName);
  console.warn(`[TG-Handler] Tool #${iteration + 1}: ${toolName}(${JSON.stringify(toolArgs).slice(0, 100)})`);

  // Record assistant's tool_use turn in history before executing
  history.push({ role: "assistant", content: responseContent });

  const toolResult = await executeToolCall(toolName, toolArgs, userId, sessionContext);

  // Async tool → enqueue job and terminate loop
  if (toolResult.isAsync) {
    await handleAsyncToolEnqueue(chatId, userId, toolName, toolResult.result, history, toolUseId);
    return { kind: "break" };
  }

  // Study queue → try to enter review mode (may short-circuit the handler)
  if (toolName === "get_study_queue" && toolResult.result) {
    const entered = await tryEnterStudyQueueReview(
      chatId, userId, sessionVersion, messageId, startMs, toolsUsed, toolResult,
    );
    if (entered) return { kind: "return" };
  }

  // Standard tool_result round-trip
  history.push({
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: toolUseId,
      content: JSON.stringify(toolResult.error ? { error: toolResult.error } : toolResult.result),
    }],
  });
  return { kind: "continue" };
}

async function handleAsyncToolEnqueue(
  chatId: number,
  userId: string,
  toolName: string,
  result: unknown,
  history: ClaudeMessage[],
  toolUseId: string,
): Promise<void> {
  const asyncResult = result as Record<string, unknown>;
  await sendTextPlain(chatId, (asyncResult?.message as string) ?? "Procesando... \u23f3");

  const enqueued = await enqueueJob({
    type: toolName as "generate_content" | "generate_weekly_report",
    channel: "telegram",
    user_id: userId,
    chat_id: chatId,
    action: (asyncResult?.action as "flashcard" | "quiz") ?? undefined,
    summary_id: (asyncResult?.summary_id as string) ?? undefined,
  });

  if (enqueued) {
    processNextJob().catch((e) =>
      console.warn(`[TG-Handler] Fire-and-forget queue failed: ${(e as Error).message}`)
    );
  }

  history.push({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify(result) }],
  });
}

/**
 * If study queue returned cards, attempt to enter review mode.
 * Returns true if the handler should short-circuit (review mode entered).
 * If review mode could not be entered, mutates toolResult.result to add a
 * formatted summary so the LLM can present the cards textually.
 */
async function tryEnterStudyQueueReview(
  chatId: number,
  userId: string,
  sessionVersion: number,
  messageId: number,
  startMs: number,
  toolsUsed: string[],
  toolResult: { result: unknown },
): Promise<boolean> {
  const queueResult = toolResult.result as { cards: FlashcardItem[]; count: number };
  if (!queueResult || queueResult.count <= 0) return false;

  const entered = await enterReviewMode(chatId, userId, queueResult.cards, sessionVersion);
  if (entered) {
    updateLogRecord(chatId, messageId, toolsUsed, Date.now() - startMs);
    return true;
  }
  const formatted = formatFlashcardSummary(queueResult.cards, queueResult.count);
  (toolResult.result as Record<string, unknown>).formatted_summary = formatted;
  return false;
}

/**
 * Extract the final assistant text from a Claude response.
 * Handles both the "first text block" case and the "end_turn with concatenated text blocks" case.
 * Returns empty string if no text content is present.
 */
function extractResponseText(response: {
  content: ClaudeContentBlock[];
  stopReason?: string | null;
}): string {
  const textBlock = response.content.find((b) => b.type === "text") as ClaudeContentBlock | undefined;
  if (textBlock?.text) return textBlock.text;

  if (response.stopReason === "end_turn" && response.content.length > 0) {
    return response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}

// ─── handleMessage sub-steps ─────────────────────────────

/**
 * Step 1: Load session and handle flashcard-review mode routing.
 * Returns { shortCircuit: true } when the handler should return immediately
 * (review callback handled, or explicit review-exit). Otherwise returns the
 * session + a mutable history copy ready for the conversation path. If the
 * session transitioned out of review mode via auto-exit, the session object
 * is updated in-place to reflect the new version/mode/context.
 */
async function resolveSession(
  params: HandleMessageParams,
  startMs: number,
): Promise<
  | { shortCircuit: true }
  | { shortCircuit: false; session: SessionRow; history: ClaudeMessage[] }
> {
  const { chatId, userId, messageId, messageType, text, callbackData } = params;

  const session = await loadOrCreateSession(chatId, userId);
  const history: ClaudeMessage[] = Array.isArray(session.history) ? [...session.history] : [];

  if (session.mode !== "flashcard_review") {
    return { shortCircuit: false, session, history };
  }

  // Callback button inside review mode → let review-flow handle it
  if (messageType === "callback" && callbackData) {
    const handled = await handleReviewCallback(
      chatId, userId, callbackData,
      session.current_context, session.version,
    );
    if (handled) {
      updateLogRecord(chatId, messageId, ["flashcard_review"], Date.now() - startMs);
      return { shortCircuit: true };
    }
    // fall-through: callback not recognized, continue normal path
  }

  // Explicit exit command → leave review mode
  if (text && isExitCommand(text)) {
    await exitReviewMode(chatId, session.current_context, session.version);
    updateLogRecord(chatId, messageId, ["review_exit"], Date.now() - startMs);
    return { shortCircuit: true };
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

  return { shortCircuit: false, session, history };
}

/**
 * Step 2: Normalize the incoming payload into a plain user message string.
 * Handles text, callback buttons, and voice transcription (via Gemini).
 * Returns null if the handler should return early (voice unreadable, or
 * empty payload after normalization).
 */
async function processIncomingContent(
  params: HandleMessageParams,
  startMs: number,
): Promise<string | null> {
  const { chatId, messageId, messageType, text, callbackData, voiceFileId } = params;

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
      return null;
    }
    userMessage = transcription;
    await sendTextPlain(
      chatId,
      `\ud83d\udcdd Escuché: "${transcription.slice(0, 200)}${transcription.length > 200 ? "..." : ""}"`,
    );
  }

  if (!userMessage.trim()) {
    await sendTextPlain(chatId, "No entendí tu mensaje. Probá escribiendo tu pregunta. \ud83d\ude0a");
    return null;
  }

  return userMessage;
}

/**
 * Step 3: Run the Claude agentic loop. Mutates `history` in place with
 * assistant/tool_result turns and returns the final assistant text plus
 * the list of tools that were called. `shortCircuit` is true when the loop
 * short-circuited the handler (e.g. entered review mode) and the caller
 * must stop without sending a final reply or persisting state.
 */
interface AgenticLoopResult {
  finalText: string;
  toolsUsed: string[];
  shortCircuit: boolean;
}

async function runAgenticLoop(
  userMessage: string,
  session: SessionRow,
  history: ClaudeMessage[],
  params: HandleMessageParams,
  startMs: number,
): Promise<AgenticLoopResult> {
  const { chatId, userId, messageId } = params;

  const studentContext = await buildStudentContext(userId);
  history.push({ role: "user", content: userMessage });

  const systemPrompt = TELEGRAM_SYSTEM_PROMPT.replace(
    "{STUDENT_CONTEXT}",
    studentContext || "No hay contexto adicional del alumno.",
  );

  const toolsUsed: string[] = [];
  let finalText = "";

  for (let iteration = 0; iteration < MAX_AGENTIC_ITERATIONS; iteration++) {
    const response = await claudeChat({
      messages: history,
      systemPrompt,
      tools: TELEGRAM_TOOLS,
      model: iteration === 0 ? selectModelForTask(userMessage) : "sonnet",
      temperature: 0.3,
      maxTokens: 1024,
    });

    const toolUseBlock = response.content.find(
      (b) => b.type === "tool_use",
    ) as ClaudeContentBlock | undefined;

    // Branch 1: Claude wants to call a tool
    if (toolUseBlock?.name && toolUseBlock.id) {
      const outcome = await processToolUseBlock({
        chatId, userId, messageId, iteration, startMs,
        sessionVersion: session.version,
        sessionContext: session.current_context,
        history, toolsUsed,
        responseContent: response.content,
        toolUseBlock,
      });
      if (outcome.kind === "return") {
        return { finalText: "", toolsUsed, shortCircuit: true };
      }
      if (outcome.kind === "break") break;
      continue;
    }

    // Branch 2: Claude responded with plain text
    const responseText = extractResponseText(response);
    if (responseText) {
      finalText = responseText;
      history.push({ role: "assistant", content: finalText });
      break;
    }

    // Branch 3: Empty response, bail out
    console.warn(`[TG-Handler] Claude empty at iteration ${iteration}`);
    break;
  }

  return { finalText, toolsUsed, shortCircuit: false };
}

// ─── Main Handler (thin orchestrator) ────────────────────

export async function handleMessage(params: HandleMessageParams): Promise<void> {
  const { chatId, messageId } = params;
  const startMs = Date.now();

  try {
    // 1. Session + flashcard-review routing
    const resolved = await resolveSession(params, startMs);
    if (resolved.shortCircuit) return;
    const { session, history } = resolved;

    // 2. Normalize incoming content (text / callback / voice)
    const userMessage = await processIncomingContent(params, startMs);
    if (userMessage === null) return;

    // 3. Agentic loop with Claude
    await sendChatAction(chatId, "typing");
    const { finalText, toolsUsed, shortCircuit } =
      await runAgenticLoop(userMessage, session, history, params, startMs);
    if (shortCircuit) return;

    // 4. Send reply
    if (finalText) {
      const truncated = finalText.length > 4000 ? finalText.slice(0, 3997) + "..." : finalText;
      await sendTextPlain(chatId, truncated);
    }

    // 5. Persist session
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
