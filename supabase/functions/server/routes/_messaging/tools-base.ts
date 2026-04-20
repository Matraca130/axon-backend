/**
 * routes/_messaging/tools-base.ts — Shared Claude tool handlers
 *
 * Both Telegram and WhatsApp expose Claude tool_use endpoints whose
 * cases mostly share identical DB logic. This module extracts the
 * shared cases as standalone handler functions, parameterized by a
 * SharedToolsConfig adapter so each channel can inject its own
 * formatters, log prefix, channel-label copy, and minor field tweaks.
 *
 * Exported helpers (one per shared tool case):
 *   - handleGetStudyQueue
 *   - handleCheckProgress
 *   - handleGetSchedule
 *   - handleBrowseContent
 *   - handleAskAcademicQuestion
 *   - handleGenerateContent
 *   - handleGenerateWeeklyReport
 *   - handleSubmitReview
 *
 * Also exports:
 *   - ToolExecutionResult (used by both channels)
 *   - convertClaudeToolsToGemini (used by WhatsApp, useful for any channel)
 *   - GeminiFunctionDeclaration
 *
 * Channel-specific cases (update_agenda, get_keywords, get_summary for TG;
 * handle_voice_message for WA) stay in their respective tools.ts files.
 */

import { generateText, type ClaudeModel, type ClaudeTool } from "../../claude-ai.ts";
import { ragSearch } from "../../lib/rag-search.ts";

// ─── Types ───────────────────────────────────────────────

export interface ToolExecutionResult {
  name: string;
  result: unknown;
  error?: string;
  isAsync?: boolean;
}

/** Gemini function_declaration format (used by generateContent with tools) */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Pre-formatted text types used by shared handlers. */
export interface ProgressFormatterInput {
  total_topics: number;
  average_mastery: string;
  weak_topics: string[];
  details: Array<{ topic_name: string; course_name: string; mastery_level: number }>;
}

export interface ScheduleFormatterInput {
  period: string;
  tasks: Array<{ title: string; due_date: string; is_completed: boolean; description?: string }>;
  pending: number;
  completed: number;
}

export interface BrowseFormatterInput {
  level: "courses" | "sections" | "keywords" | "summaries";
  items: Array<Record<string, unknown>>;
}

/**
 * Per-channel configuration injected into shared tool handlers.
 *
 * The channel-label copy is used inside the system prompt for
 * ask_academic_question so the model knows where its reply will
 * render (Telegram vs WhatsApp).
 */
/**
 * Pre-built prompt strings for ask_academic_question. Both TG and WA
 * evolved slightly different copy (accent usage, verb conjugation,
 * channel name). We preserve them byte-for-byte via this hook instead
 * of hard-coding a single version.
 */
export interface AskQuestionPrompts {
  /** Prompt when RAG returned context for the question. */
  promptWithContext: (finalContext: string, question: string) => string;
  /** Prompt when no RAG context is available. */
  promptWithoutContext: (question: string) => string;
  /** System prompt builder, called with the list of source titles. */
  systemPrompt: (sources: string[]) => string;
}

export interface SharedToolsConfig {
  /** Short label used in log lines (e.g. "TG-RAG" or "WA-RAG"). */
  logPrefix: string;
  /** Summary content column name (TG uses content_markdown, WA uses content). */
  summaryContentField: "content_markdown" | "content";
  /** Optional Claude model override for ask_academic_question (TG uses "sonnet"). */
  askQuestionModel?: ClaudeModel;
  /** Channel-specific prompt strings for ask_academic_question. */
  askQuestionPrompts: AskQuestionPrompts;
  /** Message returned when a generate_content job is queued. */
  queuedContentMessage: string;
  /** Message returned when a generate_weekly_report job is queued. */
  queuedReportMessage: string;
  /** Channel formatters — injected so the base can return pre-formatted text. */
  formatProgressSummary: (data: ProgressFormatterInput) => string;
  formatScheduleSummary: (data: ScheduleFormatterInput) => string;
  formatBrowseContent: (data: BrowseFormatterInput) => string;
}

// ─── Claude → Gemini Tool Adapter ────────────────────────
// Claude uses `input_schema`; Gemini expects `parameters` in function_declarations.
// Without this conversion, Gemini ignores the schema and 100% of tool calls fail.

/**
 * Converts an array of Claude tool definitions to Gemini function_declarations.
 *
 * Claude format:  { name, description, input_schema: { type, properties, required } }
 * Gemini format:  { name, description, parameters:    { type, properties, required } }
 *
 * Only `name`, `description`, and the schema (renamed to `parameters`) are kept.
 * Any Claude-specific fields (e.g. `cache_control`) are stripped.
 */
export function convertClaudeToolsToGemini(
  claudeTools: ClaudeTool[],
): GeminiFunctionDeclaration[] {
  return claudeTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: tool.input_schema.type,
      properties: tool.input_schema.properties,
      ...(tool.input_schema.required && { required: tool.input_schema.required }),
    },
  }));
}

// ─── Shared Tool Handlers ────────────────────────────────

