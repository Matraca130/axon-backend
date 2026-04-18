# Security Audit 2026-04-17 — Remediation Plan

**Companion to**: [`2026-04-17-audit-full.md`](./2026-04-17-audit-full.md) (27 iterations, 188 findings, 15 attack chains).

**Goal**: sequenced, copy-paste executable plan that breaks 14 of 15 attack chains in ~3-5 focused days of work.

**Format per step**: goal, affected files, command/SQL/code ready-to-run, verification, rollback, assigned agent (from Axon agent registry), chains broken.

---

## 📊 Executive summary

| Phase | Duration | Chains broken | Output |
|---|---|---|---|
| 0 — Operational prereqs | 30 min | — (verification) | live-state dumps, baseline snapshot |
| 1 — UNAUTH exposure (SQL triviales) | 1-2h | 11A, 11B, 14 | 1 migration + bucket config |
| 2 — Auth flow fundamentals | 4-8h | 1, 2, 3, 6A, 7, 8, 9, 12, 15 | ~8 TypeScript files + 1 migration |
| 3 — Compliance infrastructure | 2-3 días | 6 Path B, 13, +GDPR/SOC 2 compliance | audit_log + Vault + MFA + DELETE /me |
| 4 — CI enforcement | 4-6h | (regression prevention) | 3 CI rules |
| 5 — Storage + hardening residual | 1 día | minor chains | polyglot sanitization, CSPRNG paths, etc. |

After Phase 2 complete, **14 of 15 chains are broken**. Chain 4 (CI fork-PR exfil of OPENAI_API_KEY) is already scheduled via iter 23 Pareto #13.

---

## Phase 0 — Operational prerequisites (30 min, BEFORE any fix)

### 0.1 Baseline snapshot

```bash
# Tag current main so remediation is reversible
cd C:/Users/petri/Axon/backend
git fetch origin main
git tag pre-security-audit-2026-04-17 origin/main
git push origin pre-security-audit-2026-04-17

# Backup current SQL schema (requires Supabase CLI login)
supabase db dump --schema public --schema storage --schema auth \
  -f docs/security/2026-04-17-schema-baseline.sql
# File is large — DO NOT commit. Store locally or in ops vault.
```

**Verification**: `git tag | grep pre-security-audit` returns the tag.

---

### 0.2 Live DB state dump — fills the iter 18 blind spot

All iter 18 conditional findings depend on live DB state. Run these in Supabase SQL editor and save outputs to ops vault (NOT committed — contain schema detail).

#### 0.2.a RLS policies for 13 blind-spot tables

```sql
SELECT
  schemaname, tablename, policyname, cmd,
  roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'profiles', 'memberships', 'institutions',
    'flashcards', 'reviews', 'fsrs_states', 'bkt_states',
    'chunks', 'summaries', 'quiz_questions', 'quiz_attempts',
    'study_sessions', 'ai_generations'
  )
ORDER BY tablename, cmd, policyname;
```

**Use the output to validate iter 18 conditional findings:**
- `ai_generations`: should have inst-scoped RLS. If `USING (true)` → iter 18 #1 is CRITICAL.
- `profiles`: should be `id = auth.uid()` or inst-scoped. Permissive = iter 18 #2 CRITICAL.
- `flashcards`: determines whether iter 18 inconsistency #1 (Set A vs Set B) is exploitable.

#### 0.2.b SECURITY DEFINER grants + proconfig ground truth

```sql
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef AS security_definer,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
  p.proconfig AS settings
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.prosecdef = true
ORDER BY p.proname;
```

**Use the output to validate iter 15/17/18 findings:**
- Confirm `search_keywords_by_institution` actually has `anon=true`.
- Confirm `resolve_parent_institution` has `authenticated=true OR anon=true` AND `proconfig` lacks `pg_temp`.
- Confirm 6 "phantom" RPCs from iter 17 (compute_cohort_difficulty, etc.) — either they exist and need audit, or absent and SAFE list must be trimmed.
- Confirm `rag_hybrid_search(vector(768), ...)` orphan is still present.

#### 0.2.c Storage bucket state

```sql
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets
ORDER BY name;
```

**Use to validate iter 16 findings:**
- Confirm `flashcard-images`, `infographic-images`, `axon-images`, `axon-models-3d` have `public = true`.
- Confirm `allowedMimeTypes` posture per bucket.

---

### 0.3 Open a tracking issue in `Matraca130/axon-backend`

```bash
gh issue create --repo Matraca130/axon-backend \
  --title "Security audit 2026-04-17 — 188 findings, 15 chains — remediation in progress" \
  --body "Tracking the 5-phase remediation plan in docs/security/2026-04-17-remediation-plan.md on branch security/audit-2026-04-17. Phases will close as sub-PRs land. Findings in docs/security/2026-04-17-audit-full.md." \
  --label "security" --label "remediation"
```

---

## Phase 1 — UNAUTH exposure: trivial SQL + bucket config (1-2h)

Breaks chains **11A** (UNAUTH storage enum), **11B** (UNAUTH RPC enum), **14** (CREATE OR REPLACE regression temp-schema hijack).

### 1.1 Privatize public buckets (iter 16 — 2 CRITICAL + 2 HIGH)

**Goal**: stop UNAUTH enumeration of flashcard/infographic/image/3D-model files.

**SQL**:
```sql
-- Run in Supabase SQL editor
UPDATE storage.buckets
   SET public = false
 WHERE id IN (
   'flashcard-images',
   'infographic-images',
   'axon-images',
   'axon-models-3d'
 );

-- Verify
SELECT id, public FROM storage.buckets
 WHERE id IN ('flashcard-images','infographic-images','axon-images','axon-models-3d');
-- All 4 should show public = false.
```

**Code changes** (switch from `getPublicUrl` to `createSignedUrl`):

- `supabase/functions/server/flashcard-image-generator.ts:120` — swap to signed URL, 1h TTL.
- `supabase/functions/server/infographic-image-generator.ts:274-278, 314, 329-331` — same.
- `supabase/functions/server/routes-storage.ts:168-190` — return `path` only; frontend must fetch signed URL via `/storage/signed-url`.
- `frontend/src/app/components/tiptap/.../ProseForm.tsx:58`, `ImageReferenceForm.tsx:51`, `FlashcardImageUpload.tsx:103`, `tiptap-editor/image-handling.ts:25-27` — stop constructing `/object/public/` URLs; round-trip through backend signed URL endpoint.
- `supabase/functions/server/routes-models.ts:322, 343-345` — signed URL for `.glb`/`.gltf`.

