#!/usr/bin/env bash
# Run Vale in report-only mode. Findings (exit 1) are published and do not fail
# the job; a Vale runtime error (exit >1) still fails so a broken install or
# configuration cannot look like a clean report.
set -uo pipefail

findings_file="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vale-findings.XXXXXX")"
trap 'rm -f "$findings_file"' EXIT

status=0
vale --config=.vale.ini --output=line docs/guide > "$findings_file" 2>&1 || status=$?
findings=0
if [ -s "$findings_file" ]; then
  findings="$(wc -l < "$findings_file" | tr -d ' ')"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Vale (report-only)"
    echo ""
    echo "Findings: $findings"
    if [ "$status" -gt 1 ]; then
      echo ""
      echo "Vale failed with exit status $status:"
    fi
    if [ "$findings" -gt 0 ] || [ "$status" -gt 1 ]; then
      echo ""
      echo '```text'
      cat "$findings_file"
      echo '```'
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

# Keep the complete report in the job log, not only the step summary.
cat "$findings_file"

if [ "$status" -gt 1 ]; then
  echo "Vale failed with exit status $status." >&2
  exit "$status"
fi
echo "Vale reported $findings finding(s). Report-only; this job does not gate the PR."
