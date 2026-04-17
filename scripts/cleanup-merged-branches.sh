#!/usr/bin/env bash
# cleanup-merged-branches.sh
# Borra SOLO ramas remotas cuyos commits ya estan en origin/main por patch-id
# (git cherry). No toca ramas con PR abierto ni con trabajo unico.
#
# Uso:
#   bash scripts/cleanup-merged-branches.sh            # dry-run (lista)
#   bash scripts/cleanup-merged-branches.sh --execute  # borra de verdad
#
# Requisitos: credenciales git con permiso de push (delete) en origin.
set -euo pipefail

MAIN="origin/main"
EXECUTE=0
[[ "${1:-}" == "--execute" ]] && EXECUTE=1

# Ramas con PR abierto — NUNCA se borran.
OPEN_PR_BRANCHES=(
  "claude/verify-refactoring-parallel-b9kwp"
  "refactor/study-batch-review-split"
  "security/search-path-remaining-2026-04-16"
  "security/storage-buckets-2026-04-16"
  "security/rls-tighten-permissive-2026-04-16"
  "security/rls-enable-unused-tables-2026-04-16"
  "security/search-path-hardening-2026-04-16"
  "refactor/core-cleanup-2026-04-14"
  "claude/find-refactoring-points-itxku"
  "fix/flaky-xp-test"
  "claude/test-sticky-notes-backend"
  "task/AXO-138"
)

is_open_pr() {
  local b="$1"
  for pr in "${OPEN_PR_BRANCHES[@]}"; do
    [[ "$b" == "$pr" ]] && return 0
  done
  return 1
}

echo "Fetching latest refs..."
git fetch origin --prune >/dev/null 2>&1

TO_DELETE=()
SKIPPED_PR=()
SKIPPED_UNIQUE=()

mapfile -t BRANCHES < <(git for-each-ref --format='%(refname:short)' refs/remotes/origin \
  | grep -v '^origin/HEAD$' | grep -v '^origin/main$' | sed 's|^origin/||')

for b in "${BRANCHES[@]}"; do
  if is_open_pr "$b"; then
    SKIPPED_PR+=("$b")
    continue
  fi
  unique=$(git cherry "$MAIN" "origin/$b" 2>/dev/null | grep -c '^+' || true)
  if [[ "$unique" == "0" ]]; then
    TO_DELETE+=("$b")
  else
    SKIPPED_UNIQUE+=("$b ($unique unique)")
  fi
done

echo
echo "=== RESUMEN ==="
echo "PR abierto (protegidas):    ${#SKIPPED_PR[@]}"
echo "Con commits unicos (review): ${#SKIPPED_UNIQUE[@]}"
echo "Seguras para borrar:         ${#TO_DELETE[@]}"
echo

if [[ ${#TO_DELETE[@]} -eq 0 ]]; then
  echo "Nada que borrar."
  exit 0
fi

echo "=== RAMAS A BORRAR ==="
printf '  %s\n' "${TO_DELETE[@]}"
echo

if [[ $EXECUTE -eq 0 ]]; then
  echo "DRY-RUN. Ejecuta con --execute para borrar."
  exit 0
fi

read -r -p "Borrar ${#TO_DELETE[@]} ramas remotas? [y/N] " ans
[[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "Abortado."; exit 1; }

for b in "${TO_DELETE[@]}"; do
  echo "Deleting origin/$b..."
  if git push origin --delete "$b"; then
    echo "  OK"
  else
    echo "  FALLO (continuando)"
  fi
done

echo
echo "Listo."
