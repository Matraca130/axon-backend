/**
 * routes/telegram/formatter.ts — Telegram message formatting
 *
 * Thin wrapper over routes/_messaging/formatter-base.ts.
 * Converts raw DB/tool results into compact text optimized for Telegram.
 * Uses Telegram Markdown formatting (bold, italic, code blocks).
 *
 * Telegram supports richer formatting than WhatsApp:
 *   - *bold*, _italic_, `code`, ```code block```
 *   - Max 4096 chars per message
 *
 * PUBLIC API: formatFlashcardSummary, formatProgressSummary,
 * formatScheduleSummary, formatBrowseContent, formatKeywordDetail,
 * formatSummaryPreview, truncateForTelegram.
 * Imported by tests/unit/telegram-formatter.test.ts and by tools.ts.
 */

import {
  formatFlashcardSummary as baseFormatFlashcardSummary,
  formatProgressSummary as baseFormatProgressSummary,
  formatScheduleSummary as baseFormatScheduleSummary,
  formatBrowseContent as baseFormatBrowseContent,
  formatKeywordDetail as baseFormatKeywordDetail,
  formatSummaryPreview as baseFormatSummaryPreview,
  truncate,
  type FormatterConfig,
  type MarkdownStyle,
  type StudyQueueCard,
  type ProgressData,
  type ScheduleData,
  type BrowseResult,
  type KeywordData,
} from "../_messaging/formatter-base.ts";

// ─── Constants ───────────────────────────────────────────

const TG_MAX_CHARS = 4096;

// ─── Telegram markdown style ─────────────────────────────

const TG_STYLE: MarkdownStyle = {
  heading: (s) => `*${s}*`,
  boldInline: (s) => `*${s}*`,
  italic: (s) => `_${s}_`,
  strike: (s) => `~${s}~`,
};

const TG_CFG: FormatterConfig = {
  maxChars: TG_MAX_CHARS,
  style: TG_STYLE,
};

// ─── Re-exports via the Telegram config ──────────────────

export function formatFlashcardSummary(
  cards: StudyQueueCard[],
  count: number,
): string {
  return baseFormatFlashcardSummary(cards, count, TG_CFG);
}

export function formatProgressSummary(progress: ProgressData): string {
  return baseFormatProgressSummary(progress, TG_CFG);
}

export function formatScheduleSummary(schedule: ScheduleData): string {
  return baseFormatScheduleSummary(schedule, TG_CFG);
}

export function formatBrowseContent(result: BrowseResult): string {
  return baseFormatBrowseContent(result, TG_CFG);
}

export function formatKeywordDetail(keyword: KeywordData): string {
  return baseFormatKeywordDetail(keyword, TG_CFG);
}

export function formatSummaryPreview(
  title: string,
  content: string,
  wordCount?: number,
): string {
  return baseFormatSummaryPreview(title, content, TG_CFG, wordCount);
}

export function truncateForTelegram(text: string): string {
  return truncate(text, TG_MAX_CHARS);
}
