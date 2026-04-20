/**
 * routes/telegram/tools.ts — Claude Tool definitions + executor for Telegram bot
 *
 * 11 tools available for the Telegram chatbot. Shared cases (get_study_queue,
 * check_progress, get_schedule, browse_content, ask_academic_question,
 * generate_content, generate_weekly_report, submit_review) delegate to
 * routes/_messaging/tools-base.ts. Telegram-only cases (update_agenda,
 * get_keywords, get_summary) stay inline here because they use TG-only
 * formatters (formatKeywordDetail, formatSummaryPreview).
 *
 * Uses Claude tool_use format.
 *
 * PUBLIC API: TELEGRAM_TOOLS, TELEGRAM_SYSTEM_PROMPT, executeToolCall,
 * ToolExecutionResult. Imported by routes/telegram/handler.ts.
 */

import { getAdminClient } from "../../db.ts";
import { type ClaudeTool } from "../../claude-ai.ts";
import {
  formatProgressSummary,
  formatScheduleSummary,
  formatBrowseContent,
  formatKeywordDetail,
  formatSummaryPreview,
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
  type SharedToolsConfig,
  type ToolExecutionResult,
} from "../_messaging/tools-base.ts";

export type { ToolExecutionResult };

// ─── Tool Declarations for Claude API ────────────────────

export const TELEGRAM_TOOLS: ClaudeTool[] = [
  {
    name: "get_study_queue",
    description:
      "Obtiene las flashcards pendientes de estudio del alumno, ordenadas por urgencia (FSRS + BKT). " +
      "Si el alumno dice 'qué debo estudiar', 'tengo que repasar', 'flashcards pendientes', usa esta tool. " +
      "Inicia el modo Session Mode (revisión interactiva de flashcards).",
    input_schema: {
      type: "object",
      properties: {
        course_id: { type: "string", description: "UUID del curso (opcional)" },
        limit: { type: "number", description: "Máximo flashcards (default: 10)" },
      },
    },
  },
  {
    name: "ask_academic_question",
    description:
      "Responde una pregunta académica usando RAG (Retrieval Augmented Generation) " +
      "sobre el contenido del curso del alumno. Busca en resúmenes, PDFs, y notas.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "La pregunta académica del alumno" },
        summary_id: { type: "string", description: "UUID del resumen específico (opcional)" },
      },
      required: ["question"],
    },
  },
  {
    name: "check_progress",
    description:
      "Muestra el progreso del alumno: mastery por topic, porcentaje de avance, topics débiles.",
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
      "Muestra la agenda del alumno: tareas pendientes, deadlines, sesiones planificadas. " +
      "Usa esta tool cuando el alumno pregunte por su agenda, calendario, o tareas.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "week"],
          description: "Período: 'today' para hoy, 'week' para la semana",
        },
      },
    },
  },
  {
    name: "update_agenda",
    description:
      "Actualiza la agenda del alumno: marca tareas como completadas, crea nuevas tareas, " +
      "o reprograma tareas existentes. Usa cuando el alumno diga 'completé X', 'agregá Y a mi agenda', " +
      "'reprogramá Z para mañana'.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["complete", "create", "reschedule"],
          description: "Acción: complete, create, o reschedule",
        },
        task_id: { type: "string", description: "UUID de la tarea (para complete/reschedule)" },
        title: { type: "string", description: "Título de la nueva tarea (para create)" },
        description: { type: "string", description: "Descripción (para create)" },
        due_date: { type: "string", description: "Fecha ISO (para create/reschedule)" },
        task_search: {
          type: "string",
          description: "Buscar tarea por nombre si no se tiene el UUID",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "get_keywords",
    description:
      "Obtiene las palabras clave de un tema o curso. Muestra definiciones y conexiones. " +
      "Usa cuando el alumno pregunte 'palabras clave de X', 'qué conceptos tiene Y'.",
    input_schema: {
      type: "object",
      properties: {
        course_id: { type: "string", description: "UUID del curso" },
        topic_id: { type: "string", description: "UUID del tema" },
        search_term: { type: "string", description: "Buscar keyword por nombre" },
      },
    },
  },
  {
    name: "get_summary",
    description:
      "Obtiene un resumen específico por ID o busca resúmenes por tema. " +
      "Usa cuando el alumno pida ver un resumen o pregunte 'qué resúmenes tengo de X'.",
    input_schema: {
      type: "object",
      properties: {
        summary_id: { type: "string", description: "UUID del resumen" },
        search_term: { type: "string", description: "Buscar resumen por título" },
        course_id: { type: "string", description: "Filtrar por curso" },
      },
    },
  },
  {
    name: "browse_content",
    description: "Navega el árbol de contenido: cursos, secciones, temas.",
    input_schema: {
      type: "object",
      properties: {
        course_id: { type: "string", description: "UUID del curso (opcional)" },
        section_id: { type: "string", description: "UUID de la sección (opcional)" },
      },
    },
  },
  {
    name: "generate_content",
    description:
      "Genera flashcards o quiz. Operación LENTA (~10s), se encola.",
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
    description: "Genera reporte semanal de estudio. Operación LENTA (~15s), se encola.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "submit_review",
    description:
      "Registra calificación de flashcard. SOLO durante Session Mode. Rating: 1=Fail, 3=Good, 4=Easy.",
    input_schema: {
      type: "object",
      properties: {
        flashcard_id: { type: "string", description: "UUID de la flashcard" },
        rating: { type: "number", enum: [1, 3, 4], description: "1=Fail, 3=Good, 4=Easy" },
      },
      required: ["flashcard_id", "rating"],
    },
  },
];

