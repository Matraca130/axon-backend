/**
 * routes/_messaging/formatter-base.ts — Shared message formatters
 *
 * Parameterized formatting logic used by:
 *   - routes/telegram/formatter.ts   (Telegram Markdown: *bold*, _italic_, ~strike~)
 *   - routes/whatsapp/formatter.ts   (plain text except *bold* for headers)
 *
 * Both Telegram and WhatsApp use `*text*` for SECTION HEADERS (course list
 * titles, "Tu progreso", etc.). They differ in INLINE decorations:
 *
 *   - TG decorates inline values with `*value*` (bold) and inline meta
 *     with `_meta_` (italic), and wraps completed tasks with `~title~`.
 *   - WA omits these inline decorations entirely (they render as raw
 *     punctuation in WhatsApp and hurt readability).
 *
 * The MarkdownStyle interface exposes four decorators so each channel
 * can opt in or out independently:
 *
 *   - heading      : wraps a section header (both channels bold it)
 *   - boldInline   : wraps an inline value (TG bold, WA identity)
 *   - italic       : wraps inline italic meta (TG italic, WA identity)
 *   - strike       : wraps strikethrough text (TG strike, WA identity)
 *
 * PUBLIC API STABILITY: The exact output strings of these formatters
 * are asserted by tests/unit/telegram-formatter.test.ts and
 * tests/unit/whatsapp-formatter.test.ts. Any change must preserve
 * byte-for-byte behavior when used with the adapters defined in
 * routes/telegram/formatter.ts and routes/whatsapp/formatter.ts.
 */

// ─── Types ───────────────────────────────────────────────

export interface MarkdownStyle {
  /** Section-header emphasis. Both TG and WA wrap with *...*. */
  heading: (text: string) => string;
  /** Inline bold for values. TG wraps with *...*; WA is identity. */
  boldInline: (text: string) => string;
  /** Inline italic. TG wraps with _..._; WA is identity. */
  italic: (text: string) => string;
  /** Strikethrough for completed items. TG wraps with ~...~; WA is identity. */
  strike: (text: string) => string;
}

export interface FormatterConfig {
  /** Max chars per message. Both TG and WA use 4096. */
  maxChars: number;
  style: MarkdownStyle;
}

export interface StudyQueueCard {
  id: string;
  front_text?: string;
  keyword_name?: string;
  course_name?: string;
  due_at?: string;
}

export interface ProgressData {
  total_topics: number;
  average_mastery: string;
  weak_topics: string[];
  details?: Array<{
    topic_name: string;
    course_name: string;
    mastery_level: number;
  }>;
}

export interface ScheduleData {
  period: string;
  tasks: Array<{
    title: string;
    due_date: string;
    is_completed: boolean;
    description?: string;
  }>;
  pending: number;
  completed: number;
}

export interface BrowseResult {
  level: "courses" | "sections" | "keywords" | "summaries";
  items: Array<Record<string, unknown>>;
}

export interface KeywordData {
  name: string;
  definition?: string;
  connections?: Array<{ name: string; relationship?: string }>;
}

// ─── Helpers ─────────────────────────────────────────────

/** Identity decorator — used by channels that don't support the markup. */
export const identity = (s: string) => s;

/** Shared truncation logic. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars - 10);
  const lastNewline = truncated.lastIndexOf("\n");

  if (lastNewline > maxChars * 0.7) {
    return truncated.slice(0, lastNewline) + "\n\u2026";
  }

  return truncated + "\u2026";
}

/** Shared short-date helper (Spanish day/month abbreviations). */
export function formatShortDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    const days = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    const months = [
      "Ene", "Feb", "Mar", "Abr", "May", "Jun",
      "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
    ];
    return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
  } catch {
    return isoDate.slice(0, 10);
  }
}

/** Shared mastery bar emoji helper. */
export function masteryBar(level: number): string {
  if (level >= 0.8) return "\ud83d\udfe2";
  if (level >= 0.5) return "\ud83d\udfe1";
  if (level >= 0.3) return "\ud83d\udfe0";
  return "\ud83d\udd34";
}

// ─── Flashcard Queue Formatter ───────────────────────────

export function formatFlashcardSummary(
  cards: StudyQueueCard[],
  count: number,
  cfg: FormatterConfig,
): string {
  const { style, maxChars } = cfg;

  if (!cards || count === 0) {
    return "\ud83c\udf89 ¡No tienes flashcards pendientes! Estás al día.";
  }

  const lines: string[] = [
    `\ud83d\udcda ${style.heading(`${count} flashcards pendientes`)}`,
    "",
  ];

  const byCourse = new Map<string, StudyQueueCard[]>();
  for (const card of cards.slice(0, 15)) {
    const course = card.course_name || "Sin curso";
    if (!byCourse.has(course)) byCourse.set(course, []);
    byCourse.get(course)!.push(card);
  }

  for (const [course, courseCards] of byCourse) {
    lines.push(`\ud83d\udcd6 ${style.boldInline(course)} (${courseCards.length})`);
    for (const card of courseCards.slice(0, 5)) {
      const preview = (card.front_text || card.keyword_name || "Flashcard").slice(0, 60);
      lines.push(`  \u2022 ${preview}`);
    }
    if (courseCards.length > 5) {
      lines.push(`  \u2026 y ${courseCards.length - 5} más`);
    }
    lines.push("");
  }

  if (count > 15) {
    lines.push(style.italic(`(mostrando 15 de ${count})`));
  }

  return truncate(lines.join("\n"), maxChars);
}

