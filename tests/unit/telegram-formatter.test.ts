/**
 * tests/unit/telegram-formatter.test.ts — 25 tests for Telegram message formatters
 *
 * Tests all public exports:
 * - formatFlashcardSummary
 * - formatProgressSummary
 * - formatScheduleSummary
 * - formatBrowseContent
 * - formatKeywordDetail
 * - formatSummaryPreview
 * - truncateForTelegram
 *
 * Run: deno test tests/unit/telegram-formatter.test.ts --allow-env --allow-read --allow-net --no-check
 */

import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  formatFlashcardSummary,
  formatProgressSummary,
  formatScheduleSummary,
  formatBrowseContent,
  formatKeywordDetail,
  formatSummaryPreview,
  truncateForTelegram,
} from "../../supabase/functions/server/routes/telegram/formatter.ts";

// ═══════════════════════════════════════════════════════════════
// 1. Flashcard Summary
// ═══════════════════════════════════════════════════════════════

Deno.test("T01 · formatFlashcardSummary: empty cards → celebration message", () => {
  const result = formatFlashcardSummary([], 0);
  assertStringIncludes(result, "No tienes flashcards pendientes");
  assertStringIncludes(result, "Estás al día");
});

Deno.test("T02 · formatFlashcardSummary: single card with course", () => {
  const cards = [
    {
      id: "c1",
      front_text: "What is photosynthesis?",
      keyword_name: "Photosynthesis",
      course_name: "Biology",
    },
  ];
  const result = formatFlashcardSummary(cards, 1);
  assertStringIncludes(result, "1 flashcards pendientes");
  assertStringIncludes(result, "Biology");
  assertStringIncludes(result, "What is photosynthesis");
});

Deno.test("T03 · formatFlashcardSummary: groups cards by course", () => {
  const cards = [
    {
      id: "c1",
      front_text: "Q1",
      keyword_name: "k1",
      course_name: "Biology",
    },
    {
      id: "c2",
      front_text: "Q2",
      keyword_name: "k2",
      course_name: "Chemistry",
    },
    {
      id: "c3",
      front_text: "Q3",
      keyword_name: "k3",
      course_name: "Biology",
    },
  ];
  const result = formatFlashcardSummary(cards, 3);
  assertStringIncludes(result, "Biology");
  assertStringIncludes(result, "Chemistry");
  assertStringIncludes(result, "(2)");
});

Deno.test("T04 · formatFlashcardSummary: truncates preview to 60 chars", () => {
  const longText = "a".repeat(100);
  const cards = [
    {
      id: "c1",
      front_text: longText,
      keyword_name: "k",
      course_name: "Course",
    },
  ];
  const result = formatFlashcardSummary(cards, 1);
  assert(result.includes("a".repeat(60)), "Should include first 60 chars");
  assert(!result.includes("a".repeat(100)), "Should not include full text");
});

