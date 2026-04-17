# Security Audits

Historical + living record of security reviews on the Axon backend.

## Index

| Audit | Date | Iterations | Findings | Status |
|---|---|---|---|---|
| [`2026-04-17-audit-full.md`](./2026-04-17-audit-full.md) | 2026-04-17 | 27 | 188 (6 CRITICAL + 65 HIGH + 99 MED + 18 LOW) | documented, remediation pending |

## Audit methodology

Each audit file is a self-contained tracker produced by a recurring `/loop` session over the repo. Findings are categorized by severity and composed into end-to-end attack chains (kill-chains). Each iteration covers a distinct surface (RLS, auth flow, storage, CI, etc.) to maximize non-overlapping coverage.

## How to consume

1. **Remediation**: skip to the "Pareto fix order" section at the end of each audit. The top 5-10 fixes typically break most attack chains.
2. **Pattern enforcement**: scan for "systemic CI recommendation" blocks — those document anti-patterns that should be blocked in CI, not fixed one-off.
3. **Agent knowledge**: patterns + false positives should be mirrored into `docs/claude-config/agent-memory/` so future AI-assisted code generation avoids regressing.

## Security posture

Findings in these trackers are **security-sensitive**. This directory must:
- Stay in a private repo (this repo is private).
- Not be shared verbatim outside the org.
- Be regenerated/superseded rather than edited once published (treat as immutable audit record).
