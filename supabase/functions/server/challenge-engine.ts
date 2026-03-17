/**
 * challenge-engine.ts — Pure challenge evaluation for Axon v4.4 Sprint 2
 *
 * Contains ONLY pure functions — zero DB access, fully testable.
 *
 * Challenge types:
 *   daily_reviews    — Complete N reviews in a day
 *   daily_xp         — Earn N XP in a day
 *   streak_maintain   — Maintain streak for N days
 *   mastery_improve   — Improve mastery on N topics
 *   session_complete  — Complete N study sessions
 *   quiz_perfect      — Score 100% on a quiz
 *   time_study        — Study for N minutes in a day
 *   variety           — Review items from N different topics
 *
 * CONTRACT COMPLIANCE:
 *   §7.14 — No challenges for notes/annotations
 *   §10   — Bonus multipliers SUM (via xp-engine)
 */

// --- Types ---

export interface ChallengeTemplate {
  slug: string;
  title_es: string;
  description_es: string;
  category: "review" | "xp" | "streak" | "mastery";
  criteria_field: string;
  criteria_op: ">=";
  criteria_value: number;
  xp_reward: number;
  difficulty: "easy" | "medium" | "hard";
  duration_hours: number;
}

export interface ChallengeProgress {
  challenge_slug: string;
  criteria_field: string;
  criteria_op: string;
  criteria_value: number;
  current_value: number;
}

export interface ChallengeEvalResult {
  completed: boolean;
  progress_pct: number;
  current: number;
  target: number;
}

// --- Challenge Templates (12 templates, 4 categories) ---

export const CHALLENGE_TEMPLATES: ChallengeTemplate[] = [
  // === REVIEW category ===
  {
    slug: "daily_reviews_10",
    title_es: "Revisor Activo",
    description_es: "Completa 10 revisiones hoy",
    category: "review",
    criteria_field: "reviews_today",
    criteria_op: ">=",
    criteria_value: 10,
    xp_reward: 30,
    difficulty: "easy",
    duration_hours: 24,
  },
  {
    slug: "daily_reviews_25",
    title_es: "Maratón de Revisión",
    description_es: "Completa 25 revisiones hoy",
    category: "review",
    criteria_field: "reviews_today",
    criteria_op: ">=",
    criteria_value: 25,
    xp_reward: 75,
    difficulty: "medium",
    duration_hours: 24,
  },
  {
    slug: "daily_reviews_50",
    title_es: "Revisión Extrema",
    description_es: "Completa 50 revisiones hoy",
    category: "review",
    criteria_field: "reviews_today",
    criteria_op: ">=",
    criteria_value: 50,
    xp_reward: 150,
    difficulty: "hard",
    duration_hours: 24,
  },
  // === XP category ===
  {
    slug: "daily_xp_100",
    title_es: "Cosechador de XP",
    description_es: "Gana 100 XP hoy",
    category: "xp",
    criteria_field: "xp_today",
    criteria_op: ">=",
    criteria_value: 100,
    xp_reward: 25,
    difficulty: "easy",
    duration_hours: 24,
  },
  {
    slug: "daily_xp_250",
    title_es: "XP en Llamas",
    description_es: "Gana 250 XP hoy",
    category: "xp",
    criteria_field: "xp_today",
    criteria_op: ">=",
    criteria_value: 250,
    xp_reward: 60,
    difficulty: "medium",
    duration_hours: 24,
  },
  {
    slug: "weekly_xp_1000",
    title_es: "Semana Productiva",
    description_es: "Gana 1000 XP esta semana",
    category: "xp",
    criteria_field: "xp_this_week",
    criteria_op: ">=",
    criteria_value: 1000,
    xp_reward: 100,
    difficulty: "medium",
    duration_hours: 168,
  },
  // === STREAK category ===
  {
    slug: "streak_3",
    title_es: "Constancia",
    description_es: "Mantén una racha de 3 días",
    category: "streak",
    criteria_field: "current_streak",
    criteria_op: ">=",
    criteria_value: 3,
    xp_reward: 40,
    difficulty: "easy",
    duration_hours: 168,
  },
  {
    slug: "streak_7",
    title_es: "Semana Completa",
    description_es: "Mantén una racha de 7 días",
    category: "streak",
    criteria_field: "current_streak",
    criteria_op: ">=",
    criteria_value: 7,
    xp_reward: 100,
    difficulty: "medium",
    duration_hours: 168,
  },
  {
    slug: "streak_14",
    title_es: "Dos Semanas Imparable",
    description_es: "Mantén una racha de 14 días",
    category: "streak",
    criteria_field: "current_streak",
    criteria_op: ">=",
    criteria_value: 14,
    xp_reward: 200,
    difficulty: "hard",
    duration_hours: 336,
  },
  // === MASTERY category ===
  {
    slug: "sessions_3",
    title_es: "Estudiante Dedicado",
    description_es: "Completa 3 sesiones de estudio hoy",
    category: "mastery",
    criteria_field: "sessions_today",
    criteria_op: ">=",
    criteria_value: 3,
    xp_reward: 50,
    difficulty: "medium",
    duration_hours: 24,
  },
  {
    slug: "correct_streak_5",
    title_es: "Racha Perfecta",
    description_es: "Responde 5 revisiones correctas seguidas",
    category: "mastery",
    criteria_field: "correct_streak",
    criteria_op: ">=",
    criteria_value: 5,
    xp_reward: 35,
    difficulty: "easy",
    duration_hours: 24,
  },
  {
    slug: "correct_streak_15",
    title_es: "Dominio Total",
    description_es: "Responde 15 revisiones correctas seguidas",
    category: "mastery",
    criteria_field: "correct_streak",
    criteria_op: ">=",
    criteria_value: 15,
    xp_reward: 120,
    difficulty: "hard",
    duration_hours: 24,
  },
];

