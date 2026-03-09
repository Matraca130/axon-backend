/**
 * routes/whatsapp/tools.ts — Gemini Function Calling definitions + executor
 *
 * 9 tools available to the WhatsApp chatbot.
 *
 * C12 FIX: Removed unused SupabaseClient type import.
 * N8 FIX: Integrated formatters for check_progress, get_schedule,
 *         browse_content. Gemini now gets pre-formatted WhatsApp text
 *         alongside raw data for better response quality.
 *
 * @see AUDIT F4: Direct DB queries (handlers are module-private)
 * @see AUDIT F5: Ghost session for submit_review
 */

import { getAdminClient } from "../../db.ts";
import { generateText } from "../../gemini.ts";
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

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ─── Tool Declarations for Gemini API ─────────────────────

export const WHATSAPP_TOOLS: GeminiFunctionDeclaration[] = [
  {
    name: "get_study_queue",
    description:
      "Obtiene las flashcards pendientes de estudio del alumno, ordenadas por urgencia (FSRS + BKT). " +
      "Si el alumno dice 'qu\u00e9 debo estudiar', 'tengo que repasar', 'flashcards pendientes', usa esta tool. " +
      "Inicia el modo Session Mode (revisi\u00f3n interactiva de flashcards).",
    parameters: {
      type: "object",
      properties: {
        course_id: {
          type: "string",
          description: "UUID del curso (opcional, filtra por curso espec\u00edfico)",
        },
        limit: {
          type: "integer",
          description: "N\u00famero m\u00e1ximo de flashcards a obtener (default: 10)",
        },
      },
    },
  },
  {
    name: "ask_academic_question",
    description:
      "Responde una pregunta acad\u00e9mica usando RAG (Retrieval Augmented Generation) " +
      "sobre el contenido del curso del alumno. Busca en res\u00famenes, PDFs, y notas. " +
      "Usa esta tool cuando el alumno hace preguntas como 'explic\u00e1me mitosis', " +
      "'qu\u00e9 es la ley de Ohm', 'c\u00f3mo se calcula el PIB'.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "La pregunta acad\u00e9mica del alumno",
        },
        summary_id: {
          type: "string",
          description: "UUID del resumen espec\u00edfico a consultar (opcional)",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "check_progress",
    description:
      "Muestra el progreso del alumno: mastery por topic, porcentaje de avance, " +
      "topics d\u00e9biles. Usa cuando el alumno pregunta 'c\u00f3mo voy', 'mi progreso', 'qu\u00e9 me falta'.",
    parameters: {
      type: "object",
      properties: {
        course_name: {
          type: "string",
          description: "Nombre del curso para filtrar (opcional)",
        },
      },
    },
  },
  {
    name: "get_schedule",
    description:
      "Muestra el plan de estudio del alumno: tareas pendientes, deadlines, sesiones planificadas. " +
      "Usa cuando el alumno dice 'qu\u00e9 tengo para hoy', 'mi agenda', 'tareas de la semana'.",
    parameters: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "week"],
          description: "Per\u00edodo a consultar: hoy o esta semana",
        },
      },
    },
  },
  {
    name: "submit_review",
    description:
      "Registra la calificaci\u00f3n de una flashcard durante una sesi\u00f3n de revisi\u00f3n. " +
      "SOLO usar durante Session Mode (flashcard_review). " +
      "Rating: 1=Fail (no la sab\u00eda), 3=Good (la sab\u00eda con esfuerzo), 4=Easy (la sab\u00eda instant\u00e1neamente).",
    parameters: {
      type: "object",
      properties: {
        flashcard_id: {
          type: "string",
          description: "UUID de la flashcard",
        },
        rating: {
          type: "integer",
          enum: [1, 3, 4],
          description: "1=Fail, 3=Good, 4=Easy (FSRS rating scale)",
        },
      },
      required: ["flashcard_id", "rating"],
    },
  },
  {
    name: "browse_content",
    description:
      "Navega el \u00e1rbol de contenido del curso: secciones, keywords, res\u00famenes disponibles. " +
      "Usa cuando el alumno dice 'qu\u00e9 temas hay', 'ver contenido', 'explorar curso'.",
    parameters: {
      type: "object",
      properties: {
        course_id: {
          type: "string",
          description: "UUID del curso (opcional)",
        },
        section_id: {
          type: "string",
          description: "UUID de la secci\u00f3n para ver sub-items (opcional)",
        },
      },
    },
  },
  {
    name: "generate_content",
    description:
      "Genera flashcards o preguntas de quiz sobre un tema espec\u00edfico usando IA adaptativa. " +
      "Operaci\u00f3n LENTA (~10s). Se encolar\u00e1 y el alumno recibir\u00e1 una notificaci\u00f3n cuando est\u00e9 lista.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["flashcard", "quiz"],
          description: "Tipo de contenido a generar",
        },
        summary_id: {
          type: "string",
          description: "UUID del resumen sobre el que generar contenido",
        },
      },
      required: ["action", "summary_id"],
    },
  },
  {
    name: "generate_weekly_report",
    description:
      "Genera un reporte semanal de estudio con estad\u00edsticas, logros, y recomendaciones. " +
      "Operaci\u00f3n LENTA (~15s). Se encolar\u00e1 y el alumno recibir\u00e1 el reporte cuando est\u00e9 listo. " +
      "Usa cuando el alumno dice 'mi reporte', 'c\u00f3mo fue mi semana', 'reporte semanal'.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "handle_voice_message",
    description:
      "Procesa un mensaje de voz del alumno: transcribe el audio y responde a la pregunta. " +
      "Se activa autom\u00e1ticamente cuando el alumno env\u00eda un audio.",
    parameters: {
      type: "object",
      properties: {
        audio_base64: {
          type: "string",
          description: "Audio en base64 (proporcionado por el handler)",
        },
        mime_type: {
          type: "string",
          description: "MIME type del audio (e.g., audio/ogg)",
        },
      },
      required: ["audio_base64", "mime_type"],
    },
  },
];

