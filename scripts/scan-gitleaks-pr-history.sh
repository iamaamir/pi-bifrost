#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: scan-gitleaks-pr-history.sh <base-sha> <head-sha>" >&2
  exit 1
fi

base_sha="$1"
head_sha="$2"

gitleaks detect --redact --exit-code=2 --log-opts="--no-merges --full-history ${base_sha}..${head_sha}"
while IFS= read -r merge_commit; do
  gitleaks detect --redact --exit-code=2 --log-opts="-m --first-parent -1 ${merge_commit}"
done < <(git rev-list --merges --reverse --topo-order "${base_sha}..${head_sha}")
