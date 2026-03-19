/**
 * routes/whatsapp/tools.ts -- Claude tool_use definitions + executor
 *
 * 9 tools available to the WhatsApp chatbot.
 * Migrated from Gemini function_declarations to Claude tool_use format.
 *
 * Phase 3 changes:
 *   S14: handle_voice_message now uses Gemini multimodal STT
 *   S15: ask_academic_question uses full RAG pipeline
 *        (embeddings + hybrid search + re-ranking)
 *
 * N8 FIX: Integrated formatters for check_progress, get_schedule,
 *         browse_content. Claude gets pre-formatted WhatsApp text.
 *
 * W3-01 FIX: ragSearch() RPC params corrected to match chat.ts
 * W3-02 FIX: course_members -> memberships (table doesn't exist)
 * W3-03 FIX: institution_id resolution added (cross-tenant data leak)
 * W3-07 FIX: browse_content course listing via memberships
 */

import { getAdminClient } from "../../db.ts";
import { generateText, type ClaudeTool } from "../../claude-ai.ts";
import { ragSearch } from "../../lib/rag-search.ts";
import {
  formatProgressSummary,
  formatScheduleSummary,
  formatBrowseContent,
} from "./formatter.ts";

// ─── Types ───────────────────────────────────────────────

export interface ToolExecutionResult {
  name: string;
  result: unknown;
  error?: string;
  isAsync?: boolean;
}

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
  {
    name: "handle_voice_message",
    description:
      "Procesa un mensaje de voz: transcribe y responde. " +
      "Se activa automaticamente cuando el alumno envia un audio.",
    input_schema: {
      type: "object",
      properties: {
        audio_base64: { type: "string", description: "Audio en base64" },
        mime_type: { type: "string", description: "MIME type (e.g., audio/ogg)" },
      },
      required: ["audio_base64", "mime_type"],
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

        // N8 FIX: Inject pre-formatted WhatsApp text
        const formatted = formatProgressSummary(resultData as {
          total_topics: number;
          average_mastery: string;
          weak_topics: string[];
          details: Array<{ topic_name: string; course_name: string; mastery_level: number }>;
        });

        return {
          name,
          result: { ...resultData, formatted_text: formatted },
        };
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

        // N8 FIX: Inject pre-formatted WhatsApp text
        const formatted = formatScheduleSummary(resultData as {
          period: string;
          tasks: Array<{ title: string; due_date: string; is_completed: boolean; description?: string }>;
          pending: number;
          completed: number;
        });

        return {
          name,
          result: { ...resultData, formatted_text: formatted },
        };
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
          // W3-07 FIX: course_members doesn't exist -> use memberships + courses
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

        // N8 FIX: Inject pre-formatted WhatsApp text
        const formatted = formatBrowseContent(browseResult as {
          level: "courses" | "sections" | "keywords";
          items: Array<Record<string, unknown>>;
        });

        return {
          name,
          result: { ...browseResult, formatted_text: formatted },
        };
      }

      case "submit_review": {
        const ghostSessionId = sessionContext.ghost_session_id as string;
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

      // S15: Full RAG pipeline (now uses shared ragSearch from lib/rag-search.ts)
      case "ask_academic_question": {
        const question = args.question as string;
        const summaryId = args.summary_id as string | undefined;

        const { context, sources, strategy } = await ragSearch(
          question,
          userId,
          summaryId,
        );

        console.warn(
          `[WA-RAG] strategy=${strategy}, sources=${sources.length}, ` +
          `context=${context.length} chars`,
        );

        let finalContext = context;
        if (!finalContext && summaryId) {
          const { data } = await db
            .from("summaries")
            .select("title, content")
            .eq("id", summaryId)
            .single();
          if (data) {
            finalContext = `Fuente: "${data.title}"\n${((data.content as string) || "").slice(0, 4000)}`;
          }
        }

        const { text } = await generateText({
          prompt: finalContext
            ? `Contexto del curso (encontrado por busqueda semantica):\n${finalContext}\n\n---\nPregunta: ${question}`
            : `Pregunta academica (sin contexto disponible del curso): ${question}`,
          systemPrompt:
            "Eres un tutor universitario experto. Responde de forma clara y concisa en espanol. " +
            "Maximo 800 caracteres (es para WhatsApp). Si tenes contexto del curso, basate en el. " +
            "Si no tenes suficiente informacion, decilo honestamente. " +
            (sources.length > 0
              ? `Fuentes encontradas: ${sources.join(", ")}.`
              : ""),
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
            message: "Generando contenido... Te aviso cuando este listo.",
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
            message: "Generando tu reporte semanal... Te lo envio en unos segundos.",
          },
          isAsync: true,
        };
      }

      case "handle_voice_message": {
        return {
          name,
          result: {
            message: "La transcripcion de voz se procesa automaticamente. " +
              "El texto transcrito se envia como mensaje normal.",
          },
        };
      }

      default:
        return { name, result: null, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    const errorMsg = (e as Error).message;
    console.error(`[WA-Tools] ${name} failed: ${errorMsg}`);
    return { name, result: null, error: errorMsg };
  }
}
