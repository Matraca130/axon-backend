/**
 * routes/ai/generate-smart-prompts.ts — Prompt builders for adaptive generation
 *
 * Extracted from generate-smart.ts (PR #103) for maintainability.
 * Isolates prompt templates so they can be modified independently
 * of the handler logic.
 *
 * Exports:
 *   SYSTEM_PROMPT         — Shared system prompt for all actions
 *   buildQuizPrompt       — Builds quiz question generation prompt
 *   buildFlashcardPrompt  — Builds flashcard generation prompt
 */

import { reasonToText } from "./generate-smart-helpers.ts";

// ─── System Prompt ────────────────────────────────────────────

export const SYSTEM_PROMPT =
  "Eres un tutor educativo adaptativo. Genera contenido " +
  "personalizado segun el nivel de dominio del alumno.\n" +
  "Responde SOLO con JSON valido, sin explicaciones adicionales.";

// ─── Prompt Context (shared shape) ────────────────────────────

export interface PromptContext {
  summaryTitle: string;
  keywordName: string;
  keywordDef: string | null;
  subtopicName: string | null;
  primaryReason: string;
  pKnow: number;
  contentSnippet: string;
  profNotesContext: string;
  profileContext: string;
  bktContext: string;
}

// ─── Quiz Prompt Builder ──────────────────────────────────────

export function buildQuizPrompt(ctx: PromptContext): string {
  const reasonText = reasonToText(ctx.primaryReason, ctx.pKnow);
  const pct = Math.round(ctx.pKnow * 100);

  return `Genera UNA pregunta de quiz adaptada al nivel del alumno.

Seleccion automatica: ${reasonText}

Tema: ${ctx.summaryTitle}
Keyword: ${ctx.keywordName}${ctx.keywordDef ? ` \u2014 ${ctx.keywordDef}` : ""}
${ctx.subtopicName ? `Subtema: ${ctx.subtopicName}` : ""}
${ctx.profNotesContext}
Contenido relevante: ${ctx.contentSnippet}
${ctx.profileContext}
${ctx.bktContext}

Adapta la dificultad segun el dominio (${pct}%):
- Dominio bajo (<30%): preguntas conceptuales basicas, definiciones
- Dominio medio (30-70%): preguntas de aplicacion y relacion entre conceptos
- Dominio alto (>70%): preguntas de analisis, sintesis o casos limite

Responde en JSON con este schema exacto:
{
  "question_type": "mcq",
  "question": "texto de la pregunta",
  "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
  "correct_answer": "A",
  "explanation": "por que es correcta",
  "difficulty": 1
}
Nota: question_type debe ser "mcq", "true_false", "fill_blank" o "open".
Nota: difficulty debe ser un entero: 1 (facil), 2 (medio), 3 (dificil).`;
}

// ─── Flashcard Prompt Builder ─────────────────────────────────

export function buildFlashcardPrompt(
  ctx: PromptContext,
  related: boolean,
): string {
  const reasonText = reasonToText(ctx.primaryReason, ctx.pKnow);
  const pct = Math.round(ctx.pKnow * 100);

  const scope = related
    ? `Genera una flashcard RELACIONADA al keyword "${ctx.keywordName}".`
    : `Genera una flashcard GENERAL del resumen "${ctx.summaryTitle}".`;

  return `${scope}

Seleccion automatica: ${reasonText}

Keyword: ${ctx.keywordName}${ctx.keywordDef ? ` \u2014 ${ctx.keywordDef}` : ""}
${ctx.subtopicName ? `Subtema: ${ctx.subtopicName}` : ""}
${ctx.profNotesContext}
Contenido relevante: ${ctx.contentSnippet}
${ctx.profileContext}

Adapta el contenido segun el dominio (${pct}%):
- Dominio bajo: definiciones claras y conceptos fundamentales
- Dominio medio: relaciones entre conceptos y comparaciones
- Dominio alto: excepciones, casos limite y aplicaciones avanzadas

Responde en JSON con este schema exacto:
{
  "front": "pregunta o concepto",
  "back": "respuesta o explicacion"
}`;
}