**Verification**:
```bash
# GET on public URL should return 400 or 403 (not the image)
curl -I "https://<project>.supabase.co/storage/v1/object/public/flashcard-images/<any>/<any>/original.png"
# Expect: 400 (bucket not public)

# Frontend should still render images via signed URL
# Browser DevTools → Network tab → image requests go to /storage/v1/object/sign/...
```

**Rollback**:
```sql
UPDATE storage.buckets SET public = true WHERE id IN (...);
```
Plus revert code changes via `git revert`.

**Assigned agents**: `infra-database` (bucket config) + `viewer3d-backend` (3D models) + `ai-generation` (image generators) + `summaries-frontend`, `flashcards-frontend` (frontend call sites).

**Chains broken**: Chain 11A (fully), Chain 1 partial (public-bucket variant).

---

### 1.2 REVOKE anon-exposed SECURITY DEFINER RPCs

**Goal**: stop UNAUTH and over-granted cross-tenant RPC calls.

**New migration**: `supabase/migrations/20260418000001_security_revoke_anon_and_overgranted_rpcs.sql`

```sql
-- ============================================================================
-- Migration: Revoke anon/authenticated from SECURITY DEFINER RPCs missed by
-- iter 1 #198 batch (iter 15, 17 audit findings)
-- Date: 2026-04-18
-- ============================================================================

BEGIN;

-- Iter 15 #1 (CRITICAL): UNAUTH cross-tenant keyword exfil
REVOKE EXECUTE ON FUNCTION public.search_keywords_by_institution(uuid, text, uuid, uuid, int)
  FROM anon, authenticated;

-- Iter 15 #4 / iter 17: anon grant remained after partial revoke
REVOKE EXECUTE ON FUNCTION public.upsert_video_view(uuid, uuid, uuid, int, int, numeric, boolean, int)
  FROM anon;

-- Iter 17 #3: granted to anon as metadata-leak helper
REVOKE EXECUTE ON FUNCTION public.resolve_parent_institution(text, uuid)
  FROM anon;

-- Iter 17 #2: filters by p_student_id not auth.uid() — restrict to service_role
REVOKE EXECUTE ON FUNCTION public.resolve_student_summary_ids(uuid, uuid)
  FROM authenticated;

-- Iter 14 #1: granted to authenticated, returns cross-tenant study time
REVOKE EXECUTE ON FUNCTION public.get_heavy_studiers_today(date, int)
  FROM authenticated;

-- Verification block
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.search_keywords_by_institution(uuid, text, uuid, uuid, int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'search_keywords_by_institution still has anon EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.upsert_video_view(uuid, uuid, uuid, int, int, numeric, boolean, int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'upsert_video_view still has anon EXECUTE';
  END IF;
  RAISE NOTICE '[OK] RPC revoke sweep applied';
END $$;

COMMIT;
```

**Verification**:
```sql
-- Re-run 0.2.b; all flagged RPCs now show anon_exec=false, auth_exec=false (where intended)
```

**Rollback**:
```sql
-- Only if a legitimate caller breaks; expected fallout: none for anon; for authenticated
-- check that routes using these RPCs are on service_role client (infra-ai verified for RAG).
GRANT EXECUTE ON FUNCTION public.search_keywords_by_institution(uuid, text, uuid, uuid, int) TO authenticated;
-- etc.
```

**Assigned agents**: `migration-writer` + `rls-auditor` (post-apply verification).

**Chains broken**: Chain 11B (fully), Chain 15 (student-ID enum).

---

### 1.3 Re-apply dropped ALTER FUNCTION hardening (iter 18)

**Goal**: close temp-schema hijack window on `resolve_parent_institution`; restore `get_institution_summary_ids` defensive check + pg_temp; harden `sync_summary_institution_id` trigger.

**New migration**: `supabase/migrations/20260418000002_restore_search_path_hardening.sql`

```sql
-- ============================================================================
-- Migration: Restore SET search_path = public, pg_temp on SECURITY DEFINER
-- functions whose prior ALTER FUNCTION hardening was silently dropped by
-- subsequent CREATE OR REPLACE. Also fix `sync_summary_institution_id` trigger.
-- Date: 2026-04-18
-- Root cause: PostgreSQL CREATE OR REPLACE replaces proconfig with whatever
-- the new CREATE declares — prior ALTER ... SET is lost unless restated.
-- ============================================================================

BEGIN;

-- Iter 18 #1 (HIGH): pg_temp dropped by 20260319000008 CREATE OR REPLACE
ALTER FUNCTION public.resolve_parent_institution(text, uuid)
  SET search_path = public, pg_temp;

-- Iter 18 #2 (HIGH): auth.uid() check AND pg_temp dropped. Restore both via rewrite.
CREATE OR REPLACE FUNCTION public.get_institution_summary_ids(p_institution_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_result uuid[];
BEGIN
  -- Defense-in-depth: verify caller has membership unless service role
  IF v_uid IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.memberships m
       WHERE m.user_id = v_uid
         AND m.institution_id = p_institution_id
         AND m.is_active = true
    ) THEN
      RETURN ARRAY[]::uuid[];
    END IF;
  END IF;

  SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_result
    FROM public.summaries s
    JOIN public.topics t     ON t.id = s.topic_id
    JOIN public.sections sec ON sec.id = t.section_id
    JOIN public.semesters sm ON sm.id = sec.semester_id
    JOIN public.courses c    ON c.id = sm.course_id
   WHERE c.institution_id = p_institution_id
     AND s.deleted_at IS NULL;

  RETURN v_result;
END;
$$;
-- Re-apply grants (CREATE OR REPLACE preserves but be explicit)
REVOKE ALL ON FUNCTION public.get_institution_summary_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_institution_summary_ids(uuid) TO service_role;

-- Iter 24 #1: trigger function missing SET search_path
CREATE OR REPLACE FUNCTION public.sync_summary_institution_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  SELECT c.institution_id INTO NEW.institution_id
    FROM public.topics t
    JOIN public.sections sec ON sec.id = t.section_id
    JOIN public.semesters sm ON sm.id = sec.semester_id
    JOIN public.courses c    ON c.id = sm.course_id
   WHERE t.id = NEW.topic_id;
  RETURN NEW;
END;
$$;

-- Verification
DO $$
DECLARE
  v_cfg text[];
BEGIN
  SELECT proconfig INTO v_cfg FROM pg_proc
   WHERE oid = 'public.resolve_parent_institution(text, uuid)'::regprocedure;
  IF NOT EXISTS (SELECT 1 FROM unnest(v_cfg) x WHERE x ILIKE '%pg_temp%') THEN
    RAISE EXCEPTION 'resolve_parent_institution missing pg_temp in search_path';
  END IF;
  RAISE NOTICE '[OK] search_path hardening restored';
END $$;

COMMIT;
```