/**
 * Loose Supabase-client type so both TG and WA can pass in their own
 * admin client from db.ts without TypeScript friction caused by
 * differing generic parameters between the runtime import and the
 * declaration import from esm.sh.
 */
// deno-lint-ignore no-explicit-any
type AnyDb = any;

export async function handleGetStudyQueue(
  name: string,
  args: Record<string, unknown>,
  userId: string,
  db: AnyDb,
): Promise<ToolExecutionResult> {
  const { data, error } = await db.rpc("get_study_queue", {
    p_student_id: userId,
    p_course_id: (args.course_id as string) || null,
    p_limit: (args.limit as number) || 10,
    p_include_future: false,
  });
  if (error) throw new Error(`study_queue RPC: ${error.message}`);
  return { name, result: { cards: data, count: data?.length ?? 0 } };
}

export async function handleCheckProgress(
  name: string,
  args: Record<string, unknown>,
  userId: string,
  db: AnyDb,
  config: SharedToolsConfig,
): Promise<ToolExecutionResult> {
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
    ? (data!.reduce((sum: number, r: { mastery_level?: number }) => sum + (r.mastery_level ?? 0), 0) / total).toFixed(1)
    : "0";
  const weakTopics = data?.filter((r: { mastery_level?: number }) => (r.mastery_level ?? 0) < 0.5) ?? [];

  const resultData = {
    total_topics: total,
    average_mastery: avgMastery,
    weak_topics: weakTopics.slice(0, 5).map((t: { topic_name: string }) => t.topic_name),
    details: data?.slice(0, 10),
  };

  const formatted = config.formatProgressSummary(resultData as ProgressFormatterInput);

  return { name, result: { ...resultData, formatted_text: formatted } };
}

export async function handleGetSchedule(
  name: string,
  args: Record<string, unknown>,
  userId: string,
  db: AnyDb,
  config: SharedToolsConfig,
): Promise<ToolExecutionResult> {
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
    pending: data?.filter((t: { is_completed: boolean }) => !t.is_completed).length ?? 0,
    completed: data?.filter((t: { is_completed: boolean }) => t.is_completed).length ?? 0,
  };

  const formatted = config.formatScheduleSummary(resultData as ScheduleFormatterInput);

  return { name, result: { ...resultData, formatted_text: formatted } };
}

export async function handleBrowseContent(
  name: string,
  args: Record<string, unknown>,
  userId: string,
  db: AnyDb,
  config: SharedToolsConfig,
): Promise<ToolExecutionResult> {
  let browseResult: { level: string; items: unknown[] };

  if (args.section_id) {
    const { data: topics } = await db
      .from("topics")
      .select("id")
      .eq("section_id", args.section_id as string)
      .is("deleted_at", null);

    const topicIds = topics?.map((t: { id: string }) => t.id) ?? [];

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

    const instIds = memData?.map((m: { institution_id: string }) => m.institution_id) ?? [];
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

  const formatted = config.formatBrowseContent(browseResult as BrowseFormatterInput);

  return { name, result: { ...browseResult, formatted_text: formatted } };
}

export async function handleSubmitReview(
  name: string,
  args: Record<string, unknown>,
  _userId: string,
  sessionContext: Record<string, unknown>,
  db: AnyDb,
): Promise<ToolExecutionResult> {
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

export async function handleAskAcademicQuestion(
  name: string,
  args: Record<string, unknown>,
  userId: string,
  db: AnyDb,
  config: SharedToolsConfig,
): Promise<ToolExecutionResult> {
  const question = args.question as string;
  const summaryId = args.summary_id as string | undefined;

  const { context, sources, strategy } = await ragSearch(
    question,
    userId,
    summaryId,
  );

  console.warn(
    `[${config.logPrefix}] strategy=${strategy}, sources=${sources.length}, context=${context.length} chars`,
  );

  let finalContext = context;
  if (!finalContext && summaryId) {
    const { data } = await db
      .from("summaries")
      .select(`title, ${config.summaryContentField}`)
      .eq("id", summaryId)
      .single();
    if (data) {
      const body = (data as Record<string, unknown>)[config.summaryContentField] as string | undefined;
      finalContext = `Fuente: "${data.title}"\n${((body as string) || "").slice(0, 4000)}`;
    }
  }

  const { text } = await generateText({
    prompt: finalContext
      ? config.askQuestionPrompts.promptWithContext(finalContext, question)
      : config.askQuestionPrompts.promptWithoutContext(question),
    systemPrompt: config.askQuestionPrompts.systemPrompt(sources),
    ...(config.askQuestionModel ? { model: config.askQuestionModel } : {}),
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

export function handleGenerateContent(
  name: string,
  args: Record<string, unknown>,
  config: SharedToolsConfig,
): ToolExecutionResult {
  return {
    name,
    result: {
      status: "queued",
      message: config.queuedContentMessage,
      action: args.action,
      summary_id: args.summary_id,
    },
    isAsync: true,
  };
}

export function handleGenerateWeeklyReport(
  name: string,
  config: SharedToolsConfig,
): ToolExecutionResult {
  return {
    name,
    result: {
      status: "queued",
      message: config.queuedReportMessage,
    },
    isAsync: true,
  };
}
