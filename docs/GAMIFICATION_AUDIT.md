# Gamification Audit — Sprint 0-2 Completion

**Date:** 2026-03-13
**Scope:** DB schema (42 tables) + Backend TS code (6 gamification files + xp-engine + streak-engine + xp-hooks)
**Contract Version:** v2.0 (34 rules)
**Status:** 4 CRITICAL DB fixes applied, 7 backend code issues pending

---

## 1. DB Schema Audit (Supabase) — RESOLVED

All 4 CRITICAL issues have been fixed via SQL in Supabase:

| ID | Severity | Table | Issue | Fix Applied |
|---|---|---|---|---|
| AUD-001 | CRITICAL | `student_badges` | Missing `institution_id` — breaks multi-tenancy | Added column + updated UNIQUE constraint |
| AUD-002 | CRITICAL | `streak_freezes` | Missing `freeze_type`, `xp_cost`, `expires_at` — crashes POST /streak-freeze/buy | Added 3 columns with CHECK + defaults |
| AUD-003 | CRITICAL | `streak_repairs` | Missing `institution_id`, `repair_date` | Added both columns |
| AUD-004 | CRITICAL | `award_xp()` RPC | Returns 0 XP post-cap instead of 10% rate (contract S6.4) | Replaced entire function |
| AUD-005 | HIGH | `badge_definitions` | `category` missing CHECK constraint | Added CHECK (study/social/mastery/consistency/exploration) |
| AUD-006 | HIGH | `badge_definitions` | `trigger_config` allows NULL | Set NOT NULL + backfilled |
| AUD-007 | HIGH | `badge_definitions` | Missing `updated_at` column | Added column |
| AUD-008 | MEDIUM | `streak_repairs` | Has `repair_cost` AND `xp_cost` (both exist now) | Note: backend uses `repair_cost` |
| AUD-009 | MEDIUM | `student_xp`, `xp_transactions` | RLS was disabled | Enabled + added SELECT policies |
| AUD-010 | MEDIUM | Cron jobs | Verified existence | 3 jobs confirmed: reset-daily-xp, reset-weekly-xp, refresh-leaderboard |
| AUD-011 | MEDIUM | `student_badges` | Missing `is_featured` | Added column |
| AUD-013 | LOW | `badge_definitions` | Missing slug auto-generation trigger | Created trigger + backfilled |
| AUD-014 | LOW | `badge_definitions` | Missing SELECT RLS policy | Added public read policy |

### Cron Jobs Verified

| Job Name | Schedule | Purpose |
|---|---|---|
| `reset-daily-xp` | `0 0 * * *` | Reset `xp_today` at midnight UTC |
| `reset-weekly-xp` | `0 0 * * 1` | Reset `xp_this_week` every Monday |
| `refresh-leaderboard` | `0 * * * *` | Refresh `leaderboard_weekly` materialized view hourly |

---

## 2. Backend Code Audit (TypeScript) — ACTION REQUIRED

Audited all gamification TS files against the contract and the fixed DB schema.

### Finding G-001: CRITICAL — `streak.ts` freeze INSERT missing columns

**File:** `routes/gamification/streak.ts` (POST /streak-freeze/buy)
**Line:** `~line 155` (the `.insert({...})` block)

**Problem:** The INSERT only includes `student_id` and `institution_id`:
```ts
.insert({
  student_id: user.id,
  institution_id: institutionId,
})
```

Missing `freeze_type` and `xp_cost`. The DB defaults save it from crashing (`freeze_type` defaults to `'purchased'`, `xp_cost` defaults to `0`), but `xp_cost: 0` is wrong — it should record the actual cost paid.

**Fix:**
```ts
.insert({
  student_id: user.id,
  institution_id: institutionId,
  freeze_type: 'purchased',
  xp_cost: FREEZE_COST_XP,
})
```

---

### Finding G-002: CRITICAL — `badges.ts` INSERT missing `institution_id`