// ─── System Prompt ───────────────────────────────────────

export const TELEGRAM_SYSTEM_PROMPT = `Eres Axon, un asistente de estudio inteligente que ayuda a estudiantes universitarios por Telegram.

PERSONALIDAD:
- Amigable, motivador, y directo
- Español informal (tuteo), con emojis moderados
- Respuestas CORTAS: máximo 900 caracteres
- Si necesitas dar info larga, usa bullets y formato Markdown

CAPACIDADES:
- Flashcards pendientes + sesiones de repaso interactivas
- Preguntas académicas con RAG (búsqueda semántica en contenido del curso)
- Progreso del alumno, agenda/calendario, contenido del curso
- Palabras clave con definiciones y conexiones
- Resúmenes del curso
- Generar material de estudio (flashcards, quizzes)
- Actualizar la agenda del alumno desde el chat
- Transcribir y responder mensajes de voz

REGLAS:
1. SIEMPRE usa las tools en lugar de inventar respuestas
2. Si no tienes info suficiente, pregunta al alumno qué curso o tema
3. Para preguntas académicas, SIEMPRE usa ask_academic_question
4. submit_review SOLO durante sesión de flashcards activa
5. generate_content y generate_weekly_report son lentas — avisa al alumno
6. Cuando un tool retorna formatted_text, usa ESE texto como base (ya está optimizado para Telegram)
7. Para actualizar la agenda, usa update_agenda
8. Cuando el alumno pida palabras clave, usa get_keywords
9. Cuando pida ver un resumen, usa get_summary

CONTEXTO DEL ALUMNO:
{STUDENT_CONTEXT}
`;

// ─── Shared Tools Config ─────────────────────────────────

const TG_SHARED_CONFIG: SharedToolsConfig = {
  logPrefix: "TG-RAG",
  summaryContentField: "content_markdown",
  askQuestionModel: "sonnet",
  askQuestionPrompts: {
    promptWithContext: (finalContext, question) =>
      `Contexto del curso (encontrado por búsqueda semántica):\n${finalContext}\n\n---\nPregunta: ${question}`,
    promptWithoutContext: (question) =>
      `Pregunta académica (sin contexto disponible del curso): ${question}`,
    systemPrompt: (sources) =>
      "Eres un tutor universitario experto. Respondé de forma clara y concisa en español. " +
      "Máximo 800 caracteres (es para Telegram). Si tienes contexto del curso, básate en él. " +
      "Si no tienes suficiente información, dilo honestamente. " +
      (sources.length > 0
        ? `Fuentes encontradas: ${sources.join(", ")}.`
        : ""),
  },
  queuedContentMessage: "Generando contenido... Te aviso cuando esté listo. \u23f3",
  queuedReportMessage: "Generando tu reporte semanal... Te lo envío en unos segundos. \u23f3",
  formatProgressSummary,
  formatScheduleSummary,
  formatBrowseContent,
};

// ─── Tool Executor ───────────────────────────────────────