// --- Pure Evaluation ---

export function evaluateChallenge(progress: ChallengeProgress): ChallengeEvalResult {
  const { current_value, criteria_value, criteria_op } = progress;

  let completed = false;
  if (criteria_op === ">=") {
    completed = current_value >= criteria_value;
  }

  const raw_pct = criteria_value > 0
    ? (current_value / criteria_value) * 100
    : 100;
  const progress_pct = Math.min(100, Math.max(0, Math.round(raw_pct)));

  return {
    completed,
    progress_pct,
    current: current_value,
    target: criteria_value,
  };
}

export function selectDailyChallenges(
  templates: ChallengeTemplate[],
  count: number = 3,
  excludeSlugs: string[] = [],
): ChallengeTemplate[] {
  const dailyTemplates = templates.filter(
    (t) => t.duration_hours <= 24 && !excludeSlugs.includes(t.slug),
  );

  if (dailyTemplates.length <= count) return dailyTemplates;

  const byCategory = new Map<string, ChallengeTemplate[]>();
  for (const t of dailyTemplates) {
    const arr = byCategory.get(t.category) ?? [];
    arr.push(t);
    byCategory.set(t.category, arr);
  }

  const selected: ChallengeTemplate[] = [];
  const categories = [...byCategory.keys()];

  for (const cat of categories) {
    if (selected.length >= count) break;
    const pool = byCategory.get(cat)!;
    const idx = Math.floor(Math.random() * pool.length);
    selected.push(pool[idx]);
  }

  if (selected.length < count) {
    const selectedSlugs = new Set(selected.map((s) => s.slug));
    const remaining = dailyTemplates.filter(
      (t) => !selectedSlugs.has(t.slug),
    );
    for (const t of remaining) {
      if (selected.length >= count) break;
      selected.push(t);
    }
  }

  return selected.slice(0, count);
}

export function difficultyMultiplier(difficulty: "easy" | "medium" | "hard"): number {
  switch (difficulty) {
    case "easy": return 1.0;
    case "medium": return 1.5;
    case "hard": return 2.0;
    default: return 1.0;
  }
}