**File:** `routes/gamification/badges.ts` (POST /check-badges)
**Line:** `~line 105` (the `.insert({...})` block)

**Problem:** Badge award INSERT doesn't include `institution_id`:
```ts
.insert({
  student_id: user.id,
  badge_id: badge.id,
})
```

The `institution_id` column now exists (AUD-001 fix) but the code doesn't set it. All badges will have `NULL` institution_id, breaking the UNIQUE constraint and multi-tenancy.

**Fix:**
```ts
.insert({
  student_id: user.id,
  badge_id: badge.id,
  institution_id: institutionId,
})
```

---

### Finding G-003: HIGH — `streak.ts` repair INSERT missing `institution_id`

**File:** `routes/gamification/streak.ts` (POST /streak-repair)
**Line:** `~line 225` (the `.insert({...})` block)

**Problem:** Repair log INSERT doesn't include `institution_id` or `repair_date`:
```ts
.insert({
  student_id: user.id,
  repair_cost: repairCost,
  previous_streak: streakToRestore,
  repaired_at: new Date().toISOString(),
})
```

**Fix:**
```ts
.insert({
  student_id: user.id,
  institution_id: institutionId,
  repair_cost: repairCost,
  previous_streak: streakToRestore,
  repair_date: new Date().toISOString().split('T')[0],
  repaired_at: new Date().toISOString(),
})
```

---

### Finding G-004: HIGH — `streak.ts` freeze/repair bypass `award_xp()` RPC

**File:** `routes/gamification/streak.ts`
**Contract:** S7.9 "NUNCA modificar total_xp sin usar el RPC"

**Problem:** Both freeze-buy and streak-repair do direct UPDATE on `student_xp.total_xp` instead of calling `award_xp()` RPC with negative XP:
```ts
// Current (WRONG per contract):
await adminDb.from("student_xp").update({ total_xp: totalXp - FREEZE_COST_XP, ... })

// Also manually inserts xp_transactions separately
await adminDb.from("xp_transactions").insert({...})
```

The `award_xp()` RPC handles both the update and the transaction log atomically. Manual updates bypass the cap logic and could cause race conditions.

**Fix:** Replace the direct update + manual insert with:
```ts
await adminDb.rpc('award_xp', {
  p_student_id: user.id,
  p_institution_id: institutionId,
  p_action: 'streak_freeze_buy',
  p_xp_base: -FREEZE_COST_XP,
  p_multiplier: 1.0,
  p_source_type: 'streak_freeze',
  p_source_id: freeze.id,
});
```

**Risk:** The current code works in practice but (a) bypasses the 10% post-cap logic, (b) has no atomicity guarantee between UPDATE and INSERT, (c) doesn't update `xp_today`/`xp_this_week` for negative XP (which is intentional for purchases but should be documented).

---

### Finding G-005: MEDIUM — `badges.ts` references `icon_url` but column is `icon`

**File:** `routes/gamification/badges.ts` (GET /notifications)
**Line:** `~line 170`

**Problem:**
```ts
.select("badge_id, created_at, badge_definitions(name, slug, icon_url, rarity)")
```

The `badge_definitions` table has column `icon TEXT` (not `icon_url`). PostgREST embedded selects silently return `null` for non-existent columns — so `icon_url` will always be null.

**Fix:** Change `icon_url` to `icon`.

---

### Finding G-006: MEDIUM — `xp-engine.ts` JS fallback ignores daily cap

**File:** `xp-engine.ts` (function `awardXPFallback`)
**Line:** `~line 168`

**Problem:** The JS fallback path doesn't check `xp_today` against the 500 cap:
```ts
const xpFinal = Math.round(xpBase * multiplier); // No cap check!
```

Now that the RPC implements 10% post-cap (AUD-004 fix), the JS fallback should too. Otherwise, if the RPC fails and falls back to JS, students get unlimited XP.

