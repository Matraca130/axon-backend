# DECISIONS.md — Axon v4.4 Security Hardening

> Generated from adversarial AI debates (debate-001, debate-002, debate-003) using SUPERNOVA MCP.
> Date: 2026-03-10

## Context

Adversarial debates identified **7 critical findings** in the Axon v4.4 backend (Hono + Supabase Edge Functions / Deno, 176 routes, 39 PostgreSQL tables). A consensus plan of **4 incremental deploys** was produced over ~108 agent messages across 3 debates.

---

## Decisions

| # | Decision | Rationale | Alternatives Considered | Date |
|---|----------|-----------|------------------------|------|
| 1 | **Jose audience validation** with `{ audience: 'authenticated' }` | Prevents cross-project JWT abuse — a JWT from another Supabase project would pass without audience check | No audience check (rejected: allows any Supabase JWT) | 2026-03-10 |
| 2 | **`authErr()` helper** for auth error responses | Prevents double-encoding JSON bug discovered in review (`err()` + `JSON.stringify()` = double-encoded body). Centralizes `source: 'jose_middleware'` | Using `c.json()` directly in 5 places (rejected: not DRY) | 2026-03-10 |
| 3 | **`envValid` flag + 503 graceful** startup | Zod `safeParse()` sets module-level flag; `authenticate()` returns 503 if env invalid. No `Deno.exit(1)`, no `throw` in module scope | `throw new Error()` on startup (current behavior, kills import chain) | 2026-03-10 |
| 4 | **JWT_SECRET optional in D1, required in D2** | Production env doesn't have `SUPABASE_JWT_SECRET` yet — making it required in D1 would break the app before jose is even used | Required from D1 (rejected: breaks prod) | 2026-03-10 |
| 5 | **rate-limit.ts `extractKey()` is P2 tech debt** | Uses `atob()` to decode JWT for rate limit key extraction. Post-D2, AI routes are protected by jose in `authenticate()` (called before rate limiter). Only non-AI routes remain vulnerable to rate limit evasion via forged JWT | Fix in D2 (rejected: scope creep, different file) | 2026-03-10 |
| 6 | **No partial deploy** — WIP if not complete by 5h mark | Ensures each deploy is fully tested + verified before moving on. If blocked, commit WIP and continue next day | Deploy partially tested (rejected: risk of half-fixes in prod) | 2026-03-10 |

---

## Findings Registry

| ID | Finding | Severity | Status | Deploy | File(s) |
|----|---------|----------|--------|--------|----------|
| H1 | `authenticate()` uses `atob()` — no JWT signature verification | **P0** | PLANNED | D2 | `db.ts` |
| H2 | AI rate limiter is **doubly fail-open** (error + catch both `return next()`) | **P0** | PLANNED | D1 | `routes/ai/index.ts` |
| H3 | Write-permissive temporal policies expose PostgREST direct access | **P1** | PLANNED | D3 | SQL migrations |
| H4 | ~~OpenAI 1536d migration~~ | — | **RESOLVED** | — | Migration already executed |
| H5 | `re-embed-all.ts` removed from router but file exists (dead code) | **P2** | PLANNED | D4 | `re-embed-all.ts` |
| H6 | ~~flashcards missing institution_id~~ | — | **RESOLVED** | — | Migration `20260304_06` added it |
| H7 | General rate-limit.ts is in-memory only (per-isolate) | **P3** | DOCUMENTED | — | `rate-limit.ts` |
| H8 | `rate-limit.ts` `extractKey()` uses `atob()` — allows rate limit evasion with forged JWT | **P2** | TECH DEBT | D5 (future) | `rate-limit.ts` |
| H9 | Double `authenticate()` call in AI routes (middleware + handler) — 2x jose verification | **P3** | TECH DEBT | D5 (future) | `routes/ai/index.ts` |
| H10 | `/ai/report` and `/ai/pre-generate` bypass rate limit — intentional but undocumented | **P3** | DOCUMENTED | — | `routes/ai/index.ts` |

---

## Deploy Plan Summary

| Deploy | Priority | Duration | DRI | Reviewer | Key Changes |
|--------|----------|----------|-----|----------|-------------|
| **D1** | P0 IMMEDIATE | 1h | Senior | Mid | Fail-closed rate limiter + Zod env + 503 startup |
| **D2** | P0 SECURITY | 3h | Senior | Mid (sync) | Jose global in `authenticate()` + `authErr()` + 7 tests |
| **D3** | P1 DATA | 2.5h | Mid | Senior | RLS SELECT+write policies + `auth.user_institution_ids()` + rollback |
| **D4** | P2 OBSERVABILITY | 1.5h | Junior | Mid | `ai_usage_log` (no PII) + pg_cron alerts + cleanup |

**Order:** D1 → D2 → D3 → D4 (D3/D4 development in parallel, deploy sequential)
**Total:** ~9h across 2 days

---

## Verify Scripts

Each deploy includes a post-deploy verification script that checks **response body**, not just HTTP status.

### D1 Verify
```bash
# verify_d1_rate_limit.sh
curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -X POST "$SUPABASE_URL/functions/v1/server/ai/generate" \
  -H "Authorization: Bearer INVALID_TOKEN" | grep -q 'rate_limit_unavailable' || echo 'FAIL: D1 not fail-closed'
```

### D2 Verify
```bash
# verify_d2_jose.sh
RES=$(curl -s -X POST "$SUPABASE_URL/functions/v1/server/ai/generate" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.INVALIDSIG")
echo $RES | jq -e '.error == "jwt_signature_invalid" and .source == "jose_middleware"' || echo 'FAIL: D2 jose not working'
```

---

*This document is maintained alongside the codebase. Update it when decisions change.*
