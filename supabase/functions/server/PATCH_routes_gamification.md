# Patch: routes-gamification.tsx — BUG-2, BUG-3, BUG-8

These 3 bugs are in `routes-gamification.tsx` (53KB). Apply manually or via sed.

---

## BUG-2: `PUT /daily-goal` uses user-scoped `db` instead of admin client

**Risk:** RLS blocks student from upserting their own `student_xp` row.

### Find this code (in the PUT /daily-goal handler):

```typescript
// Current (broken):
const { data, error } = await db.from("student_xp").upsert(
  {
    student_id: user.id,
    institution_id: institutionId,
    daily_goal_minutes: minutes,
    updated_at: new Date().toISOString(),
  },
  { onConflict: "student_id,institution_id" },
);
```

### Replace with:

```typescript
// Fixed: use admin client for student_xp writes (§2.5)
const adminDb = getAdminClient();
const { data, error } = await adminDb.from("student_xp").upsert(
  {
    student_id: user.id,
    institution_id: institutionId,
    daily_goal_minutes: minutes,
    updated_at: new Date().toISOString(),
  },
  { onConflict: "student_id,institution_id" },
);
```

**Also:** Ensure `getAdminClient` is imported at the top of the file:
```typescript
import { getAdminClient } from "./db.ts";
```
(It should already be imported since other endpoints use it.)

---

## BUG-3: `GET /notifications` uses `earned_at` column that may not exist

**Risk:** Query silently fails if column is actually `created_at`.

### Verify first:

```sql
-- Run in Supabase SQL Editor:
SELECT column_name FROM information_schema.columns
WHERE table_name = 'student_badges'
ORDER BY ordinal_position;
```

### If column is `created_at` (most likely), find:

```typescript
// In GET /notifications handler, badges query:
.gte("earned_at", since)
.order("earned_at", { ascending: false })
```

### Replace with:

```typescript
.gte("created_at", since)
.order("created_at", { ascending: false })
```

### And in the badge notification mapping, find:

```typescript
created_at: b.earned_at,
```

### Replace with:

```typescript
created_at: b.created_at,
```

### Alternative — Add `earned_at` column via migration:

If you prefer to keep `earned_at`:

```sql
-- Migration: add earned_at to student_badges
ALTER TABLE student_badges
  ADD COLUMN IF NOT EXISTS earned_at TIMESTAMPTZ DEFAULT now();

-- Backfill from created_at
UPDATE student_badges SET earned_at = created_at WHERE earned_at IS NULL;
```

---

## BUG-8: `POST /streak-repair` restores to `longest_streak` instead of pre-break value

**Risk:** If longest_streak is 50 but the broken streak was 5, repair restores to 50.

### Find this code (in POST /streak-repair handler):

```typescript
const restoredStreak = stats.longest_streak ?? 1;
```

### Option A — Conservative fix (use previous_streak if available):

Requires adding `previous_streak` column to student_stats:

```sql
ALTER TABLE student_stats
  ADD COLUMN IF NOT EXISTS previous_streak INTEGER DEFAULT 0;
```

Then in streak-engine.ts, when breaking a streak, save the old value:
```typescript
// In performDailyCheckIn, when streak breaks:
await db.from("student_stats").upsert({
  student_id: studentId,
  current_streak: decision.newStreak,
  previous_streak: currentStreak, // ← Save pre-break value
  ...
});
```

And in streak-repair:
```typescript
const restoredStreak = stats.previous_streak ?? stats.longest_streak ?? 1;
```

### Option B — Simple fix (cap at reasonable value):

```typescript
// Don't restore to longest_streak if it's way higher than recent activity
// Use last_study_date proximity to estimate pre-break streak
const restoredStreak = Math.min(
  stats.longest_streak ?? 1,
  stats.current_streak > 0 ? stats.current_streak : (stats.longest_streak ?? 1),
);
```

### Option C — Document as intentional:

If longest_streak restoration is a deliberate "reward" for repairing:
```typescript
// DESIGN DECISION: Repair restores to longest_streak as an incentive
// to purchase repairs. This is MORE generous than Duolingo (which
// restores to pre-break value) but aligns with our SDT autonomy goal.
const restoredStreak = stats.longest_streak ?? 1;
```

---

## BUG-5 (Optional): Filter streak XP on break

In `POST /daily-check-in` handler, find:

```typescript
const isNewCheckIn = !result.events.some(e => e.type === "already_checked_in");
if (isNewCheckIn && XP_TABLE.streak_daily) {
```

Replace with:

```typescript
const isNewCheckIn = !result.events.some(e => e.type === "already_checked_in");
const streakBroke = result.events.some(e => e.type === "streak_broken");
if (isNewCheckIn && !streakBroke && XP_TABLE.streak_daily) {
```

This prevents awarding streak XP when the streak was just broken.

---

## Verification Checklist

- [ ] BUG-2: Test `PUT /gamification/daily-goal` with a student user
- [ ] BUG-3: Run SQL to check `student_badges` columns, apply correct fix
- [ ] BUG-5: Test `POST /gamification/daily-check-in` after a 3-day gap
- [ ] BUG-8: Decide on Option A/B/C and implement
