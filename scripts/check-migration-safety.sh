#!/usr/bin/env bash
# ============================================================
# check-migration-safety.sh — Destructive-SQL scanner for Supabase migrations
#
# Usage:
#   bash scripts/check-migration-safety.sh <file1.sql> [file2.sql ...]
#
# Exit codes:
#   0  All files safe.
#   1  At least one file contains a destructive pattern.
#   2  Bad usage / file not found.
#
# Used by .github/workflows/deploy-migrations.yml as Guard B
# (defense layer 5). Also runnable locally before committing.
#
# ESCAPE HATCH: this script does NOT honor any override token.
# The workflow checks the merge commit message for
# "[migration:destructive-ok]" and skips invoking this script
# in that case. The script itself stays simple and pure.
# ============================================================

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <file1.sql> [file2.sql ...]" >&2
  exit 2
fi

# Patterns we treat as destructive. ERE syntax (-E).
# Each is matched case-insensitively against the SQL with comments stripped.
PATTERNS=(
  '\bDROP[[:space:]]+(TABLE|SCHEMA|DATABASE|ROLE|TYPE|FUNCTION|VIEW|MATERIALIZED[[:space:]]+VIEW|TRIGGER|CONSTRAINT|POLICY|RULE|EXTENSION|SEQUENCE|OWNED)\b'
  '\bTRUNCATE\b'
  '\bDELETE[[:space:]]+FROM\b'
  '\bALTER[[:space:]]+TABLE[[:space:]]+[^[:space:]]+[[:space:]]+DROP\b'
  '\bALTER[[:space:]]+(TABLE|VIEW)[[:space:]]+[^[:space:]]+[[:space:]]+RENAME\b'
  '\bALTER[[:space:]]+COLUMN[[:space:]]+[^[:space:]]+[[:space:]]+TYPE\b'
  '\bALTER[[:space:]]+COLUMN[[:space:]]+[^[:space:]]+[[:space:]]+SET[[:space:]]+NOT[[:space:]]+NULL\b'
  '\bREVOKE\b'
  '\bGRANT[[:space:]]+.*[[:space:]]+ON[[:space:]]+.*[[:space:]]+TO[[:space:]]+(public|anon)\b'
)

PATTERN_NAMES=(
  "DROP <object>"
  "TRUNCATE"
  "DELETE FROM"
  "ALTER TABLE ... DROP"
  "ALTER TABLE/VIEW ... RENAME"
  "ALTER COLUMN ... TYPE"
  "ALTER COLUMN ... SET NOT NULL"
  "REVOKE"
  "GRANT ... TO (public|anon)"
)

violations=0

# Strip SQL comments (-- line and /* block */) so a comment like
# "-- DROP TABLE foo" doesn't trigger a false positive.
strip_sql_comments() {
  # 1) Remove /* ... */ block comments (greedy across lines via tr/sed combo)
  # 2) Remove -- ... line comments
  awk '
    BEGIN { in_block = 0 }
    {
      line = $0
      out = ""
      i = 1
      while (i <= length(line)) {
        if (in_block) {
          end = index(substr(line, i), "*/")
          if (end == 0) { i = length(line) + 1 }
          else { i = i + end + 1; in_block = 0 }
        } else {
          start = index(substr(line, i), "/*")
          dash  = index(substr(line, i), "--")
          if (start > 0 && (dash == 0 || start < dash)) {
            out = out substr(line, i, start - 1)
            i = i + start + 1
            in_block = 1
          } else if (dash > 0) {
            out = out substr(line, i, dash - 1)
            i = length(line) + 1
          } else {
            out = out substr(line, i)
            i = length(line) + 1
          }
        }
      }
      print out
    }
  ' "$1"
}

for file in "$@"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: file not found: $file" >&2
    exit 2
  fi

  stripped=$(strip_sql_comments "$file")

  file_violations=0
  for idx in "${!PATTERNS[@]}"; do
    pattern="${PATTERNS[$idx]}"
    name="${PATTERN_NAMES[$idx]}"
    if echo "$stripped" | grep -Eqi -- "$pattern"; then
      if [[ $file_violations -eq 0 ]]; then
        echo "::error file=$file::Destructive SQL detected in $file"
        echo ""
        echo "  ✗ $file"
      fi
      echo "      → $name"
      # Show the offending lines (with line numbers from original file)
      grep -Eni -- "$pattern" "$file" | sed 's/^/         /' || true
      file_violations=$((file_violations + 1))
      violations=$((violations + 1))
    fi
  done

  if [[ $file_violations -eq 0 ]]; then
    echo "  ✓ $file"
  fi
done

echo ""
if [[ $violations -gt 0 ]]; then
  echo "FAILED: $violations destructive pattern(s) found across $# file(s)."
  echo ""
  echo "If this is intentional (e.g. you really want to drop a column on"
  echo "production), add the literal token  [migration:destructive-ok]"
  echo "to your merge commit message. The deploy workflow will skip this"
  echo "scanner for that commit. The append-only guard (Guard A) and the"
  echo "manual approval gate still apply."
  exit 1
fi

echo "OK: all $# file(s) passed the destructive-SQL scanner."
exit 0
