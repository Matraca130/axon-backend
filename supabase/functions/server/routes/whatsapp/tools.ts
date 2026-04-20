/**
 * routes/whatsapp/tools.ts -- Claude tool_use definitions + executor
 *
 * 9 tools available to the WhatsApp chatbot. Shared cases delegate to
 * routes/_messaging/tools-base.ts; the one WA-only case
 * (handle_voice_message) stays inline here.
 *
 * Phase 3 changes:
 *   S15: ask_academic_question uses full RAG pipeline
 *        (embeddings + hybrid search + re-ranking)
 *   Note: voice messages are transcribed in transcribeVoiceMessage() (handler.ts)
 *         before the agentic loop; handle_voice_message tool was removed post-migration.
 *
 * N8 FIX: Integrated formatters for check_progress, get_schedule,
 *         browse_content. Claude gets pre-formatted WhatsApp text.
 *
 * W3-01 FIX: ragSearch() RPC params corrected to match chat.ts
 * W3-02 FIX: course_members -> memberships (table doesn't exist)
 * W3-03 FIX: institution_id resolution added (cross-tenant data leak)
 * W3-07 FIX: browse_content course listing via memberships
 *
 * PUBLIC API: WHATSAPP_TOOLS, WHATSAPP_SYSTEM_PROMPT, executeToolCall,
 * convertClaudeToolsToGemini, GeminiFunctionDeclaration,
 * ToolExecutionResult. Imported by routes/whatsapp/handler.ts.
 */

import { getAdminClient } from "../../db.ts";
import { type ClaudeTool } from "../../claude-ai.ts";
import {
  formatProgressSummary,
  formatScheduleSummary,
  formatBrowseContent,
} from "./formatter.ts";
import {
  handleGetStudyQueue,
  handleCheckProgress,
  handleGetSchedule,
  handleBrowseContent,
  handleAskAcademicQuestion,
  handleGenerateContent,
  handleGenerateWeeklyReport,
  handleSubmitReview,
  convertClaudeToolsToGemini,
  type GeminiFunctionDeclaration,
  type SharedToolsConfig,
  type ToolExecutionResult,
} from "../_messaging/tools-base.ts";

<<<<<<< HEAD
// ─── Types ───────────────────────────────────────────────

export interface ToolExecutionResult {
  name: string;
  result: unknown;
  error?: string;
  isAsync?: boolean;
}
=======
export type { ToolExecutionResult, GeminiFunctionDeclaration };
export { convertClaudeToolsToGemini };
>>>>>>> origin/main

// ─── Tool Declarations for Claude API ─────────────────────