export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  userId: string,
  _sessionContext: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const db = getAdminClient();

  try {
    switch (name) {
      case "get_study_queue":
        return await handleGetStudyQueue(name, args, userId, db);

      case "check_progress":
        return await handleCheckProgress(name, args, userId, db, TG_SHARED_CONFIG);

      case "get_schedule":
        return await handleGetSchedule(name, args, userId, db, TG_SHARED_CONFIG);

      case "browse_content":
        return await handleBrowseContent(name, args, userId, db, TG_SHARED_CONFIG);

      case "ask_academic_question":
        return await handleAskAcademicQuestion(name, args, userId, db, TG_SHARED_CONFIG);

      case "generate_content":
        return handleGenerateContent(name, args, TG_SHARED_CONFIG);

      case "generate_weekly_report":
        return handleGenerateWeeklyReport(name, TG_SHARED_CONFIG);

      case "submit_review":
        return await handleSubmitReview(name, args, userId, _sessionContext, db);

      // ─── Telegram-only cases ───────────────────────────

      case "update_agenda": {
        const action = args.action as string;

        if (action === "complete") {
          let taskId = args.task_id as string | undefined;

          // Search by name if no UUID
          if (!taskId && args.task_search) {
            const { data: found } = await db
              .from("study_plan_tasks")
              .select("id, title")
              .eq("student_id", userId)
              .eq("is_completed", false)
              .ilike("title", `%${args.task_search}%`)
              .limit(1)
              .single();
            taskId = found?.id;
            if (!taskId) {
              return { name, result: { error: `No encontré la tarea "${args.task_search}"` } };
            }
          }

          if (!taskId) {
            return { name, result: { error: "Necesito el nombre o ID de la tarea" } };
          }

          const { error } = await db
            .from("study_plan_tasks")
            .update({ is_completed: true })
            .eq("id", taskId)
            .eq("student_id", userId);

          if (error) throw new Error(`update task: ${error.message}`);
          return { name, result: { success: true, message: "Tarea marcada como completada \u2705" } };
        }

        if (action === "create") {
          const title = args.title as string;
          if (!title) {
            return { name, result: { error: "Necesito un título para la tarea" } };
          }

          // Find or create a default study plan
          let { data: plan } = await db
            .from("study_plans")
            .select("id")
            .eq("student_id", userId)
            .limit(1)
            .single();

          if (!plan) {
            const { data: newPlan, error: planErr } = await db
              .from("study_plans")
              .insert({ student_id: userId, name: "Mi Plan de Estudio" })
              .select("id")
              .single();
            if (planErr) throw new Error(`create plan: ${planErr.message}`);
            plan = newPlan;
          }

          const dueDate = args.due_date
            ? new Date(args.due_date as string).toISOString()
            : new Date(Date.now() + 86_400_000).toISOString();

          const { error } = await db.from("study_plan_tasks").insert({
            study_plan_id: plan!.id,
            student_id: userId,
            title,
            description: (args.description as string) || null,
            due_date: dueDate,
            is_completed: false,
          });

          if (error) throw new Error(`create task: ${error.message}`);
          return { name, result: { success: true, message: `Tarea "${title}" agregada a tu agenda \ud83d\udcc5` } };
        }

        if (action === "reschedule") {
          let taskId = args.task_id as string | undefined;

          if (!taskId && args.task_search) {
            const { data: found } = await db
              .from("study_plan_tasks")
              .select("id")
              .eq("student_id", userId)
              .ilike("title", `%${args.task_search}%`)
              .limit(1)
              .single();
            taskId = found?.id;
          }

          if (!taskId) {
            return { name, result: { error: "Necesito el nombre o ID de la tarea" } };
          }

          const newDate = args.due_date as string;
          if (!newDate) {
            return { name, result: { error: "Necesito la nueva fecha" } };
          }

          const { error } = await db
            .from("study_plan_tasks")
            .update({ due_date: new Date(newDate).toISOString() })
            .eq("id", taskId)
            .eq("student_id", userId);

          if (error) throw new Error(`reschedule task: ${error.message}`);
          return { name, result: { success: true, message: "Tarea reprogramada \ud83d\udcc6" } };
        }

        return { name, result: { error: `Acción desconocida: ${action}` } };
      }

      case "get_keywords": {
        // 8.2: Resolve user's institution for scoping
        const { data: kwMembership } = await db
          .from("memberships")
          .select("institution_id")
          .eq("user_id", userId)
          .eq("is_active", true)
          .limit(1)
          .single();
        const kwInstitutionId = kwMembership?.institution_id;

        if (args.search_term) {
          let kwSearchQuery = db
            .from("keywords")
            .select("id, name, definition, topic_id, topics!inner(name, section_id, sections!inner(name, course_id, courses!inner(name, institution_id)))")
            .ilike("name", `%${args.search_term}%`)
            .limit(5);
          if (kwInstitutionId) {
            kwSearchQuery = kwSearchQuery.eq("topics.sections.courses.institution_id", kwInstitutionId);
          }
          const { data, error } = await kwSearchQuery;
          if (error) throw new Error(`keywords search: ${error.message}`);

          if (!data?.length) {
            return { name, result: { keywords: [], formatted_text: "No encontré esa palabra clave. \ud83d\ude14" } };
          }

          // Get connections for first keyword
          const firstKeyword = data[0];
          const { data: connections } = await db
            .from("keyword_connections")
            .select("keyword_a_id, keyword_b_id, relationship, keyword_a:keywords!keyword_a_id(name), keyword_b:keywords!keyword_b_id(name)")
            .or(`keyword_a_id.eq.${firstKeyword.id},keyword_b_id.eq.${firstKeyword.id}`)
            .limit(8);

          const connList = (connections ?? []).map((c) => {
            const isA = c.keyword_a_id === firstKeyword.id;
            return {
              name: isA
                ? ((c.keyword_b as { name: string })?.name ?? "?")
                : ((c.keyword_a as { name: string })?.name ?? "?"),
              relationship: c.relationship,
            };
          });

          const formatted = formatKeywordDetail({
            name: firstKeyword.name,
            definition: firstKeyword.definition,
            connections: connList,
          });

          return { name, result: { keywords: data, connections: connList, formatted_text: formatted } };
        }

        // List keywords by course or topic
        let query = db
          .from("keywords")
          .select("id, name, definition, topic_id, topics!inner(section_id, sections!inner(course_id, courses!inner(institution_id)))")
          .limit(20);

        if (args.topic_id) {
          query = query.eq("topic_id", args.topic_id as string);
        }
        if (kwInstitutionId) {
          query = query.eq("topics.sections.courses.institution_id", kwInstitutionId);
        }

        const { data, error } = await query;
        if (error) throw new Error(`keywords: ${error.message}`);

        return { name, result: { keywords: data ?? [], count: data?.length ?? 0 } };
      }

      case "get_summary": {
        // 8.2: Resolve user's institution for scoping
        const { data: sumMembership } = await db
          .from("memberships")
          .select("institution_id")
          .eq("user_id", userId)
          .eq("is_active", true)
          .limit(1)
          .single();
        const sumInstitutionId = sumMembership?.institution_id;

        if (args.summary_id) {
          // Fetch with institution join to verify scope
          let sumByIdQuery = db
            .from("summaries")
            .select("id, title, content_markdown, word_count, topic_id, topics!inner(section_id, sections!inner(course_id, courses!inner(institution_id)))")
            .eq("id", args.summary_id as string);
          if (sumInstitutionId) {
            sumByIdQuery = sumByIdQuery.eq("topics.sections.courses.institution_id", sumInstitutionId);
          }
          const { data, error } = await sumByIdQuery.single();
          if (error) throw new Error(`summary: ${error.message}`);
          if (!data) return { name, result: { error: "Resumen no encontrado" } };

          const formatted = formatSummaryPreview(
            data.title,
            (data.content_markdown as string) || "",
            data.word_count,
          );

          return { name, result: { summary: data, formatted_text: formatted } };
        }

        if (args.search_term) {
          let sumSearchQuery = db
            .from("summaries")
            .select("id, title, word_count, topic_id, topics!inner(section_id, sections!inner(course_id, courses!inner(institution_id)))")
            .ilike("title", `%${args.search_term}%`)
            .eq("is_active", true)
            .is("deleted_at", null)
            .limit(10);
          if (sumInstitutionId) {
            sumSearchQuery = sumSearchQuery.eq("topics.sections.courses.institution_id", sumInstitutionId);
          }
          const { data, error } = await sumSearchQuery;
          if (error) throw new Error(`summary search: ${error.message}`);

          return { name, result: { summaries: data ?? [], count: data?.length ?? 0 } };
        }

        return { name, result: { error: "Necesito un ID o término de búsqueda" } };
      }

      default:
        return { name, result: null, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    const errorMsg = (e as Error).message;
    console.error(`[TG-Tools] ${name} failed: ${errorMsg}`);
    return { name, result: null, error: errorMsg };
  }
}
