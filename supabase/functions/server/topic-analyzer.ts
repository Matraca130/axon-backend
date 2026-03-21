/**
 * topic-analyzer.ts — Topic difficulty analysis for Axon RAG
 *
 * Pure business-logic function, zero Hono/HTTP dependency.
 * Called after auto-ingest (chunking + embedding) completes for a summary.
 *
 * Flow:
 *   1. Fetch summary content + topic metadata from DB
 *   2. Compute algorithmic signals (word count, keyword density, formulas, etc.)
 *   3. Call Gemini Flash for cognitive analysis (Bloom level, abstraction, etc.)
 *   4. Optionally query cohort difficulty from real student data
 *   5. Combine everything into a final difficulty_estimate (0.0-1.0)
 *   6. Update the topics table with all computed metadata
 *
 * Design:
 *   - Fire-and-forget safe: all errors logged, never thrown to caller
 *   - Fallback defaults if Gemini fails (503, timeout, parse error)
 *   - Uses getAdminClient() for DB access (bypasses RLS)
 *   - Uses generateText() from gemini.ts (Gemini Flash, ~$0.0003/call)
 *   - Sanitizes content before sending to AI (strip HTML, limit length)
 *
 * Exports:
 *   - analyzeTopicDifficulty()    — Main entry point
 *   - TopicAnalysisResult         — Return type
 *   - CURRENT_ANALYSIS_VERSION    — Bump when prompt/model changes
 */

import { generateText, parseGeminiJson } from "./gemini.ts";
import { getAdminClient } from "./db.ts";

// ─── Constants ──────────────────────────────────────────────────────

/** Bump this when the prompt, model, or formula changes to trigger re-analysis. */
export const CURRENT_ANALYSIS_VERSION = 1;

const LOG_PREFIX = "[Topic Analyzer]";

/** Max chars of content sent to Gemini prompt. */
const CONTENT_MAX_CHARS = 4000;

// ─── Public Types ───────────────────────────────────────────────────

export interface TopicAnalysisResult {
  topic_id: string;
  difficulty_estimate: number;       // 0.0-1.0
  estimated_study_minutes: number;
  bloom_level: number;               // 1-6
  abstraction_level: number;         // 1-5
  concept_density: number;           // 1-5
  interrelation_score: number;       // 1-5
  prerequisite_topic_names: string[];
  cohort_difficulty: number | null;
  analysis_version: number;
  elapsed_ms: number;
}

// ─── Internal Types ─────────────────────────────────────────────────

interface AlgorithmicSignals {
  word_count: number;
  keyword_count: number;
  keyword_density: number;
  has_formulas: boolean;
  media_count: number;
}

interface AISignals {
  bloom_level: number;
  abstraction_level: number;
  concept_density: number;
  interrelation_score: number;
  estimated_study_minutes: number;
  prerequisite_topics: string[];
}

// ─── Fallback Defaults ─────────────────────────────────────────────

const FALLBACK_AI_SIGNALS: AISignals = {
  bloom_level: 2,
  abstraction_level: 3,
  concept_density: 3,
  interrelation_score: 3,
  estimated_study_minutes: 30,
  prerequisite_topics: [],
};

// ─── Difficulty Weights ─────────────────────────────────────────────

const DIFFICULTY_WEIGHTS = {
  bloom: 0.30,
  abstraction: 0.25,
  concept_density: 0.20,
  keyword_density: 0.10,
  interrelation: 0.10,
  has_formulas: 0.05,
};

// ─── Helpers ────────────────────────────────────────────────────────

/** Normalize a value from [min, max] to [0, 1]. */
function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return (value - min) / (max - min);
}

/** Strip HTML tags and limit length for safe AI prompt injection. */
function sanitizeForPrompt(text: string, maxLength: number): string {
  // Strip HTML tags
  const stripped = text.replace(/<[^>]*>/g, "");
  // Collapse excessive whitespace
  const collapsed = stripped.replace(/\s{3,}/g, "  ");
  if (collapsed.length <= maxLength) return collapsed;
  // Truncate at word boundary
  const cutPoint = collapsed.lastIndexOf(" ", maxLength);
  return cutPoint > 0 ? collapsed.slice(0, cutPoint) : collapsed.slice(0, maxLength);
}

