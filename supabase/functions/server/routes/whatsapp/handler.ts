/**
 * routes/whatsapp/handler.ts — WhatsApp bot orchestrator
 *
 * The "brain" of the bot. Receives parsed messages from webhook.ts,
 * manages conversation state, and orchestrates the Gemini Agentic Loop.
 *
 * Architecture:
 *   1. Load/create session from whatsapp_sessions
 *   2. Route by session mode (flashcard_review bypasses Gemini)
 *   3. Agentic Loop: Gemini with tools[] → functionCall → execute → functionResponse → repeat
 *   4. Update session with optimistic locking
 *   5. Log to whatsapp_message_log (fire-and-forget)
 *
 * Phase 2 additions:
 *   S10: flashcard_review mode delegates to review-flow.ts
 *   S13: isAsync tools enqueue jobs via async-queue.ts
 *
 * @see AUDIT F10: tool_config with mode: AUTO
 * @see AUDIT F11: Correct multi-turn functionCall/functionResponse format
 * @see AUDIT F12: Inline processing for fast ops, pgmq for slow ops
 * @see A4 FIX: Async functionResponse includes status:'queued'
 * @see A6 FIX: buildStudentContext logs errors
 * @see A9 FIX: Dedup record now inserted by webhook.ts before handleMessage;
 *              handler.ts updates the existing record instead of inserting new.
 */

import { getAdminClient } from "../../db.ts";
import { getApiKey, GENERATE_MODEL } from "../../gemini.ts";
import { sendText, sendInteractiveButtons } from "./wa-client.ts";
import {
  WHATSAPP_TOOLS,
  WHATSAPP_SYSTEM_PROMPT,
  executeToolCall,
  type ToolExecutionResult,
} from "./tools.ts";
import {
  enterReviewMode,
  handleReviewButton,
  exitReviewMode,
  isExitCommand,
  type FlashcardItem,
} from "./review-flow.ts";
import { enqueueJob } from "./async-queue.ts";

// ─── Types ───────────────────────────────────────────────

export interface HandleMessageParams {
  phone: string;       // Raw phone for sending replies
  phoneHash: string;   // Hashed phone (PK in sessions)
  userId: string;      // Axon user ID (from whatsapp_links)
  messageId: string;   // Meta wa_message_id
  messageType: "text" | "audio" | "interactive";
  text?: string;
  buttonPayload?: string;
  audioMediaId?: string;
}

interface GeminiMessage {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
}

interface SessionRow {
  phone_hash: string;
  user_id: string | null;
  history: GeminiMessage[];
  current_tool: string | null;
  current_context: Record<string, unknown>;
  mode: string;
  last_message_id: string | null;
  version: number;
  updated_at: string;
  expires_at: string;
}

// ─── Constants ───────────────────────────────────────────

const MAX_AGENTIC_ITERATIONS = 3;
const MAX_HISTORY_TURNS = 6; // Keep last 6 user+model pairs
const GEMINI_TIMEOUT_MS = 15_000;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ─── Session Management ─────────────────────────────────

async function loadOrCreateSession(phoneHash: string, userId: string): Promise<SessionRow> {
  const db = getAdminClient();

  const { data: existing } = await db
    .from("whatsapp_sessions")
    .select("*")
    .eq("phone_hash", phoneHash)
    .single();

  if (existing) {
    return existing as SessionRow;
  }

  // Create new session
  const { data: created, error } = await db
    .from("whatsapp_sessions")
    .insert({
      phone_hash: phoneHash,
      user_id: userId,
      history: [],
      current_context: {},
      mode: "conversation",
      version: 0,
    })
    .select("*")
    .single();

  if (error) {
    console.error(`[WA-Handler] Session create failed: ${error.message}`);
    throw error;
  }

  return created as SessionRow;
}