Deno.test("T05 · formatFlashcardSummary: shows '... y N más' for >5 cards per course", () => {
  const cards = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`,
    front_text: `Q${i}`,
    keyword_name: `k${i}`,
    course_name: "Biology",
  }));
  const result = formatFlashcardSummary(cards, 8);
  assertStringIncludes(result, "y 3 más");
});

Deno.test("T06 · formatFlashcardSummary: shows limit message for >15 cards", () => {
  const cards = Array.from({ length: 25 }, (_, i) => ({
    id: `c${i}`,
    front_text: `Q${i}`,
    keyword_name: `k${i}`,
    course_name: `Course${Math.floor(i / 3)}`,
  }));
  const result = formatFlashcardSummary(cards, 25);
  assertStringIncludes(result, "mostrando 15 de 25");
});

// ═══════════════════════════════════════════════════════════════
// 2. Progress Summary
// ═══════════════════════════════════════════════════════════════

Deno.test("T07 · formatProgressSummary: includes average mastery", () => {
  const progress = {
    total_topics: 10,
    average_mastery: "75%",
    weak_topics: [],
  };
  const result = formatProgressSummary(progress);
  assertStringIncludes(result, "Tu progreso");
  assertStringIncludes(result, "75%");
  assertStringIncludes(result, "10");
});

Deno.test("T08 · formatProgressSummary: shows weak topics", () => {
  const progress = {
    total_topics: 10,
    average_mastery: "75%",
    weak_topics: ["Photosynthesis", "Mitochondria"],
  };
  const result = formatProgressSummary(progress);
  assertStringIncludes(result, "Topics débiles");
  assertStringIncludes(result, "Photosynthesis");
  assertStringIncludes(result, "Mitochondria");
});

Deno.test("T09 · formatProgressSummary: includes mastery bar for details", () => {
  const progress = {
    total_topics: 2,
    average_mastery: "60%",
    weak_topics: [],
    details: [
      { topic_name: "Topic A", course_name: "Course X", mastery_level: 0.9 },
      { topic_name: "Topic B", course_name: "Course Y", mastery_level: 0.3 },
    ],
  };
  const result = formatProgressSummary(progress);
  assertStringIncludes(result, "Detalle por topic");
  assertStringIncludes(result, "Topic A");
  assertStringIncludes(result, "Topic B");
  assert(result.includes("🟢") || result.includes("🟡") || result.includes("🔴"));
});

// ═══════════════════════════════════════════════════════════════
// 3. Schedule Summary
// ═══════════════════════════════════════════════════════════════

Deno.test("T10 · formatScheduleSummary: no tasks → free time message", () => {
  const schedule = {
    period: "day",
    tasks: [],
    pending: 0,
    completed: 0,
  };
  const result = formatScheduleSummary(schedule);
  assertStringIncludes(result, "No tienes tareas para hoy");
  assertStringIncludes(result, "Tiempo libre");
});

Deno.test("T11 · formatScheduleSummary: shows completed/pending counts", () => {
  const schedule = {
    period: "day",
    tasks: [
      {
        title: "Task 1",
        due_date: "2026-04-05T10:00:00Z",
        is_completed: true,
      },
      {
        title: "Task 2",
        due_date: "2026-04-05T14:00:00Z",
        is_completed: false,
      },
    ],
    pending: 1,
    completed: 1,
  };
  const result = formatScheduleSummary(schedule);
  assertStringIncludes(result, "1 completadas");
  assertStringIncludes(result, "1 pendientes");
});

Deno.test("T12 · formatScheduleSummary: shows completion status with icons", () => {
  const schedule = {
    period: "day",
    tasks: [
      {
        title: "Completed",
        due_date: "2026-04-05T10:00:00Z",
        is_completed: true,
      },
      {
        title: "Pending",
        due_date: "2026-04-05T14:00:00Z",
        is_completed: false,
      },
    ],
    pending: 1,
    completed: 1,
  };
  const result = formatScheduleSummary(schedule);
  assertStringIncludes(result, "✅");
  assertStringIncludes(result, "⏳");
});

Deno.test("T13 · formatScheduleSummary: period 'week' → 'esta semana'", () => {
  const schedule = {
    period: "week",
    tasks: [
      {
        title: "Weekly task",
        due_date: "2026-04-05T10:00:00Z",
        is_completed: false,
      },
    ],
    pending: 1,
    completed: 0,
  };
  const result = formatScheduleSummary(schedule);
  assertStringIncludes(result, "esta semana");
});

// ═══════════════════════════════════════════════════════════════
// 4. Browse Content
// ═══════════════════════════════════════════════════════════════

Deno.test("T14 · formatBrowseContent: empty items → not found message", () => {
  const result = formatBrowseContent({
    level: "courses",
    items: [],
  });
  assertStringIncludes(result, "No se encontró contenido");
});

Deno.test("T15 · formatBrowseContent: courses level shows course names", () => {
  const result = formatBrowseContent({
    level: "courses",
    items: [
      { name: "Biology", code: "BIO101" },
      { name: "Chemistry", code: "CHEM101" },
    ],
  });
  assertStringIncludes(result, "Tus cursos");
  assertStringIncludes(result, "Biology");
  assertStringIncludes(result, "BIO101");
});

Deno.test("T16 · formatBrowseContent: sections level", () => {
  const result = formatBrowseContent({
    level: "sections",
    items: [
      { name: "Chapter 1" },
      { name: "Chapter 2" },
    ],
  });
  assertStringIncludes(result, "Secciones");
  assertStringIncludes(result, "Chapter 1");
});

Deno.test("T17 · formatBrowseContent: keywords level", () => {
  const result = formatBrowseContent({
    level: "keywords",
    items: [
      { name: "Photosynthesis" },
      { name: "Mitochondria" },
    ],
  });
  assertStringIncludes(result, "Temas");
  assertStringIncludes(result, "Photosynthesis");
});

// ═══════════════════════════════════════════════════════════════
// 5. Keyword Detail
// ═══════════════════════════════════════════════════════════════

Deno.test("T18 · formatKeywordDetail: shows name and definition", () => {
  const keyword = {
    name: "Photosynthesis",
    definition: "The process by which plants convert light energy into chemical energy.",
  };
  const result = formatKeywordDetail(keyword);
  assertStringIncludes(result, "Photosynthesis");
  assertStringIncludes(result, "convert light energy");
});

Deno.test("T19 · formatKeywordDetail: truncates long definitions to 500 chars", () => {
  const longDef = "x".repeat(600);
  const keyword = {
    name: "Key",
    definition: longDef,
  };
  const result = formatKeywordDetail(keyword);
  assert(result.includes("x".repeat(500)), "Should include first 500 chars");
  assert(!result.includes("x".repeat(600)), "Should truncate at 500");
});

// ═══════════════════════════════════════════════════════════════
// 6. Summary Preview
// ═══════════════════════════════════════════════════════════════

Deno.test("T20 · formatSummaryPreview: includes title and content preview", () => {
  const result = formatSummaryPreview(
    "My Summary",
    "This is the content of my summary",
    150,
  );
  assertStringIncludes(result, "My Summary");
  assertStringIncludes(result, "This is the content");
  assertStringIncludes(result, "150 palabras");
});

Deno.test("T21 · formatSummaryPreview: truncates content to 500 chars with indicator", () => {
  const longContent = "a".repeat(600);
  const result = formatSummaryPreview("Title", longContent);
  assert(result.includes("a".repeat(500)), "Should include first 500 chars");
  assertStringIncludes(result, "resumen truncado");
});

// ═══════════════════════════════════════════════════════════════
// 7. Truncate for Telegram
// ═══════════════════════════════════════════════════════════════

Deno.test("T22 · truncateForTelegram: short text → unchanged", () => {
  const text = "Hello world";
  const result = truncateForTelegram(text);
  assertEquals(result, text);
});

Deno.test("T23 · truncateForTelegram: respects 4096 char limit", () => {
  const longText = "x".repeat(4500);
  const result = truncateForTelegram(longText);
  assert(result.length <= 4096, `Expected ≤4096, got ${result.length}`);
});

Deno.test("T24 · truncateForTelegram: breaks at newline when possible", () => {
  const text = "line1\nline2\nline3" + "x".repeat(4500);
  const result = truncateForTelegram(text);
  assert(result.includes("\n") || result.endsWith("…"));
  assert(result.length <= 4096);
});

Deno.test("T25 · truncateForTelegram: adds ellipsis indicator", () => {
  const longText = "x".repeat(5000);
  const result = truncateForTelegram(longText);
  assert(result.endsWith("…"), "Should end with ellipsis");
});
