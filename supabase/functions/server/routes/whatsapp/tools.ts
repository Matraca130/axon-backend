/**
 * routes/whatsapp/tools.ts — Gemini Function Calling definitions + executor
 *
 * 9 tools available to the WhatsApp chatbot.
 *
 * Phase 3 changes:
 *   S14: handle_voice_message now uses Gemini multimodal STT
 *   S15: ask_academic_question uses full RAG pipeline
 *        (embeddings + hybrid search + re-ranking)
 *
 * N8 FIX: Integrated formatters for check_progress, get_schedule,
 *         browse_content. Gemini gets pre-formatted WhatsApp text.
 *
 * W3-01 FIX: ragSearch() RPC params corrected to match chat.ts
 * W3-02 FIX: course_members → memberships (table doesn't exist)
 * W3-03 FIX: institution_id resolution added (cross-tenant data leak)
 * W3-07 FIX: browse_content course listing via memberships
 */

import { getAdminClient } from "../../db.ts";
import { generateText } from "../../gemini.ts";
import {
  selectStrategy,
  executeRetrievalEmbedding,
  rerankWithGemini,
  mergeSearchResults,
  type MatchedChunk,
} from "../../retrieval-strategies.ts";
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
      "Si el alumno dice 'qué debo estudiar', 'tengo que repasar', 'flashcards pendientes', usa esta tool. " +
      "Inicia el modo Session Mode (revisión interactiva de flashcards).",
    parameters: {
      type: "object",
      properties: {
        course_id: { type: "string", description: "UUID del curso (opcional)" },
        limit: { type: "integer", description: "Máximo flashcards (default: 10)" },
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
    parameters: {
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
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "week"], description: "hoy o semana" },
      },
    },
  },
  {
    name: "submit_review",
    description:
      "Registra calificación de flashcard. SOLO durante Session Mode. Rating: 1=Fail, 3=Good, 4=Easy.",
    parameters: {
      type: "object",
      properties: {
        flashcard_id: { type: "string", description: "UUID de la flashcard" },
        rating: { type: "integer", enum: [1, 3, 4], description: "1=Fail, 3=Good, 4=Easy" },
      },
      required: ["flashcard_id", "rating"],
    },
  },
  {
    name: "browse_content",
    description: "Navega el árbol de contenido: cursos, secciones, keywords.",
    parameters: {
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
    parameters: {
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
    description: "Genera reporte semanal. Operación LENTA (~15s), se encola.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "handle_voice_message",
    description:
      "Procesa un mensaje de voz: transcribe y responde. " +
      "Se activa automáticamente cuando el alumno envía un audio.",
    parameters: {
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
- Español informal (tuteo), con emojis moderados
- Respuestas CORTAS: máximo 900 caracteres
- Si necesitas dar info larga, usa bullets

CAPACIDADES:
- Flashcards pendientes + sesiones de repaso interactivas
- Preguntas académicas con RAG (búsqueda semántica en contenido del curso)
- Progreso, agenda, contenido del curso
- Generar material de estudio (flashcards, quizzes)
- Transcribir y responder mensajes de voz

REGLAS:
1. SIEMPRE usa las tools en lugar de inventar respuestas
2. Si no tienes info suficiente, pregunta al alumno qué curso o tema
3. Para preguntas académicas, SIEMPRE usa ask_academic_question
4. submit_review SOLO durante sesión de flashcards activa
5. generate_content y generate_weekly_report son lentas — avisa al alumno
6. Si ves functionResponse con status:'queued', la operación está EN PROCESO
7. Cuando recibes un functionResponse con formatted_text, usa ESE texto como base de tu respuesta (ya está optimizado para WhatsApp). Podés ajustarlo levemente pero no lo reescribas desde cero.

CONTEXTO DEL ALUMNO:
{STUDENT_CONTEXT}
`;

// ─── S15: RAG Search Helper ─────────────────────────────
// W3-01 FIX: All RPC params corrected to match rag_hybrid_search signature.
// W3-02 FIX: course_members → memberships (course_members table doesn't exist).
// W3-03 FIX: institution_id resolved and passed to RPC (prevents cross-tenant data leak).
// W3-04 NOTE: getAdminClient() was already used — the broken params were the real blocker.

const RAG_MAX_CONTEXT_CHARS = 4000;
const RAG_TOP_K = 5;

async function ragSearch(
  question: string,
  userId: string,
  summaryId?: string,
): Promise<{ context: string; sources: string[]; strategy: string }> {
  const db = getAdminClient();

  try {
    // W3-02 FIX: Resolve institution via memberships (was course_members which doesn't exist)
    // W3-03 FIX: We need institution_id for tenant-scoped search
    let institutionId: string | null = null;

    if (summaryId) {
      // Resolve institution from the summary
      const { data: instId } = await db.rpc("resolve_parent_institution", {
        p_table: "summaries",
        p_id: summaryId,
      });
      institutionId = instId as string | null;
    }

    if (!institutionId) {
      // Resolve from user's active membership
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
      // W3-01 FIX: Correct RPC parameter names to match chat.ts / rag_hybrid_search signature
      // OLD (broken): p_embedding, missing p_query_text, missing p_institution_id
      // NEW (correct): p_query_embedding, p_query_text, p_institution_id, p_similarity_threshold
      const { data, error } = await db.rpc("rag_hybrid_search", {
        p_query_embedding: JSON.stringify(embedding),   // FIX: was p_embedding (wrong param name)
        p_query_text: question,                          // FIX: was missing entirely
        p_institution_id: institutionId,                 // FIX: was missing (CROSS-TENANT LEAK!)
        p_match_count: RAG_TOP_K * 2,
        p_similarity_threshold: 0.3,                     // FIX: was missing
        p_summary_id: summaryId ?? null,                 // Pass null when not scoped
      });

      if (error) {
        console.warn(`[WA-RAG] hybrid search failed: ${error.message}`);
        return [] as MatchedChunk[];
      }
      return (data ?? []) as MatchedChunk[];
    });

    const resultSets = await Promise.all(searchPromises);
    let merged = mergeSearchResults(resultSets);

    if (merged.length === 0) {
      return { context: "", sources: [], strategy: `${strategy}_empty` };
    }

    merged = await rerankWithGemini(question, merged, RAG_TOP_K);

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

    return {
      context: contextParts.join("\n\n"),
      sources,
      strategy,
    };
  } catch (e) {
    console.error(`[WA-RAG] Pipeline failed: ${(e as Error).message}`);
    return { context: "", sources: [], strategy: "error" };
  }
}

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
          // W3-08 NOTE: keywords don't have section_id directly.
          // They link via summary_id → topics → sections.
          // Using a join through summaries → topics for correct traversal.
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
          // W3-07 FIX: course_members doesn't exist → use memberships + courses
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

      // S15: Full RAG pipeline
      case "ask_academic_question": {
        const question = args.question as string;
        const summaryId = args.summary_id as string | undefined;

        const { context, sources, strategy } = await ragSearch(
          question,
          userId,
          summaryId,
        );

        console.log(
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
            ? `Contexto del curso (encontrado por búsqueda semántica):\n${finalContext}\n\n---\nPregunta: ${question}`
            : `Pregunta académica (sin contexto disponible del curso): ${question}`,
          systemPrompt:
            "Eres un tutor universitario experto. Respondé de forma clara y concisa en español. " +
            "Máximo 800 caracteres (es para WhatsApp). Si tenés contexto del curso, bastate en él. " +
            "Si no tenés suficiente información, decilo honestamente. " +
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

      case "handle_voice_message": {
        return {
          name,
          result: {
            message: "La transcripción de voz se procesa automáticamente. " +
              "El texto transcrito se envía como mensaje normal.",
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