export const WHATSAPP_TOOLS: ClaudeTool[] = [
  {
    name: "get_study_queue",
    description:
      "Obtiene las flashcards pendientes de estudio del alumno, ordenadas por urgencia (FSRS + BKT). " +
      "Si el alumno dice 'que debo estudiar', 'tengo que repasar', 'flashcards pendientes', usa esta tool. " +
      "Inicia el modo Session Mode (revision interactiva de flashcards).",
    input_schema: {
      type: "object",
      properties: {
        course_id: { type: "string", description: "UUID del curso (opcional)" },
        limit: { type: "number", description: "Maximo flashcards (default: 10)" },
      },
    },
  },
  {
    name: "ask_academic_question",
    description:
      "Responde una pregunta academica usando RAG (Retrieval Augmented Generation) " +
      "sobre el contenido del curso del alumno. Busca en resumenes, PDFs, y notas. " +
      "Usa esta tool cuando el alumno hace preguntas como 'explicame mitosis', " +
      "'que es la ley de Ohm', 'como se calcula el PIB'.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "La pregunta academica del alumno" },
        summary_id: { type: "string", description: "UUID del resumen especifico (opcional)" },
      },
      required: ["question"],
    },
  },
  {
    name: "check_progress",
    description:
      "Muestra el progreso del alumno: mastery por topic, porcentaje de avance, topics debiles.",
    input_schema: {
      type: "object",
      properties: {
        course_name: { type: "string", description: "Nombre del curso (opcional)" },
      },
    },
  },
  {
    name: "get_schedule",
    description:
      "Muestra tareas pendientes, deadlines, sesiones planificadas.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "week"], description: "hoy o semana" },
      },
    },
  },
  {
    name: "submit_review",
    description:
      "Registra calificacion de flashcard. SOLO durante Session Mode. Rating: 1=Fail, 3=Good, 4=Easy.",
    input_schema: {
      type: "object",
      properties: {
        flashcard_id: { type: "string", description: "UUID de la flashcard" },
        rating: { type: "number", enum: [1, 3, 4], description: "1=Fail, 3=Good, 4=Easy" },
      },
      required: ["flashcard_id", "rating"],
    },
  },
  {
    name: "browse_content",
    description: "Navega el arbol de contenido: cursos, secciones, keywords.",
    input_schema: {
      type: "object",
      properties: {
        course_id: { type: "string", description: "UUID del curso (opcional)" },
        section_id: { type: "string", description: "UUID de la seccion (opcional)" },
      },
    },
  },
  {
    name: "generate_content",
    description:
      "Genera flashcards o quiz. Operacion LENTA (~10s), se encola.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["flashcard", "quiz"], description: "Tipo" },
        summary_id: { type: "string", description: "UUID del resumen" },
      },
      required: ["action", "summary_id"],
    },
  },
  {
    name: "generate_weekly_report",
    description: "Genera reporte semanal. Operacion LENTA (~15s), se encola.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

// ─── System Prompt ──────────────────────────────────────

export const WHATSAPP_SYSTEM_PROMPT = `Eres Axon, un asistente de estudio inteligente que ayuda a estudiantes universitarios por WhatsApp.

PERSONALIDAD:
- Amigable, motivador, y directo
- Espanol informal (tuteo), con emojis moderados
- Respuestas CORTAS: maximo 900 caracteres
- Si necesitas dar info larga, usa bullets

CAPACIDADES:
- Flashcards pendientes + sesiones de repaso interactivas
- Preguntas academicas con RAG (busqueda semantica en contenido del curso)
- Progreso, agenda, contenido del curso
- Generar material de estudio (flashcards, quizzes)
- Transcribir y responder mensajes de voz

REGLAS:
1. SIEMPRE usa las tools en lugar de inventar respuestas
2. Si no tienes info suficiente, pregunta al alumno que curso o tema
3. Para preguntas academicas, SIEMPRE usa ask_academic_question
4. submit_review SOLO durante sesion de flashcards activa
5. generate_content y generate_weekly_report son lentas -- avisa al alumno
6. Cuando recibes un tool_result con formatted_text, usa ESE texto como base de tu respuesta (ya esta optimizado para WhatsApp). Podes ajustarlo levemente pero no lo reescribas desde cero.

CONTEXTO DEL ALUMNO:
{STUDENT_CONTEXT}
`;

// ─── Shared Tools Config ─────────────────────────────────

const WA_SHARED_CONFIG: SharedToolsConfig = {
  logPrefix: "WA-RAG",
  summaryContentField: "content",
  askQuestionPrompts: {
    promptWithContext: (finalContext, question) =>
      `Contexto del curso (encontrado por busqueda semantica):\n${finalContext}\n\n---\nPregunta: ${question}`,
    promptWithoutContext: (question) =>
      `Pregunta academica (sin contexto disponible del curso): ${question}`,
    systemPrompt: (sources) =>
      "Eres un tutor universitario experto. Respondé de forma clara y concisa en español. " +
      "Máximo 800 caracteres (es para WhatsApp). Si tenés contexto del curso, basate en él. " +
      "Si no tenés suficiente información, decilo honestamente. " +
      (sources.length > 0
        ? `Fuentes encontradas: ${sources.join(", ")}.`
        : ""),
  },
  queuedContentMessage: "Generando contenido... Te aviso cuando este listo.",
  queuedReportMessage: "Generando tu reporte semanal... Te lo envio en unos segundos.",
  formatProgressSummary,
  formatScheduleSummary,
  formatBrowseContent,
};

// ─── Tool Executor ───────────────────────────────────────

export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  userId: string,
  sessionContext: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const db = getAdminClient();

  try {
    switch (name) {
      case "get_study_queue":
        return await handleGetStudyQueue(name, args, userId, db);

      case "check_progress":
        return await handleCheckProgress(name, args, userId, db, WA_SHARED_CONFIG);

      case "get_schedule":
        return await handleGetSchedule(name, args, userId, db, WA_SHARED_CONFIG);

      case "browse_content":
        return await handleBrowseContent(name, args, userId, db, WA_SHARED_CONFIG);

      case "submit_review":
        return await handleSubmitReview(name, args, userId, sessionContext, db);

      case "ask_academic_question":
        return await handleAskAcademicQuestion(name, args, userId, db, WA_SHARED_CONFIG);

      case "generate_content":
        return handleGenerateContent(name, args, WA_SHARED_CONFIG);

      case "generate_weekly_report":
        return handleGenerateWeeklyReport(name, WA_SHARED_CONFIG);

      // ─── WhatsApp-only cases ───────────────────────────

      default:
        return { name, result: null, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    const errorMsg = (e as Error).message;
    console.error(`[WA-Tools] ${name} failed: ${errorMsg}`);
    return { name, result: null, error: errorMsg };
  }
}