// ─── Progress Formatter ──────────────────────────────────

export function formatProgressSummary(
  progress: ProgressData,
  cfg: FormatterConfig,
): string {
  const { style, maxChars } = cfg;

  const lines: string[] = [
    `\ud83d\udcca ${style.heading("Tu progreso")}`,
    "",
    `\ud83c\udfaf Mastery promedio: ${style.boldInline(progress.average_mastery)}`,
    `\ud83d\udcd1 Topics totales: ${progress.total_topics}`,
  ];

  if (progress.weak_topics?.length > 0) {
    lines.push("");
    lines.push(`\u26a0\ufe0f ${style.heading("Topics débiles:")}`);
    for (const topic of progress.weak_topics.slice(0, 5)) {
      lines.push(`  \u2022 ${topic}`);
    }
  }

  if (progress.details?.length) {
    lines.push("");
    lines.push(style.heading("Detalle por topic:"));
    for (const d of progress.details.slice(0, 8)) {
      const bar = masteryBar(d.mastery_level);
      lines.push(`${bar} ${d.topic_name} ${style.italic(`(${d.course_name})`)}`);
    }
  }

  return truncate(lines.join("\n"), maxChars);
}

// ─── Schedule / Agenda Formatter ─────────────────────────

export function formatScheduleSummary(
  schedule: ScheduleData,
  cfg: FormatterConfig,
): string {
  const { style, maxChars } = cfg;
  const periodLabel = schedule.period === "week" ? "esta semana" : "hoy";

  if (!schedule.tasks?.length) {
    return `\ud83d\udcc5 No tienes tareas para ${periodLabel}. ¡Tiempo libre! \ud83c\udf89`;
  }

  const lines: string[] = [
    `\ud83d\udcc5 ${style.heading(`Agenda ${periodLabel}`)}`,
    `\u2705 ${schedule.completed} completadas \u2022 \u23f3 ${schedule.pending} pendientes`,
    "",
  ];

  for (const task of schedule.tasks.slice(0, 10)) {
    const icon = task.is_completed ? "\u2705" : "\u23f3";
    const date = formatShortDate(task.due_date);
    const title = task.is_completed ? style.strike(task.title) : task.title;
    lines.push(`${icon} ${title} \u2014 ${date}`);
  }

  if (schedule.tasks.length > 10) {
    lines.push(`\n\u2026 y ${schedule.tasks.length - 10} más`);
  }

  return truncate(lines.join("\n"), maxChars);
}

// ─── Content Browser Formatter ───────────────────────────

export function formatBrowseContent(
  result: BrowseResult,
  cfg: FormatterConfig,
): string {
  const { style, maxChars } = cfg;
  const items = result.items || [];

  if (items.length === 0) {
    return "No se encontró contenido. \ud83d\ude14";
  }

  const lines: string[] = [];

  switch (result.level) {
    case "courses":
      lines.push(`\ud83c\udfeb ${style.heading("Tus cursos:")}\n`);
      for (const item of items.slice(0, 10)) {
        const name = (item as { name?: string }).name || "Sin nombre";
        const code = (item as { code?: string }).code || "";
        lines.push(`\ud83d\udcd5 ${style.boldInline(name)}${code ? ` (${code})` : ""}`);
      }
      break;

    case "sections":
      lines.push(`\ud83d\udcc2 ${style.heading("Secciones:")}\n`);
      for (const item of items.slice(0, 15)) {
        const name = (item as { name?: string }).name || "Sin nombre";
        lines.push(`  \u2022 ${name}`);
      }
      break;

    case "keywords":
    case "summaries":
      lines.push(`\ud83d\udd11 ${style.heading("Temas:")}\n`);
      for (const item of items.slice(0, 15)) {
        const name = (item as { name?: string; title?: string }).name ||
          (item as { title?: string }).title || "Sin nombre";
        lines.push(`  \u2022 ${name}`);
      }
      break;
  }

  return truncate(lines.join("\n"), maxChars);
}

// ─── Keyword Detail Formatter ────────────────────────────

export function formatKeywordDetail(
  keyword: KeywordData,
  cfg: FormatterConfig,
): string {
  const { style, maxChars } = cfg;

  const lines: string[] = [
    `\ud83d\udd11 ${style.heading(keyword.name)}`,
    "",
  ];

  if (keyword.definition) {
    lines.push(keyword.definition.slice(0, 500));
    lines.push("");
  }

  if (keyword.connections?.length) {
    lines.push(`\ud83d\udd17 ${style.heading("Conexiones:")}`);
    for (const conn of keyword.connections.slice(0, 8)) {
      const rel = conn.relationship ? ` ${style.italic(`(${conn.relationship})`)}` : "";
      lines.push(`  \u2022 ${conn.name}${rel}`);
    }
  }

  return truncate(lines.join("\n"), maxChars);
}

// ─── Summary Formatter ───────────────────────────────────

export function formatSummaryPreview(
  title: string,
  content: string,
  cfg: FormatterConfig,
  wordCount?: number,
): string {
  const { style, maxChars } = cfg;

  const lines: string[] = [
    `\ud83d\udcdd ${style.heading(title)}`,
    "",
  ];

  if (wordCount) {
    lines.push(style.italic(`${wordCount} palabras`));
    lines.push("");
  }

  const preview = content.slice(0, 500);
  lines.push(preview);
  if (content.length > 500) {
    lines.push(`\n\u2026 ${style.italic("(resumen truncado, abrí la app para ver completo)")}`);
  }

  return truncate(lines.join("\n"), maxChars);
}