async function updateSession(
  phoneHash: string,
  expectedVersion: number,
  updates: Partial<Pick<SessionRow, "history" | "mode" | "current_tool" | "current_context" | "last_message_id">>,
): Promise<boolean> {
  const db = getAdminClient();

  // Optimistic locking: UPDATE only if version matches (FC-05)
  const { data, error } = await db
    .from("whatsapp_sessions")
    .update({
      ...updates,
      version: expectedVersion + 1,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .eq("phone_hash", phoneHash)
    .eq("version", expectedVersion)
    .select("phone_hash")
    .single();

  if (error || !data) {
    console.warn(`[WA-Handler] Optimistic lock failed for ${phoneHash} (version ${expectedVersion})`);
    return false;
  }

  return true;
}

// ─── Gemini API Call ────────────────────────────────────

interface GeminiResponse {
  functionCall?: { name: string; args: Record<string, unknown> };
  text?: string;
}

async function callGemini(
  history: GeminiMessage[],
  studentContext: string,
): Promise<GeminiResponse> {
  const apiKey = getApiKey();
  const url = `${GEMINI_BASE}/${GENERATE_MODEL}:generateContent?key=${apiKey}`;

  const systemPrompt = WHATSAPP_SYSTEM_PROMPT.replace(
    "{STUDENT_CONTEXT}",
    studentContext || "No hay contexto adicional del alumno.",
  );

  const body = {
    contents: history,
    tools: [{ function_declarations: WHATSAPP_TOOLS }],
    // AUDIT F10: tool_config is REQUIRED for Gemini to use tools
    tool_config: {
      function_calling_config: { mode: "AUTO" },
    },
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    generation_config: {
      temperature: 0.3,
      max_output_tokens: 1024,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];

    if (!candidate?.content?.parts?.[0]) {
      const blockReason = candidate?.finishReason ?? data.promptFeedback?.blockReason;
      if (blockReason && blockReason !== "STOP") {
        return { text: "No pude procesar tu mensaje. Intentá reformularlo." };
      }
      return { text: "No obtuve respuesta. Intentá de nuevo." };
    }

    const part = candidate.content.parts[0];

    // Check for function call
    if (part.functionCall) {
      return {
        functionCall: {
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
        },
      };
    }

    // Text response
    return { text: part.text ?? "" };
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`Gemini timeout after ${GEMINI_TIMEOUT_MS}ms`);
    }
    throw e;
  }
}

// ─── Student Context Builder ───────────────────────────

async function buildStudentContext(userId: string): Promise<string> {
  const db = getAdminClient();

  try {
    // Get student profile + courses
    const [profileRes, coursesRes] = await Promise.all([
      db.from("profiles").select("first_name, last_name").eq("id", userId).single(),
      db.from("course_members").select("courses(name, code)").eq("user_id", userId).limit(5),
    ]);

    const name = profileRes.data
      ? `${profileRes.data.first_name ?? ""} ${profileRes.data.last_name ?? ""}`.trim()
      : "Alumno";
    const courses = coursesRes.data?.map((cm) => (cm.courses as { name: string })?.name).filter(Boolean) ?? [];

    return [
      `Nombre: ${name}`,
      `Cursos: ${courses.length > 0 ? courses.join(", ") : "Ningún curso inscrito"}`,
    ].join("\n");
  } catch (e) {
    // A6 FIX: Log the error instead of silencing it
    console.warn(`[WA-Handler] buildStudentContext failed: ${(e as Error).message}`);
    return "No se pudo cargar el contexto del alumno.";
  }
}

// ─── History Trimmer ────────────────────────────────────

function trimHistory(history: GeminiMessage[]): GeminiMessage[] {
  // Keep last MAX_HISTORY_TURNS * 2 messages (user + model pairs)
  const maxMessages = MAX_HISTORY_TURNS * 2;
  if (history.length <= maxMessages) return history;
  return history.slice(-maxMessages);
}

// ─── Main Handler ───────────────────────────────────────