/** Clamp a numeric value to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─── Algorithmic Signals ────────────────────────────────────────────

function computeAlgorithmicSignals(
  contentMarkdown: string,
  keywordCount: number,
): AlgorithmicSignals {
  const word_count = contentMarkdown.split(/\s+/).filter(Boolean).length;
  const keyword_density = word_count > 0
    ? keywordCount / (word_count / 100)
    : 0;
  const has_formulas = /[∑∫∂Δ=±×÷√]|\\frac|\\sum|\\int|\$\$/.test(contentMarkdown);
  const media_count = (contentMarkdown.match(/!\[|<img|<table|\|.*\|.*\|/g) || []).length;

  return {
    word_count,
    keyword_count: keywordCount,
    keyword_density,
    has_formulas,
    media_count,
  };
}

// ─── AI Analysis via Gemini Flash ───────────────────────────────────

async function fetchAISignals(
  topicName: string,
  contentMarkdown: string,
  algoSignals: AlgorithmicSignals,
): Promise<AISignals> {
  const sanitizedContent = sanitizeForPrompt(contentMarkdown, CONTENT_MAX_CHARS);

  const prompt = `You are an expert in medical education and cognitive science.
Analyze this study material and estimate its difficulty for a medical student.

Topic: ${topicName}
Word count: ${algoSignals.word_count}
Keywords: ${algoSignals.keyword_count}

Content (first ${CONTENT_MAX_CHARS} chars):
${sanitizedContent}

Respond ONLY with valid JSON:
{
  "bloom_level": <1-6, 1=Remember, 2=Understand, 3=Apply, 4=Analyze, 5=Evaluate, 6=Create>,
  "abstraction_level": <1-5, 1=concrete/visual like gross anatomy, 5=abstract/molecular like pharmacokinetics>,
  "concept_density": <1-5, 1=few concepts, 5=many dense concepts per section>,
  "interrelation_score": <1-5, 1=standalone topic, 5=heavily requires other topics>,
  "estimated_study_minutes": <integer, realistic time for average medical student>,
  "prerequisite_topics": ["topic name that should be studied before this one"],
  "reasoning": "one line explaining the difficulty assessment"
}`;

  const result = await generateText({
    prompt,
    temperature: 0.2,
    maxTokens: 512,
    jsonMode: true,
  });

  const parsed = parseGeminiJson<Record<string, unknown>>(result.text);

  // Validate and clamp all fields
  return {
    bloom_level: clamp(Number(parsed.bloom_level) || 2, 1, 6),
    abstraction_level: clamp(Number(parsed.abstraction_level) || 3, 1, 5),
    concept_density: clamp(Number(parsed.concept_density) || 3, 1, 5),
    interrelation_score: clamp(Number(parsed.interrelation_score) || 3, 1, 5),
    estimated_study_minutes: clamp(
      Math.round(Number(parsed.estimated_study_minutes) || 30),
      5,
      300,
    ),
    prerequisite_topics: Array.isArray(parsed.prerequisite_topics)
      ? (parsed.prerequisite_topics as unknown[])
          .filter((t): t is string => typeof t === "string")
          .slice(0, 10) // cap at 10 prerequisites
      : [],
  };
}

// ─── Cohort Difficulty ──────────────────────────────────────────────

/**
 * Query real student performance data to compute empirical difficulty.
 * Returns null if no data is available (new topic, no students yet).
 *
 * Uses the compute_cohort_difficulty RPC which computes average error rate
 * from flashcard reviews (grade 0-5) for the topic's summaries in the last 90 days.
 */
async function fetchCohortDifficulty(
  topicId: string,
  _institutionId: string,
): Promise<number | null> {
  const adminDb = getAdminClient();

  // Use the compute_cohort_difficulty RPC created in migration 20260321000001
  const { data, error } = await adminDb.rpc("compute_cohort_difficulty", {
    p_topic_id: topicId,
  });

  if (error) {
    // RPC may fail if reviews table has no data — this is expected for new topics
    console.warn(
      `${LOG_PREFIX} Cohort difficulty RPC failed: ${error.message}`,
    );
    return null;
  }

  if (data === null || data === undefined) {
    return null;
  }

  const difficulty = Number(data);
  if (isNaN(difficulty) || difficulty < 0 || difficulty > 1) return null;

  return Math.round(difficulty * 100) / 100;
}

