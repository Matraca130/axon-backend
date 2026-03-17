/**
 * routes/telegram/tools.ts — Claude Tool definitions + executor for Telegram bot
 *
 * Reuses the same DB queries as WhatsApp tools but with Claude API tool format.
 * 11 tools available for the Telegram chatbot (extends WhatsApp's 9 with
 * update_agenda and get_keywords).
 *
 * Uses Claude tool_use format instead of Gemini function_declarations.
 */

import { getAdminClient } from "../../db.ts";
import {
  generateText as claudeGenerateText,
  type ClaudeTool,
} from "../../claude-ai.ts";
import {
  selectStrategy,
  executeRetrievalEmbedding,
  rerankWithClaude,
  mergeSearchResults,
  type MatchedChunk,
} from "../../retrieval-strategies.ts";
import {
  formatProgressSummary,
  formatScheduleSummary,
  formatBrowseContent,
  formatKeywordDetail,
  formatSummaryPreview,
} from "./formatter.ts";

// ─── Types ───────────────────────────────────────────────

export interface ToolExecutionResult {
  name: string;
  result: unknown;
  error?: string;
  isAsync?: boolean;
}

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

// ─── RAG Search Helper ──────────────────────────────────

const RAG_MAX_CONTEXT_CHARS = 4000;
const RAG_TOP_K = 5;

