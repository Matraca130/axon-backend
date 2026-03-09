/**
 * routes/whatsapp/tools.ts — Gemini Function Calling definitions + executor
 *
 * 9 tools available to the WhatsApp chatbot. Each maps to existing
 * Axon backend functionality via direct DB queries or internal HTTP.
 *
 * ARCHITECTURE DECISION (AUDIT F4):
 * Existing route handlers (study-queue, reviews, progress) are module-private
 * and do NOT export their business logic. Instead of refactoring ~10 files,
 * we use direct DB queries/RPCs for 6 tools and internal HTTP for 2 tools
 * whose logic is too complex to extract (RAG chat: 21KB, generate-smart).
 *
 * A3 FIX: ask_academic_question now uses direct generateText() + summary
 * context instead of internal HTTP. The service_role_key JWT has no 'sub'
 * claim, so authenticate() in chat.ts always returned 401.
 *
 * @see AUDIT F4: Direct DB queries (handlers are module-private)
 * @see AUDIT F5: Ghost session for submit_review
 * @see AUDIT F9: Internal HTTP for generate_content (deferred to pgmq)
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js";
import { getAdminClient } from "../../db.ts";
import { generateText } from "../../gemini.ts";

// ─── Types ───────────────────────────────────────────────

export interface ToolExecutionResult {
  name: string;
  result: unknown;
  error?: string;
  /** If true, handler should enqueue and respond "Generando..." */
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
      "Si el alumno dice 'qué debo estudiar', 'tengo que repasar', 'flashcards pendientes', usa esta tool. " +
      "Inicia el modo Session Mode (revisión interactiva de flashcards).",
    parameters: {
      type: "object",
      properties: {
        course_id: {
          type: "string",
          description: "UUID del curso (opcional, filtra por curso específico)",
        },
        limit: {
          type: "integer",
          description: "Número máximo de flashcards a obtener (default: 10)",
        },
      },
    },
  },
  {
    name: "ask_academic_question",
    description:
      "Responde una pregunta académica usando RAG (Retrieval Augmented Generation) " +
      "sobre el contenido del curso del alumno. Busca en resúmenes, PDFs, y notas. " +
      "Usa esta tool cuando el alumno hace preguntas como 'explicáme mitosis', " +
      "'qué es la ley de Ohm', 'cómo se calcula el PIB'.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "La pregunta académica del alumno",
        },
        summary_id: {
          type: "string",
          description: "UUID del resumen específico a consultar (opcional)",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "check_progress",
    description:
      "Muestra el progreso del alumno: mastery por topic, porcentaje de avance, " +
      "topics débiles. Usa cuando el alumno pregunta 'cómo voy', 'mi progreso', 'qué me falta'.",
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
      "Usa cuando el alumno dice 'qué tengo para hoy', 'mi agenda', 'tareas de la semana'.",
    parameters: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["today", "week"],
          description: "Período a consultar: hoy o esta semana",
        },
      },
    },
  },
  {
    name: "submit_review",
    description:
      "Registra la calificación de una flashcard durante una sesión de revisión. " +
      "SOLO usar durante Session Mode (flashcard_review). " +
      "Rating: 1=Fail (no la sabía), 3=Good (la sabía con esfuerzo), 4=Easy (la sabía instantáneamente).",
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
      "Navega el árbol de contenido del curso: secciones, keywords, resúmenes disponibles. " +
      "Usa cuando el alumno dice 'qué temas hay', 'ver contenido', 'explorar curso'.",
    parameters: {
      type: "object",
      properties: {
        course_id: {
          type: "string",
          description: "UUID del curso (opcional)",
        },
        section_id: {
          type: "string",
          description: "UUID de la sección para ver sub-items (opcional)",
        },
      },
    },
  },
  {
    name: "generate_content",
    description:
      "Genera flashcards o preguntas de quiz sobre un tema específico usando IA adaptativa. " +
      "Operación LENTA (~10s). Se encolará y el alumno recibirá una notificación cuando esté lista.",
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
      "Genera un reporte semanal de estudio con estadísticas, logros, y recomendaciones. " +
      "Operación LENTA (~15s). Se encolará y el alumno recibirá el reporte cuando esté listo. " +
      "Usa cuando el alumno dice 'mi reporte', 'cómo fue mi semana', 'reporte semanal'.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "handle_voice_message",
    description:
      "Procesa un mensaje de voz del alumno: transcribe el audio y responde a la pregunta. " +
      "Se activa automáticamente cuando el alumno envía un audio.",
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

// ─── System Prompt ────────────────────────────────────────

export const WHATSAPP_SYSTEM_PROMPT = `Eres Axon, un asistente de estudio inteligente que ayuda a estudiantes universitarios por WhatsApp.

PERSONALIDAD:
- Amigable, motivador, y directo
- Español informal (tuteo), con emojis moderados (📚 ✅ 💪 🎯, no excesivos)
- Respuestas CORTAS: máximo 900 caracteres (WhatsApp se lee en móvil)
- Si necesitas dar info larga, divide en múltiples mensajes o usa bullets

CAPACIDADES:
- Puedes consultar las flashcards pendientes del alumno y iniciar sesiones de repaso
- Puedes responder preguntas académicas usando el contenido de sus cursos
- Puedes mostrar progreso, agenda, y contenido del curso
- Puedes generar nuevo material de estudio (flashcards, quizzes)

REGLAS:
1. SIEMPRE usa las tools disponibles en lugar de inventar respuestas
2. Si no tienes info suficiente, pregunta al alumno qué curso o tema
3. Para preguntas académicas, SIEMPRE usa ask_academic_question (no inventes)
4. Cuando el alumno quiere estudiar, usa get_study_queue para iniciar sesión
5. submit_review SOLO durante sesión de flashcards activa
6. generate_content y generate_weekly_report son operaciones lentas — avisa al alumno que tomará unos segundos
7. Si ves un functionResponse con status:'queued', la operación está EN PROCESO. No digas que ya se completó.

CONTEXTO DEL ALUMNO:
{STUDENT_CONTEXT}
`;

// ─── Tool Executor (AUDIT F4: Direct DB queries) ───────────

/**
 * Execute a tool call from Gemini.
 * Uses direct DB queries/RPCs for most tools (AUDIT F4).
 * A3 FIX: ask_academic_question uses direct generateText() instead of
 * internal HTTP (service_role_key JWT has no 'sub' claim).
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  userId: string,
  sessionContext: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const db = getAdminClient();

  try {
    switch (name) {
      // ─── Direct DB/RPC tools (6) ───────────────────

      case "get_study_queue": {
        // RPC exists: migration 20260303_03_study_queue_rpc.sql
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

        // Compute summary stats
        const total = data?.length ?? 0;
        const avgMastery = total > 0
          ? (data!.reduce((sum, r) => sum + (r.mastery_level ?? 0), 0) / total).toFixed(1)
          : "0";
        const weakTopics = data?.filter((r) => (r.mastery_level ?? 0) < 0.5) ?? [];

        return {
          name,
          result: {
            total_topics: total,
            average_mastery: avgMastery,
            weak_topics: weakTopics.slice(0, 5).map((t) => t.topic_name),
            details: data?.slice(0, 10),
          },
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

        return {
          name,
          result: {
            period,
            tasks: data ?? [],
            pending: data?.filter((t) => !t.is_completed).length ?? 0,
            completed: data?.filter((t) => t.is_completed).length ?? 0,
          },
        };
      }

      case "browse_content": {
        if (args.section_id) {
          // Get keywords/summaries for a specific section
          const { data, error } = await db
            .from("keywords")
            .select("id, name, summaries(id, title)")
            .eq("section_id", args.section_id as string)
            .order("position", { ascending: true })
            .limit(30);
          if (error) throw new Error(`keywords: ${error.message}`);
          return { name, result: { level: "keywords", items: data } };
        }

        if (args.course_id) {
          // Get sections for a course
          const { data, error } = await db
            .from("sections")
            .select("id, name, position")
            .eq("course_id", args.course_id as string)
            .order("position", { ascending: true });
          if (error) throw new Error(`sections: ${error.message}`);
          return { name, result: { level: "sections", items: data } };
        }

        // Get all courses for the user
        const { data, error } = await db
          .from("course_members")
          .select("courses(id, name, code)")
          .eq("user_id", userId);
        if (error) throw new Error(`courses: ${error.message}`);
        return { name, result: { level: "courses", items: data?.map((cm) => cm.courses) } };
      }

      case "submit_review": {
        // AUDIT F5: Use ghost_session_id from session context
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

      // ─── Academic Question (A3 FIX: direct instead of internal HTTP) ──

      case "ask_academic_question": {
        // A3 FIX: service_role_key JWT has no 'sub' claim, so internal HTTP
        // to /ai/rag-chat always returned 401. Instead, we do a simplified
        // RAG: fetch summary content + call generateText() directly.
        // Full hybrid search (embeddings + FTS) deferred to Phase 2.

        const question = args.question as string;
        let context = "";

        if (args.summary_id) {
          // Specific summary requested
          const { data } = await db
            .from("summaries")
            .select("title, content")
            .eq("id", args.summary_id as string)
            .single();
          if (data) {
            context = `Fuente: "${data.title}"\n${((data.content as string) || "").slice(0, 4000)}`;
          }
        } else {
          // No summary_id: fetch recent summaries from student's courses
          const { data: memberships } = await db
            .from("course_members")
            .select("course_id")
            .eq("user_id", userId)
            .limit(5);

          if (memberships?.length) {
            const courseIds = memberships.map((m) => m.course_id);
            const { data: summaries } = await db
              .from("summaries")
              .select("title, content")
              .in("course_id", courseIds)
              .order("updated_at", { ascending: false })
              .limit(3);

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
            : `Pregunta académica: ${question}`,
          systemPrompt:
            "Eres un tutor universitario experto. Responde de forma clara y concisa en español. " +
            "Máximo 800 caracteres (es para WhatsApp). Si tienes contexto del curso, basáte en él. " +
            "Si no tienes suficiente información, dilo honestamente.",
          temperature: 0.3,
          maxTokens: 512,
        });

        return { name, result: { answer: text } };
      }

      // ─── Async tools (2) — enqueue and respond immediately ────

      case "generate_content": {
        return {
          name,
          result: {
            status: "queued",
            message: "Generando contenido... Te aviso cuando esté listo.",
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
            message: "Generando tu reporte semanal... Te lo envío en unos segundos.",
          },
          isAsync: true,
        };
      }

      // ─── Voice (delegated to S14) ───────────────────────

      case "handle_voice_message": {
        // TODO S14: Implement voice transcription
        return {
          name,
          result: { message: "Los mensajes de voz estarán disponibles pronto." },
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