// ─── System Prompt ──────────────────────────────────────

export const WHATSAPP_SYSTEM_PROMPT = `Eres Axon, un asistente de estudio inteligente que ayuda a estudiantes universitarios por WhatsApp.

PERSONALIDAD:
- Amigable, motivador, y directo
- Espa\u00f1ol informal (tuteo), con emojis moderados (\ud83d\udcda \u2705 \ud83d\udcaa \ud83c\udfaf, no excesivos)
- Respuestas CORTAS: m\u00e1ximo 900 caracteres (WhatsApp se lee en m\u00f3vil)
- Si necesitas dar info larga, divide en m\u00faltiples mensajes o usa bullets

CAPACIDADES:
- Puedes consultar las flashcards pendientes del alumno y iniciar sesiones de repaso
- Puedes responder preguntas acad\u00e9micas usando el contenido de sus cursos
- Puedes mostrar progreso, agenda, y contenido del curso
- Puedes generar nuevo material de estudio (flashcards, quizzes)

REGLAS:
1. SIEMPRE usa las tools disponibles en lugar de inventar respuestas
2. Si no tienes info suficiente, pregunta al alumno qu\u00e9 curso o tema
3. Para preguntas acad\u00e9micas, SIEMPRE usa ask_academic_question (no inventes)
4. Cuando el alumno quiere estudiar, usa get_study_queue para iniciar sesi\u00f3n
5. submit_review SOLO durante sesi\u00f3n de flashcards activa
6. generate_content y generate_weekly_report son operaciones lentas \u2014 avisa al alumno que tomar\u00e1 unos segundos
7. Si ves un functionResponse con status:'queued', la operaci\u00f3n est\u00e1 EN PROCESO. No digas que ya se complet\u00f3.
8. Cuando recibes un functionResponse con formatted_text, usa ESE texto como base de tu respuesta (ya est\u00e1 optimizado para WhatsApp). Pod\u00e9s ajustarlo levemente pero no lo reescribas desde cero.

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

        // N8 FIX: Inject pre-formatted WhatsApp text so Gemini uses it directly
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
          ? new Date(startOfDay.getTime() + 7 * 24 * 60 * 60 * 1000)
          : new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

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
          const { data, error } = await db
            .from("keywords")
            .select("id, name, summaries(id, title)")
            .eq("section_id", args.section_id as string)
            .order("position", { ascending: true })
            .limit(30);
          if (error) throw new Error(`keywords: ${error.message}`);
          browseResult = { level: "keywords", items: data ?? [] };
        } else if (args.course_id) {
          const { data, error } = await db
            .from("sections")
            .select("id, name, position")
            .eq("course_id", args.course_id as string)
            .order("position", { ascending: true });
          if (error) throw new Error(`sections: ${error.message}`);
          browseResult = { level: "sections", items: data ?? [] };
        } else {
          const { data, error } = await db
            .from("course_members")
            .select("courses(id, name, code)")
            .eq("user_id", userId);
          if (error) throw new Error(`courses: ${error.message}`);
          browseResult = { level: "courses", items: data?.map((cm) => cm.courses) ?? [] };
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
          return { name, result: null, error: "No active flashcard session. Use get_study_queue first." };
        }

        const rating = args.rating as number;
        if (![1, 3, 4].includes(rating)) {
          return { name, result: null, error: `Invalid rating ${rating}. Must be 1, 3, or 4.` };
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

      case "ask_academic_question": {
        const question = args.question as string;
        let context = "";

        if (args.summary_id) {
          const { data, error: summaryErr } = await db
            .from("summaries")
            .select("title, content")
            .eq("id", args.summary_id as string)
            .single();

          if (summaryErr) {
            console.warn(`[WA-Tools] ask_academic_question: summary fetch failed: ${summaryErr.message}`);
          }
          if (data) {
            context = `Fuente: "${data.title}"\n${((data.content as string) || "").slice(0, 4000)}`;
          }
        } else {
          const { data: memberships } = await db
            .from("course_members")
            .select("course_id")
            .eq("user_id", userId)
            .limit(5);

          if (memberships?.length) {
            const courseIds = memberships.map((m) => m.course_id);

            const { data: summaries, error: sumErr } = await db
              .from("summaries")
              .select("title, content")
              .in("course_id", courseIds)
              .order("updated_at", { ascending: false })
              .limit(3);

            if (sumErr) {
              console.warn(
                `[WA-Tools] ask_academic_question: summaries by course_id failed: ${sumErr.message}. ` +
                `Falling back to no-context answer. Verify summaries table has course_id column.`,
              );
            }

            if (summaries?.length) {
              context = summaries
                .map((s) => `## ${s.title}\n${((s.content as string) || "").slice(0, 1500)}`)
                .join("\n\n");
            }
          }
        }

        const { text } = await generateText({
          prompt: context
            ? `Contexto del curso del alumno:\n${context}\n\n---\nPregunta: ${question}`
            : `Pregunta acad\u00e9mica: ${question}`,
          systemPrompt:
            "Eres un tutor universitario experto. Responde de forma clara y concisa en espa\u00f1ol. " +
            "M\u00e1ximo 800 caracteres (es para WhatsApp). Si tienes contexto del curso, bas\u00e1te en \u00e9l. " +
            "Si no tienes suficiente informaci\u00f3n, dilo honestamente.",
          temperature: 0.3,
          maxTokens: 512,
        });

        return { name, result: { answer: text } };
      }

      case "generate_content": {
        return {
          name,
          result: {
            status: "queued",
            message: "Generando contenido... Te aviso cuando est\u00e9 listo.",
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
            message: "Generando tu reporte semanal... Te lo env\u00edo en unos segundos.",
          },
          isAsync: true,
        };
      }

      case "handle_voice_message": {
        return {
          name,
          result: { message: "Los mensajes de voz estar\u00e1n disponibles pronto." },
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