// ─── Difficulty Formula ─────────────────────────────────────────────

function computeDifficultyEstimate(
  aiSignals: AISignals,
  algoSignals: AlgorithmicSignals,
  cohortDifficulty: number | null,
): number {
  const raw =
    DIFFICULTY_WEIGHTS.bloom * normalize(aiSignals.bloom_level, 1, 6) +
    DIFFICULTY_WEIGHTS.abstraction * normalize(aiSignals.abstraction_level, 1, 5) +
    DIFFICULTY_WEIGHTS.concept_density * normalize(aiSignals.concept_density, 1, 5) +
    DIFFICULTY_WEIGHTS.keyword_density *
      Math.min(normalize(algoSignals.keyword_density, 0, 10), 1.0) +
    DIFFICULTY_WEIGHTS.interrelation * normalize(aiSignals.interrelation_score, 1, 5) +
    DIFFICULTY_WEIGHTS.has_formulas * (algoSignals.has_formulas ? 1.0 : 0.0);

  // Blend with cohort data if available (40% weight to real data)
  if (cohortDifficulty !== null) {
    return Math.round((0.6 * raw + 0.4 * cohortDifficulty) * 100) / 100;
  }

  return Math.round(raw * 100) / 100;
}

// ─── Entry Point ────────────────────────────────────────────────────

/**
 * Analyze a topic's difficulty after a summary has been ingested.
 *
 * This function is fire-and-forget safe: all errors are caught and logged,
 * never thrown to the caller. On any failure, fallback values are used
 * so the topic always gets a reasonable difficulty estimate.
 *
 * @param summaryId     - The summary that was just ingested
 * @param topicId       - The topic that owns the summary
 * @param institutionId - For cohort difficulty queries (multi-tenant)
 * @returns TopicAnalysisResult with all computed metadata
 */
