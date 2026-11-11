#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: scan-gitleaks-pr-history.sh <base-sha> <head-sha>" >&2
  exit 1
fi

base_sha="$1"
head_sha="$2"

for sha in "$base_sha" "$head_sha"; do
  if [[ ! "$sha" =~ ^[0-9a-fA-F]{40,64}$ ]] || ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "secret scan boundary is not an available commit: $sha" >&2
    exit 1
  fi
done

if ! git merge-base --is-ancestor "$base_sha" "$head_sha"; then
  echo "secret scan base is not an ancestor of head" >&2
  exit 1
fi

gitleaks detect --redact --exit-code=2 --log-opts="--no-merges --full-history ${base_sha}..${head_sha}"
merge_commits="$(git rev-list --merges --reverse --topo-order "${base_sha}..${head_sha}")"
if [ -n "$merge_commits" ]; then
  while IFS= read -r merge_commit; do
    gitleaks detect --redact --exit-code=2 --log-opts="-m --first-parent -1 ${merge_commit}"
  done <<< "$merge_commits"
fi
