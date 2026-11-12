#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scanner="$project_root/scripts/scan-gitleaks-pr-history.sh"
export GITLEAKS_CONFIG="$project_root/.gitleaks.toml"
proof_root="$(mktemp -d "${TMPDIR:-/tmp}/gitleaks-pr-boundaries.XXXXXX")"
trap 'rm -rf "$proof_root"' EXIT

# A stable high-entropy fixture avoids Gitleaks entropy-stopword variance.
canary_seed="0123456789abcdef"
canary="${canary_seed}${canary_seed}${canary_seed}${canary_seed}"

new_repo() {
  local name="$1"
  local path="$proof_root/$name"
  mkdir -p "$path"
  git -C "$path" init -q -b main
  git -C "$path" config commit.gpgsign false
  git -C "$path" config core.hooksPath /dev/null
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
    echo "$name: expected Gitleaks exit 2, got exit 0" >&2
    sed -n -E '/scanned ~[0-9]+ bytes|leaks found: [0-9]+/ { s/^.*(scanned ~[0-9]+ bytes|leaks found: [0-9]+).*$/  \1/p; }' "$output" | tail -n 2 >&2
    return 1
  else
    status=$?
  fi
  if [ "$status" -ne 2 ]; then
    echo "$name: expected Gitleaks finding exit 2, got exit $status" >&2
    sed -n -E '/scanned ~[0-9]+ bytes|leaks found: [0-9]+/ { s/^.*(scanned ~[0-9]+ bytes|leaks found: [0-9]+).*$/  \1/p; }' "$output" | tail -n 2 >&2
    return 1
  fi
  echo "$name: RED as expected"
}

expect_green() {
  local name="$1" base_sha="$2" head_sha="$3" output="$proof_root/$1.log"
  if (cd "$repo" && "$scanner" "$base_sha" "$head_sha") > "$output" 2>&1; then
    echo "$name: GREEN as expected"
  else
    local status=$?
    echo "$name: expected Gitleaks exit 0, got exit $status" >&2
    sed -n -E '/scanned ~[0-9]+ bytes|leaks found: [0-9]+/ { s/^.*(scanned ~[0-9]+ bytes|leaks found: [0-9]+).*$/  \1/p; }' "$output" | tail -n 2 >&2
    return 1
  fi
}

expect_boundary_error() {
  local name="$1" base_sha="$2" head_sha="$3" output="$proof_root/$1.log"
  if (cd "$repo" && "$scanner" "$base_sha" "$head_sha") > "$output" 2>&1; then
    echo "$name: expected an invalid boundary to fail closed" >&2
    return 1
  fi
  echo "$name: failed closed as expected"
}

expect_rev_list_failure() {
  local base_sha="$1" head_sha="$2" shim_bin="$proof_root/failing-tools" output="$proof_root/rev-list-failure.log" status
  mkdir -p "$shim_bin"
  cat > "$shim_bin/git" <<'EOF'
#!/bin/sh
if [ "$1" = rev-list ]; then
  for arg in "$@"; do
    [ "$arg" = --merges ] && exit 73
  done
fi
exec "$REAL_GIT" "$@"
EOF
  cat > "$shim_bin/gitleaks" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$shim_bin/git" "$shim_bin/gitleaks"
  if (cd "$repo" && REAL_GIT="$(command -v git)" PATH="$shim_bin:$PATH" "$scanner" "$base_sha" "$head_sha") > "$output" 2>&1; then
    echo "merge enumeration failure: scanner unexpectedly succeeded" >&2
    return 1
  else
    status=$?
  fi
  if [ "$status" -ne 73 ]; then
    echo "merge enumeration failure: expected exit 73, got $status" >&2
    return 1
  fi
  echo "merge enumeration failure: propagated as expected"
}

# Prove the deterministic synthetic canary itself triggers the pinned detector.
repo="$(new_repo deterministic-canary-control)"
base_sha="$(git -C "$repo" rev-parse HEAD)"
printf 'api_key=%s\n' "$canary" > "$repo/canary.txt"
git -C "$repo" add canary.txt
git -C "$repo" commit -q -m add-deterministic-canary
head_sha="$(git -C "$repo" rev-parse HEAD)"
expect_red "deterministic canary detection" "$base_sha" "$head_sha"