export async function analyzeTopicDifficulty(
  summaryId: string,
  topicId: string,
  institutionId: string,
): Promise<TopicAnalysisResult> {
  const t0 = Date.now();
  const adminDb = getAdminClient();

  console.info(
    `${LOG_PREFIX} Starting analysis for topic=${topicId}, summary=${summaryId}`,
  );

  // ── Step 1: Fetch summary content + topic name ────────────────

  let contentMarkdown = "";
  let topicName = "Unknown Topic";

  try {
    const [summaryRes, topicRes] = await Promise.all([
      adminDb
        .from("summaries")
        .select("title, content_markdown")
        .eq("id", summaryId)
        .single(),
      adminDb
        .from("topics")
        .select("name")
        .eq("id", topicId)
        .single(),
    ]);

    if (summaryRes.error || !summaryRes.data) {
      console.warn(
        `${LOG_PREFIX} Summary not found: ${summaryId}` +
          (summaryRes.error ? ` (${summaryRes.error.message})` : ""),
      );
    } else {
      const title = (summaryRes.data.title as string) ?? "";
      const body = (summaryRes.data.content_markdown as string) ?? "";
      contentMarkdown = title.trim().length > 0
        ? `${title}\n\n${body}`
        : body;
    }

    if (topicRes.error || !topicRes.data) {
      console.warn(
        `${LOG_PREFIX} Topic not found: ${topicId}` +
          (topicRes.error ? ` (${topicRes.error.message})` : ""),
      );
    } else {
      topicName = (topicRes.data.name as string) ?? "Unknown Topic";
    }
  } catch (e) {
    console.warn(
      `${LOG_PREFIX} DB fetch failed for summary=${summaryId}: ${(e as Error).message}`,
    );
  }

  // ── Step 2: Fetch keyword count for this summary ──────────────

  let keywordCount = 0;
  try {
    const { count, error } = await adminDb
      .from("keywords")
      .select("id", { count: "exact", head: true })
      .eq("summary_id", summaryId);

    if (!error && count !== null) {
      keywordCount = count;
    }
  } catch (e) {
    console.warn(
      `${LOG_PREFIX} Keyword count failed: ${(e as Error).message}`,
    );
  }

  // ── Step 3: Compute algorithmic signals ───────────────────────

  const algoSignals = computeAlgorithmicSignals(contentMarkdown, keywordCount);

  // ── Step 4: Fetch AI signals from Gemini Flash ────────────────

  let aiSignals: AISignals;

  if (contentMarkdown.trim().length === 0) {
    // No content to analyze — use fallbacks
    console.warn(`${LOG_PREFIX} Empty content for summary=${summaryId}, using fallback signals`);
    aiSignals = { ...FALLBACK_AI_SIGNALS };
  } else {
    try {
      aiSignals = await fetchAISignals(topicName, contentMarkdown, algoSignals);
      console.info(
        `${LOG_PREFIX} AI signals: bloom=${aiSignals.bloom_level}, ` +
          `abstraction=${aiSignals.abstraction_level}, ` +
          `density=${aiSignals.concept_density}, ` +
          `interrelation=${aiSignals.interrelation_score}, ` +
          `study_min=${aiSignals.estimated_study_minutes}`,
      );
    } catch (e) {
      console.warn(
        `${LOG_PREFIX} Gemini analysis failed, using fallbacks: ${(e as Error).message}`,
      );
      aiSignals = { ...FALLBACK_AI_SIGNALS };
    }
  }

  // ── Step 5: Fetch cohort difficulty (optional) ────────────────

  let cohortDifficulty: number | null = null;
  try {
    cohortDifficulty = await fetchCohortDifficulty(topicId, institutionId);
    if (cohortDifficulty !== null) {
      console.info(
        `${LOG_PREFIX} Cohort difficulty for topic=${topicId}: ${cohortDifficulty}`,
      );
    }
  } catch (e) {
    console.warn(
      `${LOG_PREFIX} Cohort difficulty query failed: ${(e as Error).message}`,
    );
  }

  // ── Step 6: Compute final difficulty estimate ─────────────────

  const difficultyEstimate = computeDifficultyEstimate(
    aiSignals,
    algoSignals,
    cohortDifficulty,
  );

  const result: TopicAnalysisResult = {
    topic_id: topicId,
    difficulty_estimate: difficultyEstimate,
    estimated_study_minutes: aiSignals.estimated_study_minutes,
    bloom_level: aiSignals.bloom_level,
    abstraction_level: aiSignals.abstraction_level,
    concept_density: aiSignals.concept_density,
    interrelation_score: aiSignals.interrelation_score,
    prerequisite_topic_names: aiSignals.prerequisite_topics,
    cohort_difficulty: cohortDifficulty,
    analysis_version: CURRENT_ANALYSIS_VERSION,
    elapsed_ms: 0, // set below
  };

  // ── Step 7: Update topics table ───────────────────────────────

  try {
    const { error: updateErr } = await adminDb
      .from("topics")
      .update({
        difficulty_estimate: result.difficulty_estimate,
        estimated_study_minutes: result.estimated_study_minutes,
        bloom_level: result.bloom_level,
        abstraction_level: result.abstraction_level,
        concept_density: result.concept_density,
        interrelation_score: result.interrelation_score,
        cohort_difficulty: result.cohort_difficulty,
        last_analyzed_at: new Date().toISOString(),
        analysis_version: CURRENT_ANALYSIS_VERSION,
      })
      .eq("id", topicId);

    if (updateErr) {
      console.warn(
        `${LOG_PREFIX} Failed to update topic ${topicId}: ${updateErr.message}`,
      );
    }
  } catch (e) {
    console.warn(
      `${LOG_PREFIX} Topic update threw: ${(e as Error).message}`,
    );
  }

  // ── Done ──────────────────────────────────────────────────────

  const elapsed = Date.now() - t0;
  result.elapsed_ms = elapsed;

  console.info(
    `${LOG_PREFIX} Done: topic=${topicId}, difficulty=${result.difficulty_estimate}, ` +
      `bloom=${result.bloom_level}, study_min=${result.estimated_study_minutes}, ` +
      `cohort=${result.cohort_difficulty ?? "n/a"}, ${elapsed}ms`,
  );

  return result;
}