async function ragSearch(
  question: string,
  userId: string,
  summaryId?: string,
): Promise<{ context: string; sources: string[]; strategy: string }> {
  const db = getAdminClient();

  try {
    let institutionId: string | null = null;

    if (summaryId) {
      const { data: instId } = await db.rpc("resolve_parent_institution", {
        p_table: "summaries",
        p_id: summaryId,
      });
      institutionId = instId as string | null;
    }

    if (!institutionId) {
      const { data: membership } = await db
        .from("memberships")
        .select("institution_id")
        .eq("user_id", userId)
        .eq("is_active", true)
        .limit(1)
        .single();
      institutionId = membership?.institution_id ?? null;
    }

    if (!institutionId) {
      return { context: "", sources: [], strategy: "no_institution" };
    }

    const strategy = summaryId ? "standard" : selectStrategy(question, summaryId ?? null, 0);
    const { embeddings } = await executeRetrievalEmbedding(strategy, question);

    const searchPromises = embeddings.map(async ({ embedding }) => {
      const { data, error } = await db.rpc("rag_hybrid_search", {
        p_query_embedding: JSON.stringify(embedding),
        p_query_text: question,
        p_institution_id: institutionId,
        p_match_count: RAG_TOP_K * 2,
        p_similarity_threshold: 0.3,
        p_summary_id: summaryId ?? null,
      });

      if (error) {
        console.warn(`[TG-RAG] hybrid search failed: ${error.message}`);
        return [] as MatchedChunk[];
      }
      return (data ?? []) as MatchedChunk[];
    });

    const resultSets = await Promise.all(searchPromises);
    let merged = mergeSearchResults(resultSets);

    if (merged.length === 0) {
      return { context: "", sources: [], strategy: `${strategy}_empty` };
    }

    merged = await rerankWithClaude(question, merged, RAG_TOP_K);

    let contextChars = 0;
    const contextParts: string[] = [];
    const sources: string[] = [];

    for (const chunk of merged) {
      if (contextChars + chunk.content.length > RAG_MAX_CONTEXT_CHARS) {
        const remaining = RAG_MAX_CONTEXT_CHARS - contextChars;
        if (remaining > 200) {
          contextParts.push(
            `## ${chunk.summary_title}\n${chunk.content.slice(0, remaining)}...`,
          );
        }
        break;
      }
      contextParts.push(`## ${chunk.summary_title}\n${chunk.content}`);
      contextChars += chunk.content.length;
      if (!sources.includes(chunk.summary_title)) {
        sources.push(chunk.summary_title);
      }
    }

    return { context: contextParts.join("\n\n"), sources, strategy };
  } catch (e) {
    console.error(`[TG-RAG] Pipeline failed: ${(e as Error).message}`);
    return { context: "", sources: [], strategy: "error" };
  }
}

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
      case "get_study_queue": {
        const { data, error } = await db.rpc("get_study_queue", {
          p_student_id: userId,
          p_course_id: (args.course_id as string) || null,
          p_limit: (args.limit as number) || 10,
          p_include_future: false,
        });
        if (error) throw new Error(`study_queue RPC: ${error.message}`);
        return { name, result: { cards: data, count: data?.length ?? 0 } };
      }

      case "check_progress": {
        let query = db
          .from("topic_progress")
          .select("topic_id, topic_name, course_name, mastery_level, items_reviewed, items_total")
          .eq("student_id", userId)
          .order("mastery_level", { ascending: true })
          .limit(20);
        if (args.course_name) {
          query = query.ilike("course_name", `%${args.course_name}%`);
        }
        const { data, error } = await query;
        if (error) throw new Error(`topic_progress: ${error.message}`);
        const total = data?.length ?? 0;
        const avgMastery = total > 0
          ? (data!.reduce((sum, r) => sum + (r.mastery_level ?? 0), 0) / total).toFixed(1)
          : "0";
        const weakTopics = data?.filter((r) => (r.mastery_level ?? 0) < 0.5) ?? [];

        const resultData = {
          total_topics: total,
          average_mastery: avgMastery,
          weak_topics: weakTopics.slice(0, 5).map((t) => t.topic_name),
          details: data?.slice(0, 10),
        };

        const formatted = formatProgressSummary(resultData as {
          total_topics: number;
          average_mastery: string;
          weak_topics: string[];
          details: Array<{ topic_name: string; course_name: string; mastery_level: number }>;
        });

        return { name, result: { ...resultData, formatted_text: formatted } };
      }

      case "get_schedule": {
        const period = (args.period as string) || "today";
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endDate = period === "week"
          ? new Date(startOfDay.getTime() + 7 * 86_400_000)
          : new Date(startOfDay.getTime() + 86_400_000);
        const { data, error } = await db
          .from("study_plan_tasks")
          .select("id, title, description, due_date, is_completed, study_plans(name)")
          .eq("student_id", userId)
          .gte("due_date", startOfDay.toISOString())
          .lt("due_date", endDate.toISOString())
          .order("due_date", { ascending: true })
          .limit(20);
        if (error) throw new Error(`study_plan_tasks: ${error.message}`);

        const resultData = {
          period,
          tasks: data ?? [],
          pending: data?.filter((t) => !t.is_completed).length ?? 0,
          completed: data?.filter((t) => t.is_completed).length ?? 0,
        };

        const formatted = formatScheduleSummary(resultData as {
          period: string;
          tasks: Array<{ title: string; due_date: string; is_completed: boolean; description?: string }>;
          pending: number;
          completed: number;
        });

        return { name, result: { ...resultData, formatted_text: formatted } };
      }

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
        if (args.search_term) {
          const { data, error } = await db
            .from("keywords")
            .select("id, name, definition, topic_id, topics(name, section_id, sections(name, course_id, courses(name)))")
            .ilike("name", `%${args.search_term}%`)
            .limit(5);
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
          .select("id, name, definition")
          .limit(20);

        if (args.topic_id) {
          query = query.eq("topic_id", args.topic_id as string);
        }

        const { data, error } = await query;
        if (error) throw new Error(`keywords: ${error.message}`);

        return { name, result: { keywords: data ?? [], count: data?.length ?? 0 } };
      }

      case "get_summary": {
        if (args.summary_id) {
          const { data, error } = await db
            .from("summaries")
            .select("id, title, content_markdown, word_count")
            .eq("id", args.summary_id as string)
            .single();
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
          const { data, error } = await db
            .from("summaries")
            .select("id, title, word_count")
            .ilike("title", `%${args.search_term}%`)
            .eq("is_active", true)
            .is("deleted_at", null)
            .limit(10);
          if (error) throw new Error(`summary search: ${error.message}`);

          return { name, result: { summaries: data ?? [], count: data?.length ?? 0 } };
        }

        return { name, result: { error: "Necesito un ID o término de búsqueda" } };
      }

      case "browse_content": {
        let browseResult: { level: string; items: unknown[] };

        if (args.section_id) {
          const { data: topics } = await db
            .from("topics")
            .select("id")
            .eq("section_id", args.section_id as string)
            .is("deleted_at", null);

          const topicIds = topics?.map((t) => t.id) ?? [];

          if (topicIds.length > 0) {
            const { data: summaries } = await db
              .from("summaries")
              .select("id, title")
              .in("topic_id", topicIds)
              .is("deleted_at", null)
              .eq("is_active", true)
              .order("order_index", { ascending: true })
              .limit(30);
            browseResult = { level: "summaries", items: summaries ?? [] };
          } else {
            browseResult = { level: "summaries", items: [] };
          }
        } else if (args.course_id) {
          const { data, error } = await db
            .from("sections")
            .select("id, name, position")
            .eq("course_id", args.course_id as string)
            .order("position", { ascending: true });
          if (error) throw new Error(`sections: ${error.message}`);
          browseResult = { level: "sections", items: data ?? [] };
        } else {
          const { data: memData } = await db
            .from("memberships")
            .select("institution_id")
            .eq("user_id", userId)
            .eq("is_active", true);

          const instIds = memData?.map((m) => m.institution_id) ?? [];
          let courseItems: unknown[] = [];

          if (instIds.length > 0) {
            const { data: coursesData, error } = await db
              .from("courses")
              .select("id, name, code")
              .in("institution_id", instIds)
              .eq("is_active", true);
            if (error) throw new Error(`courses: ${error.message}`);
            courseItems = coursesData ?? [];
          }

          browseResult = { level: "courses", items: courseItems };
        }

        const formatted = formatBrowseContent(browseResult as {
          level: "courses" | "sections" | "keywords" | "summaries";
          items: Array<Record<string, unknown>>;
        });

        return { name, result: { ...browseResult, formatted_text: formatted } };
      }

      case "ask_academic_question": {
        const question = args.question as string;
        const summaryId = args.summary_id as string | undefined;

        const { context, sources, strategy } = await ragSearch(
          question,
          userId,
          summaryId,
        );

        console.log(
          `[TG-RAG] strategy=${strategy}, sources=${sources.length}, context=${context.length} chars`,
        );

        let finalContext = context;
        if (!finalContext && summaryId) {
          const { data } = await db
            .from("summaries")
            .select("title, content_markdown")
            .eq("id", summaryId)
            .single();
          if (data) {
            finalContext = `Fuente: "${data.title}"\n${((data.content_markdown as string) || "").slice(0, 4000)}`;
          }
        }

        const { text } = await claudeGenerateText({
          prompt: finalContext
            ? `Contexto del curso (encontrado por búsqueda semántica):\n${finalContext}\n\n---\nPregunta: ${question}`
            : `Pregunta académica (sin contexto disponible del curso): ${question}`,
          systemPrompt:
            "Eres un tutor universitario experto. Respondé de forma clara y concisa en español. " +
            "Máximo 800 caracteres (es para Telegram). Si tienes contexto del curso, básate en él. " +
            "Si no tienes suficiente información, dilo honestamente. " +
            (sources.length > 0
              ? `Fuentes encontradas: ${sources.join(", ")}.`
              : ""),
          model: "sonnet",
          temperature: 0.3,
          maxTokens: 512,
        });

        return {
          name,
          result: {
            answer: text,
            sources: sources.length > 0 ? sources : undefined,
            strategy,
          },
        };
      }

      case "generate_content": {
        return {
          name,
          result: {
            status: "queued",
            message: "Generando contenido... Te aviso cuando esté listo. \u23f3",
            action: args.action,
            summary_id: args.summary_id,
          },
          isAsync: true,
        };
      }

      case "generate_weekly_report": {
        return {
          name,
          result: {
            status: "queued",
            message: "Generando tu reporte semanal... Te lo envío en unos segundos. \u23f3",
          },
          isAsync: true,
        };
      }

      case "submit_review": {
        const ghostSessionId = _sessionContext.ghost_session_id as string;
        if (!ghostSessionId) {
          return { name, result: null, error: "No active flashcard session." };
        }
        const rating = args.rating as number;
        if (![1, 3, 4].includes(rating)) {
          return { name, result: null, error: `Invalid rating ${rating}.` };
        }
        const { data, error } = await db
          .from("reviews")
          .insert({
            session_id: ghostSessionId,
            item_id: args.flashcard_id as string,
            instrument_type: "flashcard",
            grade: rating,
          })
          .select("id")
          .single();
        if (error) throw new Error(`review insert: ${error.message}`);
        return { name, result: { review_id: data?.id, rating } };
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