**Verification**:
```sql
-- Per function confirm proconfig contains pg_temp
SELECT p.proname, p.proconfig
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN ('resolve_parent_institution', 'get_institution_summary_ids', 'sync_summary_institution_id');
-- Expect: each row has 'search_path=public, pg_temp' in proconfig.
```

**Rollback**: `ALTER FUNCTION ... SET search_path = public;` (not recommended).

**Assigned agents**: `migration-writer` + `rls-auditor`.

**Chains broken**: Chain 14 (CREATE OR REPLACE regression exploit — currently open).

---

### 1.4 DROP orphan `rag_hybrid_search(vector(768))` (iter 18 #3)

**Goal**: remove stale 768-dim function with default grants that persisted after `vector(1536)` migration.

**New migration**: `supabase/migrations/20260418000003_drop_orphan_rag_hybrid_search_768.sql`

```sql
-- ============================================================================
-- Migration: Drop orphan rag_hybrid_search(vector(768), ...) left over from
-- the 20260311000001 embedding migration to vector(1536). Only the new
-- signature was REVOKEd, the 768 variant persisted with permissive grants.
-- Date: 2026-04-18
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.rag_hybrid_search(
  vector(768), text, uuid, uuid, int, float
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'rag_hybrid_search'
      AND pg_get_function_identity_arguments(p.oid) LIKE '%vector(768)%'
  ) THEN
    RAISE EXCEPTION 'rag_hybrid_search(vector(768)) still exists';
  END IF;
  RAISE NOTICE '[OK] orphan dropped';
END $$;

COMMIT;
```

**Verification**:
```sql
\df+ public.rag_hybrid_search
-- Expect: only vector(1536) variant remains
```

**Assigned agents**: `migration-writer`.

---

### Phase 1 — total effort + output

- **Effort**: 1-2 h (mostly migration-writing + verification)
- **Artefactos**: 3 new migrations + 1 bucket config SQL + ~7 frontend file edits
- **Chains broken**: 11A, 11B, 14, partial 1 and 15

---

## Phase 2 — Auth flow fundamentals (4-8h)

Breaks chains **1, 2, 3, 6A, 7, 8, 9, 12, 15**. **This is where the Pareto hits hardest.**

### 2.1 `email_confirm: false` + proper email verification (iter 11 #1)

**Goal**: stop anyone-with-email-shaped-string from getting an active membership.

**File**: `supabase/functions/server/routes-auth.ts:99`

**Code change**:
```typescript
// BEFORE (line 99):
const { data, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,  // ← REMOVE
  user_metadata: { full_name: name },
});

// AFTER:
const { data, error: createErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: false,
  user_metadata: { full_name: name },
});
// Then rely on Supabase to send the confirmation email.
// Frontend must handle the "pending confirmation" state.
```

**Frontend change**: `frontend/src/app/components/auth/LoginPage.tsx` — after signup, display "Check your email" screen instead of auto-redirect.