**Fix:** Add cap check before the XP calculation:
```ts
const xpRaw = Math.round(xpBase * multiplier);
const dailyCap = 500;
const currentDaily = existing?.xp_today ?? 0;
let xpFinal: number;

if (xpBase < 0) {
  xpFinal = xpRaw; // Purchases skip cap
} else if (currentDaily >= dailyCap) {
  xpFinal = Math.max(1, Math.round(xpRaw * 0.1)); // 10% post-cap
} else if (currentDaily + xpRaw > dailyCap) {
  xpFinal = dailyCap - currentDaily; // Partial
} else {
  xpFinal = xpRaw; // Full
}
```

---

### Finding G-007: LOW — `helpers.ts` costs differ from plan

**File:** `routes/gamification/helpers.ts`

**Values in code:**
- `FREEZE_COST_XP = 100`
- `MAX_FREEZES = 3`
- `REPAIR_BASE_COST_XP = 200`

**Values in contract/plan:**
- Freeze cost: 200 XP
- Max freezes: 2
- Repair cost: 400 XP

**Assessment:** This may be intentional (lower costs for MVP/early launch). Document the discrepancy and decide with product whether to match the contract values.

---

## 3. Summary Matrix

| ID | Severity | Type | File | Status |
|---|---|---|---|---|
| AUD-001 to AUD-014 | CRITICAL to LOW | DB Schema | Supabase | RESOLVED |
| G-001 | CRITICAL | Backend TS | streak.ts | PENDING — freeze INSERT missing columns |
| G-002 | CRITICAL | Backend TS | badges.ts | PENDING — badge INSERT missing institution_id |
| G-003 | HIGH | Backend TS | streak.ts | PENDING — repair INSERT missing institution_id |
| G-004 | HIGH | Backend TS | streak.ts | PENDING — bypasses award_xp() RPC |
| G-005 | MEDIUM | Backend TS | badges.ts | PENDING — icon_url vs icon column name |
| G-006 | MEDIUM | Backend TS | xp-engine.ts | PENDING — JS fallback ignores daily cap |
| G-007 | LOW | Backend TS | helpers.ts | REVIEW — cost values differ from contract |

### Sprint 3 Blockers

**G-001 and G-002 MUST be fixed before Sprint 3** frontend work begins:
- G-001: Freeze purchase records `xp_cost: 0` (misleading transaction history)
- G-002: Badges awarded without `institution_id` will break the gamification profile endpoint and any institution-scoped badge queries

---

## 4. Gamification Architecture Overview (Post-Audit)

```
Frontend (Sprint 3)
  |
  v
routes/gamification/ (13 endpoints)
  |-- profile.ts    GET /profile, /xp-history, /leaderboard
  |-- badges.ts     GET /badges, POST /check-badges, GET /notifications
  |-- streak.ts     GET /streak-status, POST /daily-check-in, /streak-freeze/buy, /streak-repair
  |-- goals.ts      PUT /daily-goal, POST /goals/complete, /onboarding
  |-- helpers.ts    Constants + evaluateSimpleCondition
  |-- index.ts      Module combiner
  |
xp-engine.ts        awardXP() + XP_TABLE + calculateLevel()
  |
streak-engine.ts    computeStreakStatus() + performDailyCheckIn()
  |
xp-hooks.ts         8 afterWrite hooks (11/11 XP actions)
  |
  v
award_xp() RPC      Atomic XP grant + daily cap (500) + 10% post-cap + level calc
  |
  v
DB Tables:
  student_xp          -- XP aggregates (per student per institution)
  xp_transactions     -- Immutable XP log
  student_stats       -- Streak + activity counters
  badge_definitions   -- Admin-managed badge catalog
  student_badges      -- Earned badges (now with institution_id)
  streak_freezes      -- Purchasable streak protection (now with freeze_type + xp_cost)
  streak_repairs      -- Streak repair log (now with institution_id + repair_date)
  leaderboard_weekly  -- Materialized view (refreshed hourly)
```
