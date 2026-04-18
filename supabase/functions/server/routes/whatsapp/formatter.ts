/**
 * routes/whatsapp/formatter.ts — WhatsApp message formatting (S11)
 *
 * Thin wrapper over routes/_messaging/formatter-base.ts.
 * Converts raw DB/tool results into compact, emoji-enhanced text
 * optimized for WhatsApp mobile reading.
 *
 * Design constraints:
 *   - Max 4096 chars per WhatsApp text message
 *   - Use emojis sparingly but consistently
 *   - WA *does* support *bold* for section headers, but inline bold
 *     and italic render as raw punctuation — so we skip them.
 *   - Spanish language
 *
 * C7 FIX: formatFlashcardSummary is imported by handler.ts for
 * get_study_queue fallback path.
 * C9 FIX: Removed unused TARGET_CHARS constant.
 *
 * PUBLIC API: formatFlashcardSummary, formatProgressSummary,
 * formatScheduleSummary, formatBrowseContent, truncateForWhatsApp.
 * Imported by tests/unit/whatsapp-formatter.test.ts, handler.ts, tools.ts.
 */

import {
  formatFlashcardSummary as baseFormatFlashcardSummary,
  formatProgressSummary as baseFormatProgressSummary,
  formatScheduleSummary as baseFormatScheduleSummary,
  formatBrowseContent as baseFormatBrowseContent,
  truncate,
  identity,
  type FormatterConfig,
  type MarkdownStyle,
  type StudyQueueCard,
  type ProgressData,
  type ScheduleData,
  type BrowseResult,
} from "../_messaging/formatter-base.ts";

// ─── Constants ───────────────────────────────────────────

const WA_MAX_CHARS = 4096;

// ─── WhatsApp markdown style ─────────────────────────────
// WA supports *bold* for section headers but inline bold/italic/strike
// render as raw punctuation, so we disable them.

const WA_STYLE: MarkdownStyle = {
  heading: (s) => `*${s}*`,
  boldInline: identity,
  italic: identity,
  strike: identity,
};

const WA_CFG: FormatterConfig = {
  maxChars: WA_MAX_CHARS,
  style: WA_STYLE,
};

// ─── Re-exports via the WhatsApp config ──────────────────

/**
 * Formats study queue data for a summary message.
 * C7 FIX: Now imported by handler.ts for get_study_queue fallback.
 */
export function formatFlashcardSummary(
  cards: StudyQueueCard[],
  count: number,
): string {
  return baseFormatFlashcardSummary(cards, count, WA_CFG);
}

export function formatProgressSummary(progress: ProgressData): string {
  return baseFormatProgressSummary(progress, WA_CFG);
}

export function formatScheduleSummary(schedule: ScheduleData): string {
  return baseFormatScheduleSummary(schedule, WA_CFG);
}

export function formatBrowseContent(result: BrowseResult): string {
  return baseFormatBrowseContent(result, WA_CFG);
}

export function truncateForWhatsApp(text: string): string {
  return truncate(text, WA_MAX_CHARS);
}