# Pushes without a usable before commit (new branch/deletion events) must fail closed.
repo="$(new_repo push-boundary)"
head_sha="$(git -C "$repo" rev-parse HEAD)"
expect_boundary_error "zero before boundary" "0000000000000000000000000000000000000000" "$head_sha"
expect_boundary_error "zero after boundary" "$head_sha" "0000000000000000000000000000000000000000"

# The reviewed PR and squash fixtures must scan clean without commit-specific ignores.
fixture_pr_base="74775776e5214e8182150cd8d0f4761482b06f6b"
fixture_pr_head="982a4ce6c517cb430700d6c71596b2ab0aa92fbd"
squash_head="d501d118160d295e307943a683b3fa5679809b35"
repo="$project_root"
expect_green "reviewed PR fixture history" "$fixture_pr_base" "$fixture_pr_head"
expect_green "reviewed squash fixture history" "$fixture_pr_base" "$squash_head"

# The same history must go red without our rule-specific fixture exceptions.
printf '[extend]\nuseDefault = true\n' > "$proof_root/default-only.toml"
if (cd "$project_root" && GITLEAKS_CONFIG="$proof_root/default-only.toml" \
  gitleaks detect --redact --exit-code=2 \
  --log-opts="--no-merges --full-history $fixture_pr_base..$squash_head") \
  > "$proof_root/no-fixture-exceptions.log" 2>&1; then
  echo "squash fixtures were not detected without the exceptions" >&2
  exit 1
else
  scan_rc=$?
fi
[ "$scan_rc" -eq 2 ] || { echo "squash fault control did not return a finding" >&2; exit 1; }
echo "squash scan: RED without fixture exceptions as expected"

# Gitleaks 8.24.3 accepts --first-parent as a git log option, not a CLI flag.
first_pr_commit="$(git -C "$project_root" rev-list --first-parent --reverse \
  "$fixture_pr_base..$fixture_pr_head" | sed -n '1p')"
[ -n "$first_pr_commit" ] || {
  echo "could not find the first PR #34 commit" >&2
  exit 1
}
if (cd "$project_root" && gitleaks detect --redact --exit-code=2 \
  --log-opts="--first-parent $first_pr_commit^..$fixture_pr_head") \
  > "$proof_root/first-parent.log" 2>&1; then
  echo "PR #34 first-parent history: GREEN as expected"
else
  scan_rc=$?
  echo "PR #34 first-parent history: expected GREEN, got exit $scan_rc" >&2
  exit 1
fi

# Only the exact fixture in its reviewed file may survive a new commit.
fixture_path="tests/routing.test.ts"
repo="$(new_repo scoped-fixture)"
mkdir -p "$repo/$(dirname "$fixture_path")"
git -C "$project_root" show "$squash_head:$fixture_path" | sed -n '70p' > "$repo/$fixture_path"
git -C "$repo" add "$fixture_path"
git -C "$repo" commit -q -m copy-reviewed-fixture
base_sha="$(git -C "$repo" rev-parse HEAD^)"
head_sha="$(git -C "$repo" rev-parse HEAD)"
expect_green "same fixture and path in a new commit" "$base_sha" "$head_sha"

printf 'api_key=%s\n' "$canary" >> "$repo/$fixture_path"
git -C "$repo" add "$fixture_path"
git -C "$repo" commit -q -m different-secret-same-path
expect_red "different secret in reviewed file" "$head_sha" "$(git -C "$repo" rev-parse HEAD)"

repo="$(new_repo wrong-fixture-path)"
git -C "$project_root" show "$squash_head:$fixture_path" | sed -n '70p' > "$repo/wrong-path.txt"
git -C "$repo" add wrong-path.txt
git -C "$repo" commit -q -m fixture-wrong-path
base_sha="$(git -C "$repo" rev-parse HEAD^)"
head_sha="$(git -C "$repo" rev-parse HEAD)"
expect_red "reviewed fixture at another path" "$base_sha" "$head_sha"
sed 's/condition = "AND"/condition = "OR"/g' "$project_root/.gitleaks.toml" > "$proof_root/weak-allowlist.toml"
if (cd "$repo" && GITLEAKS_CONFIG="$proof_root/weak-allowlist.toml" "$scanner" "$base_sha" "$head_sha") \
  > "$proof_root/weak-allowlist.log" 2>&1; then
  echo "fault control: OR incorrectly hides the wrong-path fixture as expected"
else
  echo "fault control failed to demonstrate a weakened allowlist" >&2
  exit 1
fi

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
expect_rev_list_failure "$base_sha" "$head_sha"

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
