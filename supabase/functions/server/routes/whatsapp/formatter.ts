/**
 * routes/whatsapp/formatter.ts — WhatsApp message formatting (S11)
 *
 * Converts raw DB/tool results into compact, emoji-enhanced text
 * optimized for WhatsApp mobile reading.
 *
 * Design constraints:
 *   - Max 4096 chars per WhatsApp text message
 *   - Use emojis sparingly but consistently
 *   - Use bullets and line breaks for structure
 *   - Spanish language
 *
 * C7 FIX: formatFlashcardSummary now imported by handler.ts for
 * get_study_queue fallback path.
 * C9 FIX: Removed unused TARGET_CHARS constant.
 */

// ─── Constants ───────────────────────────────────────────

const WA_MAX_CHARS = 4096;

// ─── Flashcard Queue Formatter ──────────────────────────

interface StudyQueueCard {
  id: string;
  front_text?: string;
  keyword_name?: string;
  course_name?: string;
  due_at?: string;
}

/**
 * Formats study queue data for a summary message.
 * C7 FIX: Now imported by handler.ts for get_study_queue fallback.
 */
export function formatFlashcardSummary(
  cards: StudyQueueCard[],
  count: number,
): string {
  if (!cards || count === 0) {
    return "\ud83c\udf89 ¡No tienes flashcards pendientes! Estás al día.";
  }

  const lines: string[] = [
    `\ud83d\udcda *${count} flashcards pendientes*`,
    "",
  ];

  const byCourse = new Map<string, StudyQueueCard[]>();
  for (const card of cards.slice(0, 15)) {
    const course = card.course_name || "Sin curso";
    if (!byCourse.has(course)) byCourse.set(course, []);
    byCourse.get(course)!.push(card);
  }

  for (const [course, courseCards] of byCourse) {
    lines.push(`\ud83d\udcd6 ${course} (${courseCards.length})`);
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
    lines.push(`(mostrando 15 de ${count})`);
  }

  return truncateForWhatsApp(lines.join("\n"));
}

// ─── Progress Formatter ─────────────────────────────────

interface ProgressData {
  total_topics: number;
  average_mastery: string;
  weak_topics: string[];
  details?: Array<{
    topic_name: string;
    course_name: string;
    mastery_level: number;
  }>;
}

export function formatProgressSummary(progress: ProgressData): string {
  const lines: string[] = [
    `\ud83d\udcca *Tu progreso*`,
    "",
    `\ud83c\udfaf Mastery promedio: ${progress.average_mastery}`,
    `\ud83d\udcd1 Topics totales: ${progress.total_topics}`,
  ];

  if (progress.weak_topics?.length > 0) {
    lines.push("");
    lines.push(`\u26a0\ufe0f *Topics débiles:*`);
    for (const topic of progress.weak_topics.slice(0, 5)) {
      lines.push(`  \u2022 ${topic}`);
    }
  }

  if (progress.details?.length) {
    lines.push("");
    lines.push(`*Detalle por topic:*`);
    for (const d of progress.details.slice(0, 8)) {
      const bar = masteryBar(d.mastery_level);
      lines.push(`${bar} ${d.topic_name} (${d.course_name})`);
    }
  }

  return truncateForWhatsApp(lines.join("\n"));
}

// ─── Schedule Formatter ─────────────────────────────────

interface ScheduleData {
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

export function formatScheduleSummary(schedule: ScheduleData): string {
  const periodLabel = schedule.period === "week" ? "esta semana" : "hoy";

  if (!schedule.tasks?.length) {
    return `\ud83d\udcc5 No tienes tareas para ${periodLabel}. ¡Tiempo libre! \ud83c\udf89`;
  }

  const lines: string[] = [
    `\ud83d\udcc5 *Agenda ${periodLabel}*`,
    `\u2705 ${schedule.completed} completadas \u2022 \u23f3 ${schedule.pending} pendientes`,
    "",
  ];

  for (const task of schedule.tasks.slice(0, 10)) {
    const icon = task.is_completed ? "\u2705" : "\u23f3";
    const date = formatShortDate(task.due_date);
    lines.push(`${icon} ${task.title} \u2014 ${date}`);
  }

  if (schedule.tasks.length > 10) {
    lines.push(`\n\u2026 y ${schedule.tasks.length - 10} más`);
  }

  return truncateForWhatsApp(lines.join("\n"));
}

// ─── Content Browser Formatter ──────────────────────────

interface BrowseResult {
  level: "courses" | "sections" | "keywords";
  items: Array<Record<string, unknown>>;
}

export function formatBrowseContent(result: BrowseResult): string {
  const items = result.items || [];
  if (items.length === 0) {
    return "No se encontró contenido. \ud83d\ude14";
  }

  const lines: string[] = [];

  switch (result.level) {
    case "courses":
      lines.push(`\ud83c\udfeb *Tus cursos:*\n`);
      for (const item of items.slice(0, 10)) {
        const name = (item as { name?: string }).name || "Sin nombre";
        const code = (item as { code?: string }).code || "";
        lines.push(`\ud83d\udcd5 ${name}${code ? ` (${code})` : ""}`);
      }
      break;

    case "sections":
      lines.push(`\ud83d\udcc2 *Secciones:*\n`);
      for (const item of items.slice(0, 15)) {
        const name = (item as { name?: string }).name || "Sin nombre";
        lines.push(`  \u2022 ${name}`);
      }
      break;

    case "keywords":
      lines.push(`\ud83d\udd11 *Temas:*\n`);
      for (const item of items.slice(0, 15)) {
        const name = (item as { name?: string }).name || "Sin nombre";
        lines.push(`  \u2022 ${name}`);
      }
      break;
  }

  return truncateForWhatsApp(lines.join("\n"));
}

// ─── Helpers ────────────────────────────────────────────

export function truncateForWhatsApp(text: string): string {
  if (text.length <= WA_MAX_CHARS) return text;

  const truncated = text.slice(0, WA_MAX_CHARS - 10);
  const lastNewline = truncated.lastIndexOf("\n");

  if (lastNewline > WA_MAX_CHARS * 0.7) {
    return truncated.slice(0, lastNewline) + "\n\u2026";
  }

  return truncated + "\u2026";
}

function formatShortDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    const days = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
  } catch {
    return isoDate.slice(0, 10);
  }
}

function masteryBar(level: number): string {
  if (level >= 0.8) return "\ud83d\udfe2";
  if (level >= 0.5) return "\ud83d\udfe1";
  if (level >= 0.3) return "\ud83d\udfe0";
  return "\ud83d\udd34";
}