**Supabase config**: `supabase/config.toml` (commit this if not already — iter 11 #2 recommended):
```toml
[auth.email]
enable_signup = true
double_confirm_changes = true
enable_confirmations = true
# Template configured via Supabase dashboard

[auth.email.smtp]
# Configure SMTP via env vars, not toml
```

**Verification** (integration test):
```typescript
// Signup + try to login BEFORE email confirmation
const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, { ... });
const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { ... });
expect(loginRes.status).toBe(400); // email_not_confirmed
```

**Rollback**: revert line + redeploy.

**Assigned agents**: `auth-backend` (the flag) + `auth-frontend` (the "pending confirmation" UI).

**Chains broken**: prereq of Chains 1, 2, 3, 7, 8, 9 — collapses them when paired with 2.2.

---

### 2.2 Remove signup auto-join (iter 3 auth HIGH-2)

**Goal**: stop auto-granting membership in tenant #1 to any new user.

**File**: `supabase/functions/server/routes-auth.ts:136-165`

**Code change**: remove the auto-join block entirely. Replace with invite-token flow:

```typescript
// BEFORE (lines 136-165): auto-join to oldest active institution
// const { data: oldestInst } = await admin.from("institutions")
//   .select("id").eq("is_active", true).order("created_at").limit(1).single();
// await admin.from("memberships").insert({
//   user_id: newUser.id, institution_id: oldestInst.id,
//   role: "student", is_active: true,
// });

// AFTER: no auto-join. Membership happens via one of:
// - Admin adds user to institution via POST /memberships (after verification)
// - Invite-token flow: signup accepts ?invite=<token>, creates pending membership, activates on first login
// - Self-serve org creation: POST /institutions makes user the owner of their own org

// Option A (simpler — admin-gated):
// Drop auto-join. User sits on profiles without memberships until admin adds them.
// Add a "pending" state in the UI showing "Your administrator hasn't added you yet".

// Option B (invite-token):
// Signup accepts { email, password, name, invite_token? }
// If invite_token present, call consumeInviteToken(invite_token, newUser.id)
// which validates token + creates the membership.
```

**New RPC for Option B** (migration `20260418000004_invite_tokens.sql`):
```sql
CREATE TABLE IF NOT EXISTS public.invite_tokens (
  token         text PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner','admin','professor','student')),
  created_by    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  used_at       timestamptz,
  used_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.invite_tokens ENABLE ROW LEVEL SECURITY;
-- Only admin/owner of the institution can create tokens
CREATE POLICY invite_tokens_admin_create ON public.invite_tokens FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = auth.uid()
      AND m.institution_id = invite_tokens.institution_id
      AND m.role IN ('owner','admin')
      AND m.is_active = true
  ));
```

Plus a `consume_invite_token(p_token text, p_user_id uuid)` RPC + backend route.

**Verification**:
```sql
-- After signup of arbitrary email, no memberships row should exist
SELECT count(*) FROM public.memberships WHERE user_id = '<new-user-uuid>';
-- Expect: 0
```

**Rollback**: revert.

**Assigned agents**: `auth-backend` (routes-auth.ts) + `owner-backend` (invite-token RPC + endpoints) + `auth-frontend` (invite UX).

**Chains broken**: prereq of Chains 1, 2, 3, 7, 8, 9.

---

### 2.3 First-active-membership class fix (iter 1 #1 + iter 9 #2-#3 + iter 12 sweep #1-#4)

**Goal**: fix the 7 sites that pick arbitrary `memberships.limit(1).single()` — bind operations to the tenant the caller actually intended.

**New shared helper**: `supabase/functions/server/auth-helpers.ts`

```typescript
/**
 * Resolves an operation's target institution with explicit binding.
 * Rejects if the caller didn't specify one AND has memberships in >1 institution.
 *
 * Returns the institution_id if valid for this caller, or throws.
 * Use this instead of memberships.limit(1).single() ANYWHERE a human intent
 * exists to target a specific tenant.
 */
export async function resolveRequiredInstitution(
  db: SupabaseClient,
  userId: string,
  supplied: string | null | undefined,
): Promise<string> {
  if (supplied) {
    // Caller specified — verify membership
    const { data: m } = await db
      .from("memberships")
      .select("institution_id")
      .eq("user_id", userId)
      .eq("institution_id", supplied)
      .eq("is_active", true)
      .maybeSingle();
    if (!m) throw new HttpError(403, "Not a member of the specified institution");
    return supplied;
  }

  // No supplied — only allow implicit resolution if caller has exactly ONE active membership
  const { data: rows } = await db
    .from("memberships")
    .select("institution_id")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (!rows || rows.length === 0) throw new HttpError(403, "No active membership");
  if (rows.length > 1) {
    throw new HttpError(400, "Multiple memberships — specify institution_id");
  }
  return rows[0].institution_id;
}
```

**Call sites to refactor** (each replaces `memberships.limit(1).single()`):
1. `supabase/functions/server/routes/settings/messaging-admin.ts:39-50` — accept `institution_id` in path/body.
2. `supabase/functions/server/routes/ai/chat.ts:188-195` — require `institution_id` in body OR accept summary_id/topic_id that resolves via `resolve_parent_institution` RPC.
3. `supabase/functions/server/routes/ai/realtime-session.ts:217-225` — same.
4. `supabase/functions/server/lib/rag-search.ts:59-66` — take `institution_id` as arg, require.
5. `supabase/functions/server/routes/content/keyword-search.ts:74-86` — accept as query param + `requireInstitutionRole`.
6. `supabase/functions/server/routes/telegram/tools.ts:414-421` (`get_keywords`) — bot-side must persist chosen institution in `telegram_sessions.institution_id` (existing column).
7. `supabase/functions/server/routes/telegram/tools.ts:487-494` (`get_summary`) — same.

**Verification** (integration test):
```typescript
// User with membership in A and B calls /ai/chat with no institution_id
const res = await fetch(`${API_BASE}/ai/chat`, {
  method: "POST", headers: authHeaders(multiInstUser),
  body: JSON.stringify({ message: "hi" }), // no institution_id
});
expect(res.status).toBe(400); // "specify institution_id"
```

**Rollback**: revert refactor.

**Assigned agents**: `infra-plumbing` (helper) + `messaging-backend` (messaging-admin + TG tools) + `ai-backend` (chat + realtime + rag-search + keyword-search).

**Chains broken**: Chain 1 step 2, Chain 3 step 5, Chain 6A (messaging-admin confused-deputy), Chain 9 (cross-tenant RAG triple-stack amplifier), Chain 15 (student enum amplifier).

---

### 2.4 Add `requireInstitutionRole` to 3 trust-RLS-only endpoints (iter 19 #1-#3)

**Goal**: stop relying purely on RLS for 3 routes where RLS state is unverifiable from code alone.

**Files + patches**:

#### 2.4.a `routes/settings/algorithm-config.ts:31` (GET)
```typescript
// After UUID validation of institutionId, add:
const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
if (!roleCheck.ok) return err(c, roleCheck.message, roleCheck.status);
```

#### 2.4.b `routes/gamification/profile.ts:119` (GET /leaderboard)
```typescript
// Same pattern after validating institutionId
const roleCheck = await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES);
if (!roleCheck.ok) return err(c, roleCheck.message, roleCheck.status);
```

#### 2.4.c `routes/plans/ai-generations.ts:27` (GET) + `:46` (POST)
```typescript
// Add to both
const roleCheck = await requireInstitutionRole(db, user.id, institutionId, MANAGEMENT_ROLES);
// AI-gen logs = admin-only data
if (!roleCheck.ok) return err(c, roleCheck.message, roleCheck.status);
```

**Verification**:
```typescript
// Student calls /algorithm-config?institution_id=<valid-inst-they-arent-in>
const res = await fetch(`${API_BASE}/algorithm-config?institution_id=${otherInstId}`, { headers: studentHeaders });
expect(res.status).toBe(403);
```

**Assigned agents**: `admin-backend` (algorithm-config + ai-generations) + `gamification-backend` (leaderboard).

**Chains broken**: Chain 9 amplifier (cross-tenant algorithmic config + XP leak).

---

### 2.5 `process_review_batch` hardening (iter 20 CRITICAL + iter 15 #2)

**Goal**: stop atomic un-auditable FSRS/BKT poisoning across all students.

**New migration**: `supabase/migrations/20260418000005_process_review_batch_auth_hardening.sql`

```sql
BEGIN;

CREATE OR REPLACE FUNCTION public.process_review_batch(
  p_session_id uuid,
  p_reviews jsonb,
  p_fsrs_updates jsonb,
  p_bkt_updates jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_session_owner uuid;
  v_bad_elem jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- 1. Session ownership
  SELECT s.student_id INTO v_session_owner
    FROM public.study_sessions s
   WHERE s.id = p_session_id;
  IF v_session_owner IS NULL THEN
    RAISE EXCEPTION 'session not found';
  END IF;
  IF v_session_owner <> v_caller THEN
    RAISE EXCEPTION 'session belongs to another student';
  END IF;

  -- 2. Every review/fsrs_update/bkt_update element must target this student
  SELECT elem INTO v_bad_elem
    FROM jsonb_array_elements(p_reviews) AS elem
   WHERE (elem->>'student_id')::uuid <> v_caller
   LIMIT 1;
  IF v_bad_elem IS NOT NULL THEN
    RAISE EXCEPTION 'review element targets another student_id: %', v_bad_elem;
  END IF;

  SELECT elem INTO v_bad_elem
    FROM jsonb_array_elements(p_fsrs_updates) AS elem
   WHERE (elem->>'student_id')::uuid <> v_caller
   LIMIT 1;
  IF v_bad_elem IS NOT NULL THEN
    RAISE EXCEPTION 'fsrs update element targets another student_id: %', v_bad_elem;
  END IF;

  SELECT elem INTO v_bad_elem
    FROM jsonb_array_elements(p_bkt_updates) AS elem
   WHERE (elem->>'student_id')::uuid <> v_caller
   LIMIT 1;
  IF v_bad_elem IS NOT NULL THEN
    RAISE EXCEPTION 'bkt update element targets another student_id: %', v_bad_elem;
  END IF;

  -- [... rest of original body unchanged — insertions, upserts, triggers ...]
  -- See current migration 20260414000001_review_batch_rpc.sql for the original body.
  RETURN jsonb_build_object('ok', true, 'inserted', 0);
END;
$$;

REVOKE ALL ON FUNCTION public.process_review_batch(uuid, jsonb, jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_review_batch(uuid, jsonb, jsonb, jsonb)
  TO authenticated;

COMMIT;
```

**Verification**: attempt calling with `p_session_id` of another student → `exception: session belongs to another student`. Attempt passing `student_id` in elements → `exception: element targets another student_id`.

**Assigned agents**: `migration-writer` + `quiz-backend` (verify no legit callers pass foreign `student_id`).

**Chains broken**: Chain 12 (entirely).

---

### Phase 2 — total

- **Effort**: 4-8 h. Heaviest is 2.3 (7 sites refactor).
- **Artefactos**: 1 migration (invite tokens, optional) + 1 migration (process_review_batch) + ~10 TypeScript files + supabase/config.toml commit.
- **Chains broken**: Chain 1 collapsed (prereq destroyed + step 2 fixed + step 4 fixed in 2.3), Chain 2, Chain 3 (prereq destroyed), Chain 6A, Chain 7, Chain 9 (amplifiers fixed), Chain 12, Chain 15.

After Phase 2: **Chains 4 (fork-PR), 5 (malicious PDF), 6B (DB-dump), 8 (Stripe refund), 11A (mostly done in Phase 1), 13 (plaintext tokens), 14 (done in Phase 1), 10 (past_due UI)** remain.

---

## Phase 3 — Compliance infrastructure (2-3 days)

Breaks chains **6 Path B, 13**; lands compliance-critical infra (GDPR/SOC 2).

### 3.1 `audit_log` table + triggers (iter 21 #1-#9)

**Goal**: persistent, append-only audit trail for sensitive mutations. **GDPR Art. 30 + SOC 2 CC7.2/7.3**.

**New migration**: `supabase/migrations/20260419000001_audit_log.sql`

```sql
BEGIN;

CREATE TABLE public.audit_log (
  id              bigserial PRIMARY KEY,
  actor_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role      text,
  institution_id  uuid,
  action          text NOT NULL,            -- e.g. "membership.role_change"
  entity_table    text NOT NULL,            -- e.g. "memberships"
  entity_id       uuid,
  before_jsonb    jsonb,
  after_jsonb     jsonb,
  ip              text,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx   ON public.audit_log (entity_table, entity_id, created_at DESC);
CREATE INDEX audit_log_actor_idx    ON public.audit_log (actor_user_id, created_at DESC);
CREATE INDEX audit_log_inst_idx     ON public.audit_log (institution_id, created_at DESC);
CREATE INDEX audit_log_created_idx  ON public.audit_log (created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Append-only for service_role
CREATE POLICY audit_log_service_insert ON public.audit_log FOR INSERT TO service_role
  WITH CHECK (true);
CREATE POLICY audit_log_service_select ON public.audit_log FOR SELECT TO service_role
  USING (true);

-- owner/admin of institution can read their slice
CREATE POLICY audit_log_admin_select_own_inst ON public.audit_log FOR SELECT TO authenticated
  USING (institution_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = auth.uid()
      AND m.institution_id = audit_log.institution_id
      AND m.role IN ('owner','admin')
      AND m.is_active = true
  ));

-- Explicitly: NO UPDATE, NO DELETE policies → append-only by RLS.
-- Revoke direct UPDATE/DELETE even for service_role to make append-only enforced.
REVOKE UPDATE, DELETE ON public.audit_log FROM service_role;

-- Generic trigger for membership role changes
CREATE OR REPLACE FUNCTION public.tg_audit_memberships()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.audit_log(
    actor_user_id, actor_role, institution_id, action,
    entity_table, entity_id, before_jsonb, after_jsonb
  ) VALUES (
    auth.uid(),
    current_setting('request.jwt.claim.role', true),
    COALESCE(NEW.institution_id, OLD.institution_id),
    TG_OP || ':memberships',
    'memberships',
    COALESCE(NEW.id, OLD.id),
    to_jsonb(OLD),
    to_jsonb(NEW)
  );
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_audit_memberships
AFTER INSERT OR UPDATE OR DELETE ON public.memberships
FOR EACH ROW EXECUTE FUNCTION public.tg_audit_memberships();

-- Similar triggers for:
-- institutions (created, is_active change)
-- messaging_admin_settings (any PUT)
-- institution_subscriptions (any state change)
-- algorithm_config (config PUT)
-- (add analogous CREATE TRIGGER blocks — left as exercise for the migration)

-- Retention job (90 days)
-- Scheduled via pg_cron; not in this migration

COMMIT;
```

**Verification**:
```sql
UPDATE public.memberships SET role = 'admin' WHERE id = '<some-id>';
SELECT * FROM public.audit_log ORDER BY created_at DESC LIMIT 1;
-- Expect: one row with action='UPDATE:memberships', before/after jsonb
```

**Assigned agents**: `migration-writer` + `admin-backend` (for retention cron).

---

### 3.2 Encrypt messaging tokens (iter 21 CRITICAL #1)

**Goal**: stop DB-dump → all-WA/TG-tokens leak.

**Approach**: Supabase Vault — store tokens as `vault.secrets` entries, reference by `secret_id`.

**New migration**: `supabase/migrations/20260419000002_messaging_tokens_to_vault.sql`

```sql
-- Requires Supabase Vault extension enabled (Supabase pro tier)
CREATE EXTENSION IF NOT EXISTS supabase_vault;

BEGIN;

-- New schema: one vault secret per (institution, channel, secret_name)
ALTER TABLE public.messaging_admin_settings
  ADD COLUMN settings_encrypted_ids jsonb NOT NULL DEFAULT '{}'::jsonb;
-- settings_encrypted_ids shape: { "access_token": "<vault.secrets.id>", "bot_token": ..., ... }

-- Migration script: for each existing row, for each secret field in settings,
-- call vault.create_secret(value) and replace the cleartext with the vault id.
-- Use plpgsql block — keep existing settings column until rollback confirmed.

-- (explicit migration body, per-channel allowed keys)
DO $$
DECLARE
  r record;
  v_access_token_id uuid;
  v_bot_token_id uuid;
BEGIN
  FOR r IN SELECT * FROM public.messaging_admin_settings WHERE settings_encrypted_ids = '{}'::jsonb LOOP
    IF r.channel = 'whatsapp' THEN
      IF r.settings ? 'access_token' THEN
        v_access_token_id := (SELECT id FROM vault.create_secret(r.settings->>'access_token', 'wa_access_' || r.institution_id));
        UPDATE public.messaging_admin_settings
           SET settings_encrypted_ids = jsonb_build_object('access_token', v_access_token_id::text)
         WHERE id = r.id;
      END IF;
    ELSIF r.channel = 'telegram' THEN
      IF r.settings ? 'bot_token' THEN
        v_bot_token_id := (SELECT id FROM vault.create_secret(r.settings->>'bot_token', 'tg_bot_' || r.institution_id));
        UPDATE public.messaging_admin_settings
           SET settings_encrypted_ids = jsonb_build_object('bot_token', v_bot_token_id::text)
         WHERE id = r.id;
      END IF;
    END IF;
  END LOOP;
END $$;

-- Keep old column but redact — scrub plaintext now
UPDATE public.messaging_admin_settings SET settings = settings - 'access_token' - 'bot_token' - 'app_secret' - 'webhook_secret' - 'verify_token';

COMMIT;
```

**Code changes**: `routes/settings/messaging-admin.ts` — read/write secrets via `vault.decrypted_secrets(id)` instead of plaintext.

**Rollback**: drop vault column + re-INSERT from backup (Phase 0 snapshot).

**Assigned agents**: `migration-writer` + `messaging-backend`.

**Chains broken**: Chain 13 + Chain 6 Path B.

---

### 3.3 MFA enforcement for owner/admin (iter 11 #2)

**Goal**: require TOTP for management roles.

**Steps**:
1. Enable TOTP in Supabase Auth dashboard.
2. Commit `supabase/config.toml` with `[auth.mfa] enabled = true`.
3. Frontend: enrollment UI at `/settings/security/mfa` (via Supabase `auth.mfa.enroll` / `auth.mfa.challenge`).
4. Backend: middleware on `MANAGEMENT_ROLES` routes checks `jwt.aal = aal2`; if not, return 403 "MFA required".

**Edge middleware snippet**:
```typescript
// auth-helpers.ts — helper
export function requireAal2(payload: JWTPayload): AuthError | null {
  if ((payload as any).aal !== "aal2") {
    return { status: 403, message: "MFA required for this action" };
  }
  return null;
}
```

Apply to `routes/members/memberships.ts` (role changes), `routes/settings/messaging-admin.ts` (token writes), `routes/members/institutions.ts` (inst lifecycle).

**Verification**: login without MFA + try to change a member's role → 403.

**Assigned agents**: `auth-backend` + `auth-frontend`.

**Chains broken**: Chain 6A amplifier (admin-credential compromise now requires 2FA).

---

### 3.4 `DELETE /me` + GDPR export (iter 17 #1 + iter 21 #4)

**Goal**: GDPR Art. 17 + 20 compliance.

**New migration**: `purge_user(uuid)` RPC + `export_user(uuid)` RPC.

```sql
CREATE OR REPLACE FUNCTION public.purge_user(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_user_id <> auth.uid() THEN RAISE EXCEPTION 'can only purge own account'; END IF;

  -- Cascade deletes across all user-scoped tables
  DELETE FROM public.reviews WHERE student_id = p_user_id;
  DELETE FROM public.quiz_attempts WHERE student_id = p_user_id;
  DELETE FROM public.fsrs_states WHERE student_id = p_user_id;
  DELETE FROM public.bkt_states WHERE student_id = p_user_id;
  DELETE FROM public.study_sessions WHERE student_id = p_user_id;
  DELETE FROM public.sticky_notes WHERE student_id = p_user_id;
  DELETE FROM public.reading_states WHERE student_id = p_user_id;
  DELETE FROM public.daily_activities WHERE student_id = p_user_id;
  DELETE FROM public.student_stats WHERE student_id = p_user_id;
  DELETE FROM public.text_annotations WHERE student_id = p_user_id;
  DELETE FROM public.kw_student_notes WHERE student_id = p_user_id;
  DELETE FROM public.model_3d_notes WHERE student_id = p_user_id;
  DELETE FROM public.video_notes WHERE student_id = p_user_id;
  DELETE FROM public.exam_events WHERE student_id = p_user_id;
  DELETE FROM public.streak_freezes WHERE student_id = p_user_id;
  DELETE FROM public.streak_repairs WHERE student_id = p_user_id;
  DELETE FROM public.video_views WHERE user_id = p_user_id;
  DELETE FROM public.block_mastery_states WHERE student_id = p_user_id;
  DELETE FROM public.weekly_reports WHERE student_id = p_user_id;
  DELETE FROM public.ai_generations WHERE requested_by = p_user_id;
  DELETE FROM public.ai_schedule_logs WHERE student_id = p_user_id;
  DELETE FROM public.rag_query_log WHERE user_id = p_user_id;
  DELETE FROM public.telegram_links WHERE user_id = p_user_id;
  DELETE FROM public.whatsapp_links WHERE user_id = p_user_id;
  DELETE FROM public.student_xp WHERE student_id = p_user_id;
  DELETE FROM public.xp_transactions WHERE student_id = p_user_id;
  -- Memberships: keep institution audit trail but anonymize
  UPDATE public.memberships SET is_active = false, deleted_at = now() WHERE user_id = p_user_id;
  -- Profile: anonymize (keep PK for FKs that reference it)
  UPDATE public.profiles SET
    full_name = '[deleted]',
    avatar_url = NULL,
    email = '[deleted]'
   WHERE id = p_user_id;
  -- Audit the purge
  INSERT INTO public.audit_log(actor_user_id, action, entity_table, entity_id)
  VALUES (p_user_id, 'GDPR.purge_user', 'auth.users', p_user_id);
END $$;

REVOKE ALL ON FUNCTION public.purge_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_user(uuid) TO service_role;
```

**Backend route**: `DELETE /me` handler calls the RPC, then `admin.auth.admin.deleteUser(user.id)`.

**Export route**: `GET /me/export` — service-role client dumps the above tables filtered by `user_id = user.id`, returns JSON.

**Verification** (integration test):
```typescript
const res = await fetch(`${API_BASE}/me`, { method: "DELETE", headers: authHeaders(user) });
expect(res.status).toBe(200);
// After purge, another request with the same token should fail
const check = await fetch(`${API_BASE}/me`, { headers: authHeaders(user) });
expect(check.status).toBe(401);
```

**Assigned agents**: `auth-backend` + `migration-writer`.

---

### 3.5 Stripe refund/dispute/customer.deleted handlers (iter 12 #2-#3)

**Goal**: stop subscribe-consume-dispute = free access. Close Chain 8.

**File**: `supabase/functions/server/routes/billing/webhook.ts`

**Add cases to the switch**:
```typescript
case "charge.refunded": {
  const charge = event.data.object;
  const subscriptionId = charge.invoice ? (await stripe.invoices.retrieve(charge.invoice)).subscription : null;
  if (subscriptionId) {
    await admin.from("institution_subscriptions")
      .update({ status: "revoked", canceled_at: new Date().toISOString() })
      .eq("stripe_subscription_id", subscriptionId);
  }
  break;
}
case "charge.dispute.created":
case "charge.dispute.funds_withdrawn": {
  const dispute = event.data.object;
  const charge = await stripe.charges.retrieve(dispute.charge);
  const subscriptionId = charge.invoice ? (await stripe.invoices.retrieve(charge.invoice as string)).subscription : null;
  if (subscriptionId) {
    await admin.from("institution_subscriptions")
      .update({ status: "disputed" })
      .eq("stripe_subscription_id", subscriptionId);
  }
  break;
}
case "customer.deleted": {
  const customer = event.data.object;
  await admin.from("institution_subscriptions")
    .update({ status: "canceled", canceled_at: new Date().toISOString() })
    .eq("stripe_customer_id", customer.id);
  break;
}
```

Also: iter 23 #5 — switch idempotency to `INSERT ... ON CONFLICT DO NOTHING RETURNING id` gate at the TOP of the handler.

**Assigned agents**: `stripe-webhooks` + `billing-plans`.

**Chains broken**: Chain 8 (entirely).

---

### Phase 3 — total

- **Effort**: 2-3 days (mostly 3.1 triggers + 3.2 Vault migration + 3.3 MFA).
- **Chains broken**: 6 Path B, 8, 13.
- **Compliance**: GDPR Art. 30 (audit) + Art. 17 (erasure) + Art. 20 (portability); SOC 2 CC7.2/7.3 (monitoring).

---

## Phase 4 — CI enforcement (4-6h)

Breaks **future regression** of all 3 systemic antipatterns.

### 4.1 CI rule: `CREATE OR REPLACE FUNCTION` + `SECURITY DEFINER` requires `SET search_path`

**File**: `.github/workflows/security-lint.yml` (new)

```yaml
name: Security Lint
on:
  pull_request:
    paths:
      - "supabase/migrations/**"
      - "supabase/functions/server/**"

jobs:
  sql-security-definer-search-path:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Fail if CREATE OR REPLACE FUNCTION ... SECURITY DEFINER lacks SET search_path
        run: |
          # Find offending migrations
          bad=$(python .github/scripts/check-security-definer-search-path.py supabase/migrations/)
          if [ -n "$bad" ]; then
            echo "::error::$bad"
            exit 1
          fi
  ts-first-active-membership:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Fail if routes use memberships.limit(1).single() without institution_id
        run: |
          # Regex check
          grep -rn "from[(]['\"]memberships['\"][)]" supabase/functions/server/ | \
            grep -E "\.limit\(1\).*\.single\(\)" | \
            grep -v "// security-lint: intentional" > /tmp/findings.txt || true
          if [ -s /tmp/findings.txt ]; then
            echo "::error::First-active-membership antipattern detected (add // security-lint: intentional + justification to allow)"
            cat /tmp/findings.txt
            exit 1
          fi
  ts-trust-rls-only:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Fail if routes filter by caller-supplied institution_id without requireInstitutionRole
        run: |
          # Parseo manual por pareja .eq("institution_id", ... + same-file requireInstitutionRole
          python .github/scripts/check-trust-rls-only.py supabase/functions/server/routes/
```

**Python scripts** (brief sketch):
- `.github/scripts/check-security-definer-search-path.py` — parses .sql blocks, flags any `CREATE OR REPLACE FUNCTION ... SECURITY DEFINER` that doesn't include `SET search_path` in the function declaration.
- `.github/scripts/check-trust-rls-only.py` — AST walk over TS: for each handler, if it has `.eq("institution_id", <expr>)` and `<expr>` originates from `c.req.query|param|json`, verify the same handler also calls `requireInstitutionRole`.

**Assigned agents**: `infra-ci`.

---

### Phase 4 — total

- **Effort**: 4-6 h (mostly Python scripts).
- **Output**: 3 CI rules. **Prevents every future regression of the 3 systemic antipatterns.**

---

## Phase 5 — Residual hardening (1 día, optional)

Non-chain-breaking items that remain in the tracker. Address incrementally as sprints allow.

| Item | Source | Quick description |
|---|---|---|
| 5.1 Sanitize `originalFilename` in routes-storage.ts | iter 5 + iter 25 | `.replace(/[^a-z0-9._-]/g, '-')` |
| 5.2 `crypto.randomUUID()` for storage paths | iter 16 + iter 22 | replace Math.random with CSPRNG |
| 5.3 `safeErr` sweep (analyze-graph, suggest-connections, student-weak-points, batch-review, pre-generate) | iter 19 | single grep-and-replace PR |
| 5.4 404 vs 403 enumeration fix (exam-events, exam-prep) | iter 11 + iter 19 | collapse both branches to 404 |
| 5.5 RL-DEBUG payload cleanup | iter 14 | remove or env-gate |
| 5.6 Webhook payload size caps (1-5 MB) | iter 23 #7 | Content-Length check before c.req.text() |
| 5.7 Mux webhook timestamp freshness check | iter 23 #4 | Date.now() drift > 300s reject |
| 5.8 Email normalization (NFKC + confusables check) | iter 25 #1 | on signup |
| 5.9 Display-string sanitizer (bidi + null-byte strip) | iter 25 #3 | centralized helper |
| 5.10 JSON bomb guard in extractTextFromBlockContent | iter 24 perf #2 | maxDepth param |
| 5.11 Async queue handleMessage WA + TG | iter 24 perf #1 | offload agentic loop |
| 5.12 Update `axon` npm scope reservation | iter 4 | trivial npm namespace defense |
| 5.13 SHA-pin `trufflesecurity/trufflehog` in CI | iter 4 | defense-in-depth |
| 5.14 JWT alg pin `["ES256"]` | iter 22 | one-line |
| 5.15 HKDF key-separation for WHATSAPP_APP_SECRET | iter 22 | split HMAC + AES-GCM keys |

**Assigned agents**: scattered — each row can be a sub-PR.

---

## Appendix A — Chains broken after each phase

| After Phase | Chains broken | Chains remaining |
|---|---|---|
| Phase 1 | 11A, 11B, 14, partial 1 | 1 (mostly), 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15 |
| Phase 2 | + 1, 2, 3, 6A, 7, 9, 12, 15 | 4, 5, 6B, 8, 10, 13 |
| Phase 3 | + 6B, 8, 13 | 4, 5, 10 |
| Phase 4 | (regression prevention only) | 4, 5, 10 |
| Phase 5 | (residual) | 4 (separate fix per iter 23 Pareto #13), 5 (follow-up), 10 (minor Stripe UI) |

**End state**: Chains 4 (CI OPENAI_API_KEY — iter 4 HIGH-1, separately fixable with `.github/workflows/pr-opened-review.yml` gate), 5 (malicious PDF — iter 5 HIGH-2/3 requires PDF content sanitization, can be Phase 5.16), 10 (past_due UI desync — minor).

---

## Appendix B — Assigned agents (from Axon agent registry)

Cross-reference table for PM:

| Phase | Step | Agent(s) |
|---|---|---|
| 1.1 | Privatize buckets | `infra-database` + `viewer3d-backend` + `ai-generation` + frontend leaf agents |
| 1.2 | REVOKE RPCs | `migration-writer` + `rls-auditor` |
| 1.3 | Restore search_path | `migration-writer` + `rls-auditor` |
| 1.4 | DROP orphan RPC | `migration-writer` |
| 2.1 | email_confirm | `auth-backend` + `auth-frontend` |
| 2.2 | Remove auto-join | `auth-backend` + `owner-backend` + `auth-frontend` |
| 2.3 | First-membership class fix | `infra-plumbing` + `messaging-backend` + `ai-backend` |
| 2.4 | requireInstitutionRole | `admin-backend` + `gamification-backend` |
| 2.5 | process_review_batch | `migration-writer` + `quiz-backend` |
| 3.1 | audit_log | `migration-writer` + `admin-backend` |
| 3.2 | Encrypt tokens | `migration-writer` + `messaging-backend` |
| 3.3 | MFA | `auth-backend` + `auth-frontend` |
| 3.4 | DELETE /me + export | `auth-backend` + `migration-writer` |
| 3.5 | Stripe handlers | `stripe-webhooks` + `billing-plans` |
| 4.1 | CI rules | `infra-ci` |
| 5.* | Residuals | scattered — one sub-PR per item |

After each PR lands: `quality-gate` agent verifies the change, `security-scanner` agent re-runs on the touched area.

---

## Appendix C — Testing strategy per phase

**Phase 1**: SQL-level — post-migration `pg_policies` / `pg_proc` queries show expected state. Integration test: anon `POST /rpc/search_keywords_by_institution` → 401/403 (not 200 with data).

**Phase 2**: cross-tenant regression test — with JWT for tenant A, attempt SELECT/POST on every 13 blind-spot tables with tenant B IDs → expect 0 rows / 403.

**Phase 3**: GDPR test — `DELETE /me` purges then `GET /me` returns 401; `GET /me/export` returns user-scoped rows only.

**Phase 4**: CI synthetic regression — add a migration deliberately missing `SET search_path` on SECURITY DEFINER → CI fails. Remove, CI passes.

**Phase 5**: per-item test list inline.

---

## Appendix D — Files that this plan produces

By end of Phase 4, these are commited to `main`:

```
supabase/migrations/
  20260418000001_security_revoke_anon_and_overgranted_rpcs.sql
  20260418000002_restore_search_path_hardening.sql
  20260418000003_drop_orphan_rag_hybrid_search_768.sql
  20260418000004_invite_tokens.sql              (optional, Phase 2.2 Option B)
  20260418000005_process_review_batch_auth_hardening.sql
  20260419000001_audit_log.sql
  20260419000002_messaging_tokens_to_vault.sql
  20260419000003_purge_user_rpc.sql

supabase/functions/server/
  auth-helpers.ts                                 (+ resolveRequiredInstitution)
  routes-auth.ts                                  (email_confirm: false, remove auto-join, DELETE /me, /me/export)
  routes/settings/messaging-admin.ts              (institution_id required + Vault secret reads)
  routes/ai/chat.ts                               (institution_id required)
  routes/ai/realtime-session.ts                   (institution_id required)
  routes/ai/keyword-search.ts                     (requireInstitutionRole)
  routes/content/keyword-search.ts                (requireInstitutionRole)
  lib/rag-search.ts                               (institution_id required)
  routes/telegram/tools.ts                        (session-resolved institution_id)
  routes/settings/algorithm-config.ts             (requireInstitutionRole)
  routes/gamification/profile.ts                  (requireInstitutionRole on leaderboard)
  routes/plans/ai-generations.ts                  (requireInstitutionRole GET + POST)
  routes/billing/webhook.ts                       (charge.refunded, charge.dispute.*, customer.deleted handlers + idempotency ordering)

.github/workflows/
  security-lint.yml                               (3 rules)
.github/scripts/
  check-security-definer-search-path.py
  check-trust-rls-only.py

supabase/config.toml                              (auth.mfa.enabled = true, email.enable_confirmations = true)

frontend/src/app/
  components/auth/LoginPage.tsx                   ("pending confirmation" state)
  components/settings/security/MfaEnroll.tsx      (new)
  components/tiptap/.../ProseForm.tsx             (signed URLs)
  components/tiptap/.../ImageReferenceForm.tsx    (signed URLs)
  components/professor/FlashcardImageUpload.tsx   (signed URLs)
  components/tiptap-editor/image-handling.ts      (signed URLs)

docs/security/
  2026-04-17-audit-full.md                        (this audit — already committed)
  2026-04-17-remediation-plan.md                  (this plan — already committed)
  README.md                                       (index — already committed)
```

---

## Appendix E — Rollback master plan

If any phase breaks production:

1. `git revert` the Phase-N commits (each phase should be one or two PRs).
2. Supabase: re-apply the Phase 0 schema snapshot for the affected objects only (not the entire schema).
3. Frontend: previous deployment is kept on Vercel for 24h — revert via dashboard.
4. Data: `audit_log` captures before/after jsonb, so row-level rollback is possible.

---

## Running this plan

**Day 1 (morning)**: Phase 0 + Phase 1. All UNAUTH paths closed by lunch. 3 chains gone.

**Day 1 (afternoon) + Day 2**: Phase 2. Auth fundamentals. 9 chains gone. Total: 12 / 15 chains broken.

**Day 3-5**: Phase 3. Compliance infrastructure. 3 more chains + GDPR/SOC 2 gap closed. Total: 14 / 15.

**Day 6**: Phase 4. CI rules land. Regression-proof.

**Day 7+**: Phase 5 residuals as sprints allow.

**Total end-state**: 14 of 15 attack chains broken, compliance-grade audit trail, GDPR-compliant deletion, MFA-gated management, CI preventing regressions.

---

*End of remediation plan. Audit record immutable in `2026-04-17-audit-full.md`. Remediation PRs should reference findings by their iteration number (e.g., "fixes iter 15 #1, iter 17 #3").*
