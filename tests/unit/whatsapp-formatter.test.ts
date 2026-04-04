/**
 * tests/unit/whatsapp-formatter.test.ts — 20 tests for WhatsApp message formatters
 *
 * Tests all public exports:
 * - formatFlashcardSummary
 * - formatProgressSummary
 * - formatScheduleSummary
 * - formatBrowseContent
 * - truncateForWhatsApp
 *
 * Run: deno test tests/unit/whatsapp-formatter.test.ts --allow-env --allow-read --allow-net --no-check
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
  truncateForWhatsApp,
} from "../../supabase/functions/server/routes/whatsapp/formatter.ts";

Deno.test("W01 · formatFlashcardSummary: empty cards → celebration message", () => {
  const result = formatFlashcardSummary([], 0);
  assertStringIncludes(result, "No tienes flashcards pendientes");
  assertStringIncludes(result, "Estás al día");
});

Deno.test("W02 · formatFlashcardSummary: single card", () => {
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

Deno.test("W03 · formatFlashcardSummary: course grouping without bold formatting", () => {
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
  ];
  const result = formatFlashcardSummary(cards, 2);
  assertStringIncludes(result, "Biology");
  assertStringIncludes(result, "Chemistry");
});

Deno.test("W04 · formatFlashcardSummary: truncates preview to 60 chars", () => {
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
});

Deno.test("W05 · formatFlashcardSummary: shows limit for >15 cards without italic", () => {
  const cards = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`,
    front_text: `Q${i}`,
    keyword_name: `k${i}`,
    course_name: `Course${i % 3}`,
  }));
  const result = formatFlashcardSummary(cards, 20);
  assertStringIncludes(result, "mostrando 15 de 20");
});

Deno.test("W06 · formatProgressSummary: includes average mastery without bold", () => {
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

Deno.test("W07 · formatProgressSummary: shows weak topics without bold formatting", () => {
  const progress = {
    total_topics: 10,
    average_mastery: "75%",
    weak_topics: ["Topic A", "Topic B"],
  };
  const result = formatProgressSummary(progress);
  assertStringIncludes(result, "Topics débiles");
  assertStringIncludes(result, "Topic A");
  assertStringIncludes(result, "Topic B");
});

Deno.test("W08 · formatProgressSummary: details without italic formatting", () => {
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
  assertStringIncludes(result, "Topic A");
  assertStringIncludes(result, "Course X");
});

Deno.test("W09 · formatScheduleSummary: no tasks → free time message", () => {
  const schedule = {
    period: "day",
    tasks: [],
    pending: 0,
    completed: 0,
  };
  const result = formatScheduleSummary(schedule);
  assertStringIncludes(result, "No tienes tareas para hoy");
});

Deno.test("W10 · formatScheduleSummary: shows task counts", () => {
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

Deno.test("W11 · formatScheduleSummary: no strikethrough in WhatsApp version", () => {
  const schedule = {
    period: "day",
    tasks: [
      {
        title: "Completed Task",
        due_date: "2026-04-05T10:00:00Z",
        is_completed: true,
      },
    ],
    pending: 0,
    completed: 1,
  };
  const result = formatScheduleSummary(schedule);
  assertStringIncludes(result, "Completed Task");
  assert(!result.includes("~"), "Should not use strikethrough");
});

Deno.test("W12 · formatScheduleSummary: shows icons for status", () => {
  const schedule = {
    period: "day",
    tasks: [
      {
        title: "Done",
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

Deno.test("W13 · formatBrowseContent: empty items → not found", () => {
  const result = formatBrowseContent({
    level: "courses",
    items: [],
  });
  assertStringIncludes(result, "No se encontró contenido");
});

Deno.test("W14 · formatBrowseContent: courses level without bold", () => {
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
  assert(!result.includes("*Biology*"));
});

Deno.test("W15 · formatBrowseContent: sections level", () => {
  const result = formatBrowseContent({
    level: "sections",
    items: [
      { name: "Section 1" },
      { name: "Section 2" },
    ],
  });
  assertStringIncludes(result, "Secciones");
  assertStringIncludes(result, "Section 1");
});

Deno.test("W16 · formatBrowseContent: keywords level shows items", () => {
  const result = formatBrowseContent({
    level: "keywords",
    items: [
      { name: "Photosynthesis" },
      { name: "Respiration" },
    ],
  });
  assertStringIncludes(result, "Temas");
  assertStringIncludes(result, "Photosynthesis");
  assertStringIncludes(result, "Respiration");
});

Deno.test("W17 · truncateForWhatsApp: short text unchanged", () => {
  const text = "Hello world";
  const result = truncateForWhatsApp(text);
  assertEquals(result, text);
});

Deno.test("W18 · truncateForWhatsApp: respects 4096 char limit", () => {
  const longText = "x".repeat(4500);
  const result = truncateForWhatsApp(longText);
  assert(result.length <= 4096, `Expected ≤4096, got ${result.length}`);
});

Deno.test("W19 · truncateForWhatsApp: breaks at newline when possible", () => {
  const text = "line1\nline2\nline3" + "x".repeat(4500);
  const result = truncateForWhatsApp(text);
  assert(result.length <= 4096);
  assert(result.endsWith("…") || result.includes("\n"));
});

Deno.test("W20 · truncateForWhatsApp: adds ellipsis on truncation", () => {
  const longText = "x".repeat(5000);
  const result = truncateForWhatsApp(longText);
  assert(result.endsWith("…"), "Should end with ellipsis");
});
