/**
 * routes/ai/generate-smart-helpers.ts — Types and helpers for adaptive generation
 *
 * Extracted from generate-smart.ts (PR #103) for maintainability.
 * Contains pure functions with zero side effects.
 *
 * Exports:
 *   SmartTarget        — RPC result type
 *   BulkGeneratedItem  — Bulk response item
 *   BulkErrorItem      — Bulk error item
 *   ACTIONS            — Allowed action types
 *   MAX_BULK_COUNT     — Max items per bulk request
 *   truncateForPrompt  — Word-boundary truncation for LLM prompts
 *   reasonToText       — Maps primary_reason to Spanish explanation
 *   adaptiveTemperature — BKT mastery → LLM temperature
 */

import { truncateAtWord } from "../../auto-ingest.ts";

// ─── Constants ────────────────────────────────────────────────

export const ACTIONS = ["quiz_question", "flashcard"] as const;
export const MAX_BULK_COUNT = 10;

// ─── Types ────────────────────────────────────────────────────

export interface SmartTarget {
  subtopic_id: string | null;
  subtopic_name: string | null;
  keyword_id: string;
  keyword_name: string;
  keyword_def: string | null;
  summary_id: string;
  summary_title: string;
  topic_id: string;
  p_know: number;
  need_score: number;
  primary_reason: string;
}

export interface BulkGeneratedItem {
  type: string;
  id: string;
  keyword_id: string;
  keyword_name: string;
  summary_id: string;
  _smart: {
    p_know: number;
    need_score: number;
    primary_reason: string;
    target_subtopic: string | null;
  };
}

export interface BulkErrorItem {
  keyword_id: string;
  keyword_name: string;
  error: string;
}

// ─── Helper Functions ─────────────────────────────────────────

/**
 * D12: Prompt-specific truncation — adds "..." to signal truncation to LLM.
 * Core word-boundary logic imported from auto-ingest.ts (single source of truth).
 */
export function truncateForPrompt(text: string, maxLen: number): string {
  const result = truncateAtWord(text, maxLen);
  return result.length < text.length ? result + "..." : result;
}

/**
 * D13: Map primary_reason to Spanish explanation for prompt.
 */
export function reasonToText(reason: string, pKnow: number): string {
  const pct = Math.round(pKnow * 100);
  switch (reason) {
    case "new_concept":
      return "Es un concepto nuevo que aun no has estudiado.";
    case "low_mastery":
      return `Tu dominio es bajo (${pct}%). Necesitas reforzar este concepto.`;
    case "needs_review":
      return `Tu dominio es moderado-bajo (${pct}%). Un repaso te ayudara a consolidar.`;
    case "moderate_mastery":
      return `Tu dominio es intermedio (${pct}%). Puedes profundizar con ejercicios mas desafiantes.`;
    case "reinforcement":
      return `Tu dominio es alto (${pct}%). Este ejercicio te ayudara a mantener el conocimiento.`;
    default:
      return `Concepto seleccionado para estudio (dominio: ${pct}%).`;
  }
}

/**
 * D10: Adaptive temperature based on mastery.
 * Low mastery → lower temperature (more focused).
 * High mastery → higher temperature (more creative).
 */
export function adaptiveTemperature(pKnow: number): number {
  if (pKnow < 0.3) return 0.5;
  if (pKnow < 0.7) return 0.7;
  return 0.85;
}
