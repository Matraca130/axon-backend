#!/usr/bin/env bash
# ============================================================
# scripts/tests/check-migration-safety_test.sh
# Test runner for scripts/check-migration-safety.sh
#
# Exit codes:
#   0  All cases passed.
#   1  At least one case failed.
#
# Run locally:
#   bash scripts/tests/check-migration-safety_test.sh
# ============================================================
set -uo pipefail   # NOT -e: we expect non-zero exits from the scanner.

cd "$(dirname "$0")/.."   # → scripts/
SCANNER="check-migration-safety.sh"

if [[ ! -x "$SCANNER" ]]; then
  chmod +x "$SCANNER"
fi

pass=0
fail=0
total=0

# run_case <fixture> <expected_exit> [<must_grep_pattern>]
run_case() {
  local fixture="tests/fixtures/$1"
  local expected_exit="$2"
  local must_grep="${3:-}"

  total=$((total + 1))

  if [[ ! -f "$fixture" ]]; then
    echo "  ✗ $1 — fixture file missing"
    fail=$((fail + 1))
    return
  fi

  local out
  local ec
  out=$(bash "$SCANNER" "$fixture" 2>&1)
  ec=$?

  if [[ "$ec" != "$expected_exit" ]]; then
    echo "  ✗ $1 — expected exit $expected_exit, got $ec"
    echo "$out" | sed 's/^/      /'
    fail=$((fail + 1))
    return
  fi

  if [[ -n "$must_grep" ]] && ! echo "$out" | grep -q -- "$must_grep"; then
    echo "  ✗ $1 — output missing expected pattern: $must_grep"
    echo "$out" | sed 's/^/      /'
    fail=$((fail + 1))
    return
  fi

  echo "  ✓ $1"
  pass=$((pass + 1))
}

echo "═══════════════════════════════════════════════════════════"
echo " check-migration-safety.sh — fixture suite"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "── SAFE fixtures (should pass, exit 0) ──"
run_case safe_create_table.sql                  0
run_case safe_create_index.sql                  0
run_case safe_drop_index.sql                    0
run_case safe_create_or_replace_function.sql    0
run_case safe_create_or_replace_trigger.sql     0
run_case safe_comments_with_drop_keywords.sql   0

echo ""
echo "── DESTRUCTIVE fixtures (should fail, exit 1) ──"
run_case bad_drop_table_oneline.sql                  1 "DROP <object>"
run_case bad_drop_table_multiline.sql                1 "DROP <object>"
run_case bad_alter_table_drop_column.sql             1 "ALTER TABLE ... DROP"
run_case bad_alter_table_drop_column_multiline.sql   1 "ALTER TABLE ... DROP"
run_case bad_truncate.sql                            1 "TRUNCATE"
run_case bad_delete_from.sql                         1 "DELETE FROM"
run_case bad_alter_column_type.sql                   1 "ALTER COLUMN ... TYPE"
run_case bad_alter_column_set_not_null.sql           1 "ALTER COLUMN ... SET NOT NULL"
run_case bad_alter_table_rename.sql                  1 "ALTER TABLE/VIEW ... RENAME"
run_case bad_drop_policy.sql                         1 "DROP <object>"
run_case bad_drop_function.sql                       1 "DROP <object>"
run_case bad_drop_trigger.sql                        1 "DROP <object>"
run_case bad_revoke.sql                              1 "REVOKE"
run_case bad_grant_to_public.sql                     1 "GRANT ... TO (public|anon)"
run_case bad_grant_to_anon.sql                       1 "GRANT ... TO (public|anon)"

echo ""
echo "── USAGE checks ──"

# Empty args → exit 2
out=$(bash "$SCANNER" 2>&1); ec=$?; total=$((total + 1))
if [[ "$ec" == "2" ]]; then
  echo "  ✓ no-args → exit 2 (usage)"
  pass=$((pass + 1))
else
  echo "  ✗ no-args → expected exit 2, got $ec"
  fail=$((fail + 1))
fi

# Missing file → exit 2
out=$(bash "$SCANNER" /tmp/nonexistent_$$.sql 2>&1); ec=$?; total=$((total + 1))
if [[ "$ec" == "2" ]]; then
  echo "  ✓ missing-file → exit 2 (usage)"
  pass=$((pass + 1))
else
  echo "  ✗ missing-file → expected exit 2, got $ec"
  fail=$((fail + 1))
fi

# Multi-file invocation: one safe + one bad → exit 1
out=$(bash "$SCANNER" \
  tests/fixtures/safe_create_table.sql \
  tests/fixtures/bad_drop_table_oneline.sql 2>&1); ec=$?; total=$((total + 1))
if [[ "$ec" == "1" ]]; then
  echo "  ✓ multi-file with one bad → exit 1"
  pass=$((pass + 1))
else
  echo "  ✗ multi-file with one bad → expected exit 1, got $ec"
  echo "$out" | sed 's/^/      /'
  fail=$((fail + 1))
fi

# Multi-file invocation: all safe → exit 0
out=$(bash "$SCANNER" \
  tests/fixtures/safe_create_table.sql \
  tests/fixtures/safe_create_index.sql 2>&1); ec=$?; total=$((total + 1))
if [[ "$ec" == "0" ]]; then
  echo "  ✓ multi-file all safe → exit 0"
  pass=$((pass + 1))
else
  echo "  ✗ multi-file all safe → expected exit 0, got $ec"
  fail=$((fail + 1))
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Results: $pass/$total passed, $fail failed"
echo "═══════════════════════════════════════════════════════════"

if [[ $fail -gt 0 ]]; then
  exit 1
fi
exit 0
