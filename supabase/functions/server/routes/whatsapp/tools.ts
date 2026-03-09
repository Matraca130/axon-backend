/**
 * routes/whatsapp/tools.ts — Gemini Function Calling definitions + executor
 *
 * 9 tools available to the WhatsApp chatbot.
 *
 * Phase 3 changes:
 *   S14: handle_voice_message now uses Gemini multimodal STT
 *   S15: ask_academic_question uses full RAG pipeline
 *        (embeddings + hybrid search + re-ranking)
 */

import { getAdminClient } from "../../db.ts";
import { generateText } from "../../gemini.ts";
import { generateEmbedding, EMBEDDING_DIMENSIONS } from "../../openai-embeddings.ts";
import {
  selectStrategy,
  executeRetrievalEmbedding,
  rerankWithGemini,
  mergeSearchResults,
  type MatchedChunk,
} from "../../retrieval-strategies.ts";

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
        course_id: { type: "string", description: "UUID del curso (opcional)" },
        limit: { type: "integer", description: "M\u00e1ximo flashcards (default: 10)" },
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
        question: { type: "string", description: "La pregunta acad\u00e9mica del alumno" },
        summary_id: { type: "string", description: "UUID del resumen espec\u00edfico (opcional)" },
      },
      required: ["question"],
    },
  },
  {
    name: "check_progress",
    description:
      "Muestra el progreso del alumno: mastery por topic, porcentaje de avance, topics d\u00e9biles.",
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
      "Registra calificaci\u00f3n de flashcard. SOLO durante Session Mode. Rating: 1=Fail, 3=Good, 4=Easy.",
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
    description: "Navega el \u00e1rbol de contenido: cursos, secciones, keywords.",
    parameters: {
      type: "object",
      properties: {
        course_id: { type: "string", description: "UUID del curso (opcional)" },
        section_id: { type: "string", description: "UUID de la secci\u00f3n (opcional)" },
      },
    },
  },
  {
    name: "generate_content",
    description:
      "Genera flashcards o quiz. Operaci\u00f3n LENTA (~10s), se encola.",
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
    description: "Genera reporte semanal. Operaci\u00f3n LENTA (~15s), se encola.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "handle_voice_message",
    description:
      "Procesa un mensaje de voz: transcribe y responde. " +
      "Se activa autom\u00e1ticamente cuando el alumno env\u00eda un audio.",
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

// ─── System Prompt ───────────────────────────────────────

export const WHATSAPP_SYSTEM_PROMPT = `Eres Axon, un asistente de estudio inteligente que ayuda a estudiantes universitarios por WhatsApp.

PERSONALIDAD:
- Amigable, motivador, y directo
- Espa\u00f1ol informal (tuteo), con emojis moderados
- Respuestas CORTAS: m\u00e1ximo 900 caracteres
- Si necesitas dar info larga, usa bullets

CAPACIDADES:
- Flashcards pendientes + sesiones de repaso interactivas
- Preguntas acad\u00e9micas con RAG (b\u00fasqueda sem\u00e1ntica en contenido del curso)
- Progreso, agenda, contenido del curso
- Generar material de estudio (flashcards, quizzes)
- Transcribir y responder mensajes de voz

REGLAS:
1. SIEMPRE usa las tools en lugar de inventar respuestas
2. Si no tienes info suficiente, pregunta al alumno qu\u00e9 curso o tema
3. Para preguntas acad\u00e9micas, SIEMPRE usa ask_academic_question
4. submit_review SOLO durante sesi\u00f3n de flashcards activa
5. generate_content y generate_weekly_report son lentas \u2014 avisa al alumno
6. Si ves functionResponse con status:'queued', la operaci\u00f3n est\u00e1 EN PROCESO

CONTEXTO DEL ALUMNO:
{STUDENT_CONTEXT}
`;

// ─── S15: RAG Search Helper ─────────────────────────────

const RAG_MAX_CONTEXT_CHARS = 4000;
const RAG_TOP_K = 5;

/**
 * S15: Full RAG pipeline for WhatsApp ask_academic_question.
 *
 * Pipeline:
 *   1. selectStrategy() picks standard/multi_query/hyde
 *   2. executeRetrievalEmbedding() generates embeddings
 *   3. For each embedding, call rag_hybrid_search RPC
 *   4. mergeSearchResults() deduplicates
 *   5. rerankWithGemini() re-ranks by relevance
 *   6. Build context string from top chunks
 *
 * Returns formatted context string, or "" if no results.
 */
async function ragSearch(
  question: string,
  userId: string,
  summaryId?: string,
): Promise<{ context: string; sources: string[]; strategy: string }> {
  const db = getAdminClient();

  try {
    // Get user's course IDs for scoping
    const { data: memberships } = await db
      .from("course_members")
      .select("course_id")
      .eq("user_id", userId)
      .limit(10);

    const courseIds = memberships?.map((m) => m.course_id) ?? [];
    if (courseIds.length === 0 && !summaryId) {
      return { context: "", sources: [], strategy: "no_courses" };
    }

    // 1. Select retrieval strategy
    const strategy = summaryId ? "standard" : selectStrategy(question, summaryId ?? null, 0);

    // 2. Generate embeddings
    const { embeddings } = await executeRetrievalEmbedding(strategy, question);

    // 3. Run hybrid search for each embedding
    const searchPromises = embeddings.map(async ({ embedding }) => {
      const { data, error } = await db.rpc("rag_hybrid_search", {
        p_embedding: `[${embedding.join(",")}]`,
        p_match_count: RAG_TOP_K * 2, // fetch extra for re-ranking
        p_full_text_weight: 0.3,
        p_semantic_weight: 0.7,
        p_rrf_k: 60,
        ...(summaryId ? { p_summary_id: summaryId } : {}),
      });

      if (error) {
        console.warn(`[WA-RAG] hybrid search failed: ${error.message}`);
        return [] as MatchedChunk[];
      }
      return (data ?? []) as MatchedChunk[];
    });

    const resultSets = await Promise.all(searchPromises);

    // 4. Merge results from all embeddings
    let merged = mergeSearchResults(resultSets);

    if (merged.length === 0) {
      return { context: "", sources: [], strategy: `${strategy}_empty` };
    }

    // 5. Re-rank with Gemini
    merged = await rerankWithGemini(question, merged, RAG_TOP_K);

    // 6. Build context string
    let contextChars = 0;
    const contextParts: string[] = [];
    const sources: string[] = [];

    for (const chunk of merged) {
      if (contextChars + chunk.content.length > RAG_MAX_CONTEXT_CHARS) {
        // Add partial if we have space
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
          const { data, error } = await db
            .from("sections")
            .select("id, name, position")
            .eq("course_id", args.course_id as string)
            .order("position", { ascending: true });
          if (error) throw new Error(`sections: ${error.message}`);
          return { name, result: { level: "sections", items: data } };
        }
        const { data, error } = await db
          .from("course_members")
          .select("courses(id, name, code)")
          .eq("user_id", userId);
        if (error) throw new Error(`courses: ${error.message}`);
        return { name, result: { level: "courses", items: data?.map((cm) => cm.courses) } };
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

        // S15: Use full RAG pipeline (embeddings + hybrid search + reranking)
        const { context, sources, strategy } = await ragSearch(
          question,
          userId,
          summaryId,
        );

        console.log(
          `[WA-RAG] strategy=${strategy}, sources=${sources.length}, ` +
          `context=${context.length} chars`,
        );

        // Fallback: if RAG returned nothing, try direct summary fetch
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
            ? `Contexto del curso (encontrado por b\u00fasqueda sem\u00e1ntica):\n${finalContext}\n\n---\nPregunta: ${question}`
            : `Pregunta acad\u00e9mica (sin contexto disponible del curso): ${question}`,
          systemPrompt:
            "Eres un tutor universitario experto. Respond\u00e9 de forma clara y concisa en espa\u00f1ol. " +
            "M\u00e1ximo 800 caracteres (es para WhatsApp). Si ten\u00e9s contexto del curso, bastate en \u00e9l. " +
            "Si no ten\u00e9s suficiente informaci\u00f3n, decilo honestamente. " +
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

      // S14: Voice message handling (transcription done in handler.ts now)
      case "handle_voice_message": {
        return {
          name,
          result: {
            message: "La transcripci\u00f3n de voz se procesa autom\u00e1ticamente. " +
              "El texto transcrito se env\u00eda como mensaje normal.",
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
