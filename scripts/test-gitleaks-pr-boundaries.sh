#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scanner="$project_root/scripts/scan-gitleaks-pr-history.sh"
export GITLEAKS_CONFIG="$project_root/.gitleaks.toml"
proof_root="$(mktemp -d "${TMPDIR:-/tmp}/gitleaks-pr-boundaries.XXXXXX")"
trap 'rm -rf "$proof_root"' EXIT

canary="$(openssl rand -hex 32)"

new_repo() {
  local name="$1"
  local path="$proof_root/$name"
  mkdir -p "$path"
  git -C "$path" init -q -b main
  git -C "$path" config user.name "Gitleaks boundary test"
  git -C "$path" config user.email "gitleaks-boundary-test@example.invalid"
  printf 'baseline\n' > "$path/baseline.txt"
  git -C "$path" add baseline.txt
  git -C "$path" commit -q -m baseline
  printf '%s\n' "$path"
}

expect_red() {
  local name="$1" base_sha="$2" head_sha="$3" output="$proof_root/$1.log" status
  if (cd "$repo" && "$scanner" "$base_sha" "$head_sha") > "$output" 2>&1; then
    echo "$name: expected a secret finding, got a clean scan" >&2
    return 1
  else
    status=$?
  fi
  if [ "$status" -ne 2 ]; then
    echo "$name: expected Gitleaks finding exit 2, got exit $status" >&2
    return 1
  fi
  echo "$name: RED as expected"
}

expect_green() {
  local name="$1" base_sha="$2" head_sha="$3" output="$proof_root/$1.log"
  if ! (cd "$repo" && "$scanner" "$base_sha" "$head_sha") > "$output" 2>&1; then
    echo "$name: expected a clean scan" >&2
    return 1
  fi
  echo "$name: GREEN as expected"
}

# A secret added and then removed on a side branch must remain visible in history.
repo="$(new_repo side-branch)"
base_sha="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" switch -q -c side
printf 'api_key=%s\n' "$canary" > "$repo/side.txt"
git -C "$repo" add side.txt
git -C "$repo" commit -q -m add-side-canary
git -C "$repo" rm -q side.txt
git -C "$repo" commit -q -m remove-side-canary
git -C "$repo" switch -q main
printf 'main\n' > "$repo/main.txt"
git -C "$repo" add main.txt
git -C "$repo" commit -q -m advance-base
base_sha="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" merge -q --no-ff --no-edit side
head_sha="$(git -C "$repo" rev-parse HEAD)"
[ ! -e "$repo/side.txt" ]
expect_red "removed side-branch secret" "$base_sha" "$head_sha"

# A secret present only in the merge resolution must be caught by its first-parent diff.
repo="$(new_repo merge-resolution)"
git -C "$repo" switch -q -c topic
printf 'topic\n' > "$repo/baseline.txt"
git -C "$repo" add baseline.txt
git -C "$repo" commit -q -m topic-change
git -C "$repo" switch -q main
printf 'main\n' > "$repo/baseline.txt"
git -C "$repo" add baseline.txt
git -C "$repo" commit -q -m base-change
base_sha="$(git -C "$repo" rev-parse HEAD)"
if git -C "$repo" merge --no-commit topic >/dev/null 2>&1; then
  echo "merge-resolution fixture unexpectedly merged without conflict" >&2
  exit 1
fi
printf '+api_key=%s\n' "$canary" > "$repo/baseline.txt"
git -C "$repo" add baseline.txt
git -C "$repo" commit -q -m merge-resolution
printf 'clean after merge\n' > "$repo/baseline.txt"
git -C "$repo" add baseline.txt
git -C "$repo" commit -q -m remove-merge-canary
head_sha="$(git -C "$repo" rev-parse HEAD)"
expect_red "merge-resolution-only secret" "$base_sha" "$head_sha"

# Removing a secret already present at base must not scan the deletion as a finding.
repo="$(new_repo merge-removal)"
git -C "$repo" switch -q -c topic
printf 'topic\n' > "$repo/baseline.txt"
git -C "$repo" add baseline.txt
git -C "$repo" commit -q -m topic-change
git -C "$repo" switch -q main
printf 'api_key=%s\n' "$canary" > "$repo/baseline.txt"
git -C "$repo" add baseline.txt
git -C "$repo" commit -q -m base-canary
base_sha="$(git -C "$repo" rev-parse HEAD)"
if git -C "$repo" merge --no-commit topic >/dev/null 2>&1; then
  echo "merge-removal fixture unexpectedly merged without conflict" >&2
  exit 1
fi
printf 'topic\n' > "$repo/baseline.txt"
git -C "$repo" add baseline.txt
git -C "$repo" commit -q -m remove-base-canary
head_sha="$(git -C "$repo" rev-parse HEAD)"
expect_green "merge removes pre-base secret" "$base_sha" "$head_sha"

# A finding already present at base must not be rescanned as newly introduced content.
repo="$(new_repo pre-base)"
printf 'api_key=%s\n' "$canary" > "$repo/history.txt"
git -C "$repo" add history.txt
git -C "$repo" commit -q -m pre-base-canary
base_sha="$(git -C "$repo" rev-parse HEAD)"
printf 'after base\n' > "$repo/after-base.txt"
git -C "$repo" add after-base.txt
git -C "$repo" commit -q -m harmless-pr-commit
head_sha="$(git -C "$repo" rev-parse HEAD)"
expect_green "pre-base historical secret" "$base_sha" "$head_sha"
