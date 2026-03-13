# Gamification Quick Reference Map

> **Quick nav for any agent working on gamification in axon-backend.**
> For the full audit, see [GAMIFICATION_AUDIT.md](./GAMIFICATION_AUDIT.md).
> For general backend nav, see [AGENT_INDEX.md](./AGENT_INDEX.md).

---

## 13 Endpoints (6 files)

| Method | Path | File | Description |
|---|---|---|---|
| GET | `/gamification/profile` | `profile.ts` | Student XP profile (level, total_xp, daily progress) |
| GET | `/gamification/xp-history` | `profile.ts` | Paginated XP transaction log |
| GET | `/gamification/leaderboard` | `profile.ts` | Weekly leaderboard (materialized view) |
| GET | `/gamification/badges` | `badges.ts` | All badge definitions + student's earned badges |
| POST | `/gamification/check-badges` | `badges.ts` | Evaluate and award eligible badges |
| GET | `/gamification/notifications` | `badges.ts` | Recent XP + badge events timeline |
| GET | `/gamification/streak-status` | `streak.ts` | Detailed streak info + repair eligibility |
| POST | `/gamification/daily-check-in` | `streak.ts` | Daily login streak check-in + XP |
| POST | `/gamification/streak-freeze/buy` | `streak.ts` | Purchase streak freeze with XP |
| POST | `/gamification/streak-repair` | `streak.ts` | Repair broken streak with XP |
| PUT | `/gamification/daily-goal` | `goals.ts` | Update daily XP goal (10-1000) |
| POST | `/gamification/goals/complete` | `goals.ts` | Mark goal as completed + bonus XP |
| POST | `/gamification/onboarding` | `goals.ts` | Initialize student gamification profile |

---

## 8 XP Hooks (fire-and-forget)

All hooks are in `xp-hooks.ts`. They are called after successful CRUD writes.

| # | Hook | Trigger | XP Action | Amount |
|---|---|---|---|---|
| 1 | `xpHookForReview` | POST /reviews | review_flashcard / review_correct | 5 / 10 |
| 2 | `xpHookForQuizAttempt` | POST /quiz-attempts | quiz_answer / quiz_correct | 5 / 15 |
| 3 | `xpHookForSessionComplete` | PUT /study-sessions (completed_at) | complete_session | 25 |
| 4 | `xpHookForReadingComplete` | POST /reading-states (completed=true) | complete_reading | 30 |
| 5 | `xpHookForBatchReviews` | POST /review-batch | review_flashcard / review_correct | 5 / 10 ea |
| 6 | `xpHookForVideoComplete` | POST /mux/track-view | complete_video | 20 |
| 7 | `xpHookForRagQuestion` | POST /ai/rag-chat | rag_question | 5 |
| 8 | `xpHookForPlanTaskComplete` | PUT /study-plan-tasks (status→completed) | complete_plan_task + complete_plan | 15 + 100 |

**Note:** `streak_daily` (15 XP) is handled inline in POST /daily-check-in, not via hooks.

---

## XP Table (11 actions)

| Action | Base XP | Notes |
|---|---|---|
| `review_flashcard` | 5 | Any flashcard review |
| `review_correct` | 10 | Correct review (grade ≥ 3) |
| `quiz_answer` | 5 | Any quiz attempt |
| `quiz_correct` | 15 | Correct quiz answer |
| `complete_session` | 25 | Study session completed |
| `complete_reading` | 30 | Summary marked as read |
| `complete_video` | 20 | Video watched to completion |
| `streak_daily` | 15 | Daily login streak |
| `complete_plan_task` | 15 | Study plan task completed |
| `complete_plan` | 100 | Full study plan completed |
| `rag_question` | 5 | RAG AI question asked |

**NO XP for:** notes, annotations (§7.14 overjustification effect)

---

## Bonus System (additive, §10)

| Bonus | Multiplier | Condition | Source |
|---|---|---|---|
| On-Time Review | +50% | FSRS due_at within 24h | Cepeda 2006 |
| Flow Zone | +25% | BKT p_know 0.3-0.7 | Csikszentmihalyi 1990 |
| Variable Reward | +100% (10% chance) | Random | Skinner VR schedule |
| Streak | +50% | 7+ day streak | Duolingo model |

Multipliers are **summed**, not multiplied (§10 Combo rule):
```
base=10, on_time+flow → multiplier = 1.0 + 0.5 + 0.25 = 1.75
final = 10 * 1.75 = 17.5 → 18 XP
```

---

## Level Thresholds

| Level | XP Required |
|---|---|
| 1 | 0 |
| 2 | 100 |
| 3 | 300 |
| 4 | 600 |
| 5 | 1,000 |
| 6 | 1,500 |
| 7 | 2,200 |
| 8 | 3,000 |
| 9 | 4,000 |
| 10 | 5,500 |
| 11 | 7,500 |
| 12 | 10,000 |

---

## DB Tables (7 gamification-specific)

| Table | Type | Key Columns |
|---|---|---|
| `student_xp` | Aggregate | student_id, institution_id, total_xp, current_level, xp_today, daily_goal |
| `xp_transactions` | Log (immutable) | student_id, institution_id, action, xp_base, xp_final, multiplier, bonus_type |
| `student_stats` | Aggregate | student_id, current_streak, longest_streak, total_reviews, total_sessions |
| `badge_definitions` | Catalog | slug, name, category, criteria, xp_reward, icon, rarity |
| `student_badges` | Junction | student_id, badge_id, institution_id |
| `streak_freezes` | Items | student_id, institution_id, freeze_type, xp_cost, used_on |
| `streak_repairs` | Log | student_id, institution_id, repair_cost, repair_date |

**Supporting:**
- `leaderboard_weekly` — Materialized view (refreshed hourly by pg_cron)
- `daily_activities` — Per-day activity log (existing, not gamification-specific)

---

## RPCs (4 gamification-specific)

| RPC | Purpose | Called by |
|---|---|---|
| `award_xp()` | Atomic XP grant + daily cap + level calc | xp-engine.ts |
| `reset_daily_xp()` | Reset xp_today at midnight | pg_cron |
| `reset_weekly_xp()` | Reset xp_this_week Monday | pg_cron |
| `refresh_leaderboard()` | Refresh MV | pg_cron |

---

## Constants (helpers.ts)

| Constant | Value | Contract Value | Notes |
|---|---|---|---|
| `FREEZE_COST_XP` | 100 | 200 | Lower for MVP |
| `MAX_FREEZES` | 3 | 2 | Extra for MVP |
| `REPAIR_BASE_COST_XP` | 200 | 400 | Lower for MVP |
| `DAILY_XP_CAP` | 500 | 500 | Matches |
| `POST_CAP_RATE` | 10% | 10% | Matches |

---

## Engine Files

| File | Purpose | Key Exports |
|---|---|---|
| `xp-engine.ts` | XP calculation + award | `awardXP()`, `XP_TABLE`, `calculateLevel()`, `LEVEL_THRESHOLDS` |
| `streak-engine.ts` | Streak computation | `computeStreakStatus()`, `performDailyCheckIn()` |
| `xp-hooks.ts` | afterWrite hooks | 8 exported hook functions |
| `helpers.ts` | Constants + badge eval | `evaluateSimpleCondition()`, cost constants |
