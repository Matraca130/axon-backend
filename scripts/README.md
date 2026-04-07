# scripts/

Utility scripts used by CI and locally.

## `check-migration-safety.sh`

Destructive-SQL scanner for Supabase migration files. Used by
`.github/workflows/deploy-migrations.yml` (Guard B / defense layer 5)
and runnable locally before committing a migration.

### Usage

```bash
bash scripts/check-migration-safety.sh supabase/migrations/<file>.sql [more.sql ...]
```

### What it flags

| Pattern | Why |
|---|---|
| `DROP TABLE/SCHEMA/DATABASE/ROLE/TYPE/FUNCTION/VIEW/MATERIALIZED VIEW/TRIGGER/CONSTRAINT/POLICY/RULE/EXTENSION/SEQUENCE/OWNED` | Removes objects (often with their data). |
| `TRUNCATE` | Wipes all rows. |
| `DELETE FROM` | Bulk row deletion. |
| `ALTER TABLE ... DROP` | Drops a column / constraint. |
| `ALTER TABLE/VIEW ... RENAME` | Breaks app code that references the old name. |
| `ALTER COLUMN ... TYPE` | Can lose precision / fail / lock the table. |
| `ALTER COLUMN ... SET NOT NULL` | Can fail on existing data; risk of full table scan. |
| `REVOKE` | Removes permissions; can break app. |
| `GRANT ... TO public/anon` | Privilege escalation to anonymous role. |

Comments (`-- ...` and `/* ... */`) are stripped before scanning, so a
commented-out `DROP TABLE` does **not** trigger a false positive.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | All files passed. |
| `1` | At least one file contains a destructive pattern. |
| `2` | Bad usage / file not found. |

### Escape hatch

If a destructive change is genuinely intentional, the **CI workflow**
can skip this scanner when the merge commit message contains the
literal token `[migration:destructive-ok]`. The scanner script itself
ignores any override — it stays simple and pure. The append-only guard
(Guard A) and the manual approval gate (Layer 6) remain in effect even
when the destructive scanner is skipped.

### Run locally before committing

```bash
# Test a single migration
bash scripts/check-migration-safety.sh supabase/migrations/20260407000001_sticky_notes.sql

# Test everything that's added/modified vs main
git diff --name-only --diff-filter=A main -- 'supabase/migrations/*.sql' \
  | xargs -r bash scripts/check-migration-safety.sh
```
