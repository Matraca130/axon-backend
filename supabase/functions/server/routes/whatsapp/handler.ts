/**
 * routes/whatsapp/handler.ts — WhatsApp bot orchestrator
 *
 * Audit fixes applied:
 *   C1: Phone encrypted before enqueue (PII protection)
 *   C3: Fire-and-forget processNextJob after enqueue
 *   C7: formatFlashcardSummary used in get_study_queue fallback
 *   C11: Removed unused sendInteractiveButtons import
 *   N3: callGemini now uses fetchWithRetry for 429/503 resilience
 */

import { getAdminClient } from "../../db.ts";
import { getApiKey, GENERATE_MODEL, fetchWithRetry } from "../../gemini.ts";
import { sendText } from "./wa-client.ts";
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
import { enqueueJob, encryptPhone, processNextJob } from "./async-queue.ts";
import { formatFlashcardSummary } from "./formatter.ts";

// ─── Types ───────────────────────────────────────────────

export interface HandleMessageParams {
  phone: string;
  phoneHash: string;
  userId: string;
  messageId: string;
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
const MAX_HISTORY_TURNS = 6;
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

// ─── Gemini API Call (N3 FIX: uses fetchWithRetry for 429/503) ──

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

  // N3 FIX: Use fetchWithRetry (exported from gemini.ts) instead of raw fetch.
  // Retries 429 (rate limit) and 503 (service unavailable) with exponential backoff.
  // Max 2 retries for WhatsApp (tighter than gemini.ts default of 3) to stay within
  // Meta's ~5s webhook processing window.
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    GEMINI_TIMEOUT_MS,
    2, // max 2 retries (total 3 attempts, ~7s worst case)
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];

  if (!candidate?.content?.parts?.[0]) {
    const blockReason = candidate?.finishReason ?? data.promptFeedback?.blockReason;
    if (blockReason && blockReason !== "STOP") {
      return { text: "No pude procesar tu mensaje. Intent\u00e1 reformularlo." };
    }
    return { text: "No obtuve respuesta. Intent\u00e1 de nuevo." };
  }

  const part = candidate.content.parts[0];

  if (part.functionCall) {
    return {
      functionCall: {
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
      },
    };
  }

  return { text: part.text ?? "" };
}

// ─── Student Context Builder ───────────────────────────

async function buildStudentContext(userId: string): Promise<string> {
  const db = getAdminClient();

  try {
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
      `Cursos: ${courses.length > 0 ? courses.join(", ") : "Ning\u00fan curso inscrito"}`,
    ].join("\n");
  } catch (e) {
    console.warn(`[WA-Handler] buildStudentContext failed: ${(e as Error).message}`);
    return "No se pudo cargar el contexto del alumno.";
  }
}

// ─── History Trimmer ────────────────────────────────────

function trimHistory(history: GeminiMessage[]): GeminiMessage[] {
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
        const handled = await handleReviewButton(
          phoneHash,
          phone,
          userId,
          buttonPayload,
          session.current_context,
          session.version,
        );
        if (handled) {
          updateLogRecord(messageId, ["flashcard_review"], Date.now() - startMs);
          return;
        }
      }

      if (text) {
        if (isExitCommand(text)) {
          await exitReviewMode(phoneHash, phone, session.current_context, session.version);
          updateLogRecord(messageId, ["review_exit"], Date.now() - startMs);
          return;
        }

        console.log(`[WA-Handler] User sent text during flashcard_review, exiting mode`);
        await updateSession(phoneHash, session.version, {
          mode: "conversation",
          current_tool: null,
          current_context: {},
        });
        session.mode = "conversation";
        session.version += 1;
        session.current_context = {};
      }
    }

    // ── Step 3: Build user message ──
    let userMessage = text ?? "";
    if (messageType === "interactive" && buttonPayload) {
      userMessage = `[Bot\u00f3n seleccionado: ${buttonPayload}]`;
    } else if (messageType === "audio" && audioMediaId) {
      await sendText(phone, "Los mensajes de voz estar\u00e1n disponibles pronto. Por ahora, escrib\u00ed tu pregunta. \ud83c\udfa4");
      return;
    }

    if (!userMessage.trim()) {
      await sendText(phone, "No entend\u00ed tu mensaje. Prob\u00e1 escribiendo tu pregunta. \ud83d\ude0a");
      return;
    }

    // ── Step 4: Agentic Loop ──
    const studentContext = await buildStudentContext(userId);

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

        history.push({
          role: "model",
          parts: [{ functionCall: { name: toolName, args: toolArgs } }],
        });

        const toolResult = await executeToolCall(
          toolName,
          toolArgs,
          userId,
          session.current_context,
        );

        // Handle async tools
        if (toolResult.isAsync) {
          const asyncResult = toolResult.result as Record<string, unknown>;

          const phoneEncrypted = await encryptPhone(phone);
          await enqueueJob({
            type: toolName as "generate_content" | "generate_weekly_report",
            user_id: userId,
            phone_encrypted: phoneEncrypted,
            phone_hash: phoneHash,
            action: toolArgs.action as "flashcard" | "quiz" | undefined,
            summary_id: toolArgs.summary_id as string | undefined,
          });

          processNextJob().catch((e) =>
            console.warn(`[WA-Handler] Background job processing failed: ${(e as Error).message}`),
          );

          await sendText(phone, (asyncResult?.message as string) ?? "Procesando... \u23f3");

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
            const entered = await enterReviewMode(
              phoneHash,
              phone,
              userId,
              queueResult.cards,
              session.version,
            );
            if (entered) {
              updateLogRecord(messageId, toolsUsed, Date.now() - startMs);
              return;
            }
            const formatted = formatFlashcardSummary(queueResult.cards, queueResult.count);
            (toolResult.result as Record<string, unknown>).formatted_summary = formatted;
          }
        }

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

        continue;
      }

      if (response.text) {
        finalText = response.text;
        history.push({
          role: "model",
          parts: [{ text: finalText }],
        });
        break;
      }

      console.warn(`[WA-Handler] Gemini returned neither functionCall nor text at iteration ${iteration}`);
      break;
    }

    // ── Step 5: Send response ──
    if (finalText) {
      const truncated = finalText.length > 4000
        ? finalText.slice(0, 3997) + "..."
        : finalText;
      await sendText(phone, truncated);
    }

    // ── Step 6: Update session ──
    const trimmedHistory = trimHistory(history);
    const updated = await updateSession(phoneHash, session.version, {
      history: trimmedHistory,
      last_message_id: messageId,
    });

    if (!updated) {
      console.warn(`[WA-Handler] Session update failed (concurrent modification), message still processed`);
    }

    // ── Step 7: Update log ──
    updateLogRecord(messageId, toolsUsed, Date.now() - startMs);

    console.log(
      `[WA-Handler] Processed in ${Date.now() - startMs}ms. Tools: [${toolsUsed.join(", ")}]. ` +
      `Response: ${finalText.slice(0, 80)}...`,
    );
  } catch (e) {
    const errorMsg = (e as Error).message;
    console.error(`[WA-Handler] Fatal error: ${errorMsg}`);

    try {
      await sendText(phone, "Ups, algo sali\u00f3 mal. Intent\u00e1 de nuevo en unos segundos. \ud83d\ude14");
    } catch {
      // Can't even send error message
    }

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

// ─── Log Helper ─────────────────────────────────────────

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
