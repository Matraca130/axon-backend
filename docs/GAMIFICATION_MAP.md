# Gamification Backend Map

> Quick reference for the gamification module in axon-backend.
> For the full audit with findings and fixes, see [GAMIFICATION_AUDIT.md](./GAMIFICATION_AUDIT.md).
> For the implementation plan and contract, see the Figma Make dashboard.

---

## Module Structure

```
supabase/functions/server/
|-- xp-engine.ts              <- XP calculation + award_xp() RPC caller + JS fallback
|-- streak-engine.ts          <- Streak lifecycle (check-in, freeze consume, repair eligibility)
|-- xp-hooks.ts               <- 8 afterWrite hooks (fire-and-forget XP awards)
|
+-- routes/gamification/      <- 13 HTTP endpoints
    |-- index.ts              <- Module combiner (mounts 4 sub-routers)
    |-- helpers.ts            <- Constants + badge criteria evaluator
    |-- profile.ts            <- XP profile, history, leaderboard
    |-- badges.ts             <- Badge catalog, check-badges, notifications
    |-- streak.ts             <- Streak status, daily check-in, freeze buy, repair
    +-- goals.ts              <- Daily goal, goal completion, onboarding
```

---

## Endpoints (13 total)

| Method | Path | File | Description |
|---|---|---|---|
| GET | `/gamification/profile?institution_id=` | profile.ts | Composite: XP + streak + badge count |
| GET | `/gamification/xp-history?institution_id=&limit=&offset=` | profile.ts | Paginated XP transaction log |
| GET | `/gamification/leaderboard?institution_id=&period=&limit=` | profile.ts | Weekly/daily leaderboard (MV + fallback) |
| GET | `/gamification/badges?category=` | badges.ts | All badge definitions + earned status |
| POST | `/gamification/check-badges?institution_id=` | badges.ts | Evaluate and award eligible badges |
| GET | `/gamification/notifications?institution_id=&limit=` | badges.ts | Unified XP + badge event timeline |
| GET | `/gamification/streak-status?institution_id=` | streak.ts | Detailed streak info + repair eligibility |
| POST | `/gamification/daily-check-in?institution_id=` | streak.ts | Daily streak check-in (idempotent) |
| POST | `/gamification/streak-freeze/buy?institution_id=` | streak.ts | Purchase streak freeze with XP |
| POST | `/gamification/streak-repair?institution_id=` | streak.ts | Repair broken streak with XP |
| PUT | `/gamification/daily-goal` | goals.ts | Update daily XP goal (body: institution_id, daily_goal) |
| POST | `/gamification/goals/complete` | goals.ts | Complete a goal, award bonus XP |
| POST | `/gamification/onboarding` | goals.ts | Initialize student gamification profile |

---

## XP Hooks (8 hooks, 11 XP actions)

All hooks are fire-and-forget (contract S4.3). They call `awardXP()` from `xp-engine.ts`.

| Hook | Triggered By | XP Action | Base XP |
|---|---|---|---|
| `xpHookForReview` | POST /reviews (afterWrite) | review_flashcard / review_correct | 5 / 10 |
| `xpHookForQuizAttempt` | POST /quiz-attempts (manual) | quiz_answer / quiz_correct | 5 / 15 |
| `xpHookForSessionComplete` | PUT /study-sessions (afterWrite) | complete_session | 25 |
| `xpHookForReadingComplete` | POST /reading-states (manual) | complete_reading | 30 |
| `xpHookForBatchReviews` | POST /review-batch (manual) | review_flashcard / review_correct | 5 / 10 per review |
| `xpHookForVideoComplete` | POST /mux/track-view (manual) | complete_video | 20 |
| `xpHookForRagQuestion` | POST /ai/rag-chat (manual) | rag_question | 5 |
| `xpHookForPlanTaskComplete` | PUT /study-plan-tasks (afterWrite) | complete_plan_task / complete_plan | 15 / 100 |
| (inline in streak.ts) | POST /daily-check-in | streak_daily | 15 |

---

## XP Bonuses (additive, contract S10)

| Bonus | Multiplier | Condition | Source |
|---|---|---|---|
| On-Time Review | +50% | FSRS review within 24h of due_at | Cepeda 2006 |
| Flow Zone | +25% | BKT p_know 0.3-0.7 | Csikszentmihalyi 1990 |
| Variable Reward | +100% | 10% random chance | Skinner VR schedule |
| Streak | +50% | 7+ day streak | Duolingo model |

Example: base=10, on_time+flow = multiplier 1.75 = 18 XP

---

## DB Tables

| Table | Key Columns | Notes |
|---|---|---|
| `student_xp` | student_id + institution_id UNIQUE | XP aggregates, level, daily/weekly counters |
| `xp_transactions` | INSERT ONLY | Immutable log of all XP changes |
| `student_stats` | student_id UNIQUE | Streak + activity counters |
| `badge_definitions` | category CHECK, trigger_config JSONB NOT NULL | Admin-managed catalog |
| `student_badges` | student_id + badge_id + institution_id UNIQUE | Earned badges |
| `streak_freezes` | freeze_type CHECK, xp_cost, expires_at | Purchasable streak protection |
| `streak_repairs` | institution_id, xp_cost, repair_cost, repair_date | Streak repair log |
| `leaderboard_weekly` | Materialized view | Refreshed hourly by pg_cron |

---

## RPCs

| Function | Purpose | Called By |
|---|---|---|
| `award_xp()` | Atomic XP grant + cap + level + log | xp-engine.ts (primary path) |
| `reset_daily_stat_counters()` | Reset xp_today | Cron: reset-daily-xp |
| `reset_weekly_stat_counters()` | Reset xp_this_week | Cron: reset-weekly-xp |

---

## Constants (helpers.ts)

| Constant | Value | Contract Value | Notes |
|---|---|---|---|
| `FREEZE_COST_XP` | 100 | 200 | Lower for MVP |
| `MAX_FREEZES` | 3 | 2 | More generous for MVP |
| `REPAIR_BASE_COST_XP` | 200 | 400 | Lower for MVP |
| Daily XP Cap | 500 | 500 | Matches contract |
| Post-Cap Rate | 10% (min 1) | 10% (min 1) | Matches contract (S6.4) |

---

## Pending Code Fixes (see GAMIFICATION_AUDIT.md)

| ID | Severity | Summary |
|---|---|---|
| G-001 | CRITICAL | streak.ts: freeze INSERT missing freeze_type + xp_cost |
| G-002 | CRITICAL | badges.ts: badge INSERT missing institution_id |
| G-003 | HIGH | streak.ts: repair INSERT missing institution_id |
| G-004 | HIGH | streak.ts: bypasses award_xp() RPC (contract S7.9) |
| G-005 | MEDIUM | badges.ts: icon_url vs icon column name |
| G-006 | MEDIUM | xp-engine.ts: JS fallback ignores daily cap |
| G-007 | LOW | helpers.ts: cost values differ from contract |