export async function handleMessage(params: HandleMessageParams): Promise<void> {
  const { phone, phoneHash, userId, messageId, messageType, text, buttonPayload, audioMediaId } = params;
  const startMs = Date.now();

  try {
    // ── Step 1: Load session ──
    const session = await loadOrCreateSession(phoneHash, userId);
    let history: GeminiMessage[] = Array.isArray(session.history) ? [...session.history] : [];

    // ── Step 2: Session Mode routing (FC-01 + S10) ──
    if (session.mode === "flashcard_review") {
      if (messageType === "interactive" && buttonPayload) {
        // S10: Button press during flashcard review → delegate to review-flow
        const handled = await handleReviewButton(
          phoneHash,
          phone,
          userId,
          buttonPayload,
          session.current_context,
          session.version,
        );
        if (handled) {
          // Update log record
          updateLogRecord(messageId, ["flashcard_review"], Date.now() - startMs);
          return;
        }
      }

      // S10: Text during flashcard_review → check for exit command
      if (text) {
        if (isExitCommand(text)) {
          await exitReviewMode(phoneHash, phone, session.current_context, session.version);
          updateLogRecord(messageId, ["review_exit"], Date.now() - startMs);
          return;
        }

        // Non-exit text during review → exit mode, fall through to Agentic Loop
        console.log(`[WA-Handler] User sent text during flashcard_review, exiting mode`);
        await updateSession(phoneHash, session.version, {
          mode: "conversation",
          current_tool: null,
          current_context: {},
        });
        // Update local session state for the rest of this function
        session.mode = "conversation";
        session.version += 1;
        session.current_context = {};
      }
    }

    // ── Step 3: Build user message ──
    let userMessage = text ?? "";
    if (messageType === "interactive" && buttonPayload) {
      userMessage = `[Botón seleccionado: ${buttonPayload}]`;
    } else if (messageType === "audio" && audioMediaId) {
      // TODO S14: Download + transcribe audio
      await sendText(phone, "Los mensajes de voz estarán disponibles pronto. Por ahora, escribí tu pregunta. \ud83c\udfa4");
      return;
    }

    if (!userMessage.trim()) {
      await sendText(phone, "No entendí tu mensaje. Probá escribiendo tu pregunta. \ud83d\ude0a");
      return;
    }

    // ── Step 4: Agentic Loop (AUDIT F10, F11) ──
    const studentContext = await buildStudentContext(userId);

    // Add user message to history
    history.push({
      role: "user",
      parts: [{ text: userMessage }],
    });

    let finalText = "";
    let toolsUsed: string[] = [];

    for (let iteration = 0; iteration < MAX_AGENTIC_ITERATIONS; iteration++) {
      const response = await callGemini(history, studentContext);

      if (response.functionCall) {
        const { name: toolName, args: toolArgs } = response.functionCall;
        toolsUsed.push(toolName);

        console.log(`[WA-Handler] Tool call #${iteration + 1}: ${toolName}(${JSON.stringify(toolArgs).slice(0, 100)})`);

        // AUDIT F11: Add functionCall to history (model role)
        history.push({
          role: "model",
          parts: [{ functionCall: { name: toolName, args: toolArgs } }],
        });

        // Execute tool
        const toolResult = await executeToolCall(
          toolName,
          toolArgs,
          userId,
          session.current_context,
        );

        // Handle async tools (generate_content, weekly_report)
        if (toolResult.isAsync) {
          // S13: Enqueue job for background processing
          const asyncResult = toolResult.result as Record<string, unknown>;
          await enqueueJob({
            type: toolName as "generate_content" | "generate_weekly_report",
            user_id: userId,
            phone,
            phone_hash: phoneHash,
            action: toolArgs.action as "flashcard" | "quiz" | undefined,
            summary_id: toolArgs.summary_id as string | undefined,
          });

          await sendText(phone, (asyncResult?.message as string) ?? "Procesando... \u23f3");

          // A4 FIX: functionResponse includes status:'queued' to help
          // Gemini distinguish from completed results on next turn
          history.push({
            role: "user",
            parts: [{ functionResponse: { name: toolName, response: { content: toolResult.result } } }],
          });
          break;
        }

        // S10: Handle get_study_queue → enter Session Mode
        if (toolName === "get_study_queue" && toolResult.result) {
          const queueResult = toolResult.result as { cards: FlashcardItem[]; count: number };
          if (queueResult.count > 0) {
            // Enter flashcard_review mode (bypasses Gemini for rest of session)
            const entered = await enterReviewMode(
              phoneHash,
              phone,
              userId,
              queueResult.cards,
              session.version,
            );
            if (entered) {
              // Session mode changed, update log and return
              updateLogRecord(messageId, toolsUsed, Date.now() - startMs);
              return;
            }
            // If enterReviewMode failed, fall through to let Gemini summarize
          }
        }

        // AUDIT F11: Add functionResponse to history (user role)
        history.push({
          role: "user",
          parts: [{
            functionResponse: {
              name: toolName,
              response: {
                content: toolResult.error
                  ? { error: toolResult.error }
                  : toolResult.result,
              },
            },
          }],
        });

        // Continue loop — Gemini will process the tool result
        continue;
      }

      // Text response → send to user and break
      if (response.text) {
        finalText = response.text;

        // Add model response to history
        history.push({
          role: "model",
          parts: [{ text: finalText }],
        });

        break;
      }

      // No function call and no text — shouldn't happen
      console.warn(`[WA-Handler] Gemini returned neither functionCall nor text at iteration ${iteration}`);
      break;
    }

    // ── Step 5: Send response ──
    if (finalText) {
      // Truncate to WhatsApp practical limit
      const truncated = finalText.length > 4000
        ? finalText.slice(0, 3997) + "..."
        : finalText;
      await sendText(phone, truncated);
    }

    // ── Step 6: Update session (optimistic locking) ──
    const trimmedHistory = trimHistory(history);
    const updated = await updateSession(phoneHash, session.version, {
      history: trimmedHistory,
      last_message_id: messageId,
    });

    if (!updated) {
      console.warn(`[WA-Handler] Session update failed (concurrent modification), message still processed`);
    }

    // ── Step 7: Update log record (A9 FIX: record was pre-inserted by webhook.ts) ──
    updateLogRecord(messageId, toolsUsed, Date.now() - startMs);

    console.log(
      `[WA-Handler] Processed in ${Date.now() - startMs}ms. Tools: [${toolsUsed.join(", ")}]. ` +
      `Response: ${finalText.slice(0, 80)}...`,
    );
  } catch (e) {
    const errorMsg = (e as Error).message;
    console.error(`[WA-Handler] Fatal error: ${errorMsg}`);

    // Best-effort error response to user
    try {
      await sendText(phone, "Ups, algo salió mal. Intentá de nuevo en unos segundos. \ud83d\ude14");
    } catch {
      // Can't even send error message — nothing to do
    }

    // Update the pre-inserted log record with error info (A9 FIX)
    const db = getAdminClient();
    db.from("whatsapp_message_log")
      .update({
        success: false,
        error_message: errorMsg.slice(0, 500),
        latency_ms: Date.now() - startMs,
      })
      .eq("wa_message_id", messageId)
      .then(() => {});
  }
}

// ─── Log Helper (extracted to reduce duplication) ───────────

function updateLogRecord(
  messageId: string,
  toolsUsed: string[],
  latencyMs: number,
): void {
  const db = getAdminClient();
  db.from("whatsapp_message_log")
    .update({
      tool_called: toolsUsed.length > 0 ? toolsUsed.join(",") : null,
      latency_ms: latencyMs,
      success: true,
    })
    .eq("wa_message_id", messageId)
    .then(({ error }) => {
      if (error) console.warn(`[WA-Handler] Log update failed: ${error.message}`);
    });
}
