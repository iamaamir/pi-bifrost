#!/usr/bin/env bash
# Isolated proof of concept for agent-tui as Pi-Bifrost's PTY test driver.
# Does not replace scripts/ui-smoke.py.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_TUI_BIN="${AGENT_TUI_BIN:-$(command -v agent-tui || true)}"
PI_BIN="${PI_BIN:-$(command -v pi || true)}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT/screenshots/ui-agent-tui-poc}"

if [[ -z "$AGENT_TUI_BIN" ]]; then
  echo "agent-tui not found. Install a pinned binary or set AGENT_TUI_BIN." >&2
  exit 1
fi
if [[ -z "$PI_BIN" ]]; then
  echo "pi not found. Set PI_BIN to the Pi executable." >&2
  exit 1
fi

runtime="$(mktemp -d)"
workspace="$(mktemp -d)"
session_id=""
mkdir -p "$ARTIFACT_DIR"
rm -f "$ARTIFACT_DIR"/*.json

export AGENT_TUI_SOCKET="$runtime/agent-tui.sock"
export AGENT_TUI_SESSION_STORE="$runtime/sessions.jsonl"
export AGENT_TUI_WS_STATE="$runtime/ws.json"
export AGENT_TUI_UI_STATE="$runtime/ui.json"
export AGENT_TUI_WS_DISABLED=true

cleanup() {
  if [[ -n "$session_id" ]]; then
    "$AGENT_TUI_BIN" --session "$session_id" --json kill --yes >/dev/null 2>&1 || true
  fi
  "$AGENT_TUI_BIN" --json sessions cleanup --all --yes >/dev/null 2>&1 || true
  "$AGENT_TUI_BIN" --json daemon stop --force --yes >/dev/null 2>&1 || true
  rm -rf "$runtime" "$workspace"
}
trap cleanup EXIT

snapshot() {
  local name="$1"
  "$AGENT_TUI_BIN" --session "$session_id" --json screenshot >"$ARTIFACT_DIR/$name.json"
}

wait_for() {
  printf '[agent-tui-poc] waiting for %q…\n' "$1"
  if ! "$AGENT_TUI_BIN" --session "$session_id" --json wait "$1" --assert --timeout 10000 >/dev/null; then
    snapshot failure
    return 1
  fi
}

wait_gone() {
  printf '[agent-tui-poc] waiting for %q to disappear…\n' "$1"
  if ! "$AGENT_TUI_BIN" --session "$session_id" --json wait "$1" --gone --assert --timeout 10000 >/dev/null; then
    snapshot failure
    return 1
  fi
}

send_command() {
  "$AGENT_TUI_BIN" --session "$session_id" type "$1" >/dev/null
  # agent-tui types character-by-character, which opens Pi autocomplete.
  # Escape closes that popup while retaining editor text; Enter then submits text.
  "$AGENT_TUI_BIN" --session "$session_id" press Escape Enter >/dev/null
}

cp "$ROOT/bifrost.json" "$workspace/bifrost.json"

printf '[agent-tui-poc] starting isolated daemon…\n'
"$AGENT_TUI_BIN" --json daemon start >/dev/null

run_result=$("$AGENT_TUI_BIN" --json run --cwd "$workspace" --cols 120 --rows 36 \
  --env "PI_SKIP_VERSION_CHECK=1" \
  --env "PI_OFFLINE=1" \
  --env "TERM=xterm-256color" \
  --env "COLORTERM=truecolor" \
  -- "$PI_BIN" -e "$ROOT" --approve --no-session --no-tools --provider ollama --model gemma4:12b-mlx)
session_id=$(node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk).on("end", () => process.stdout.write(JSON.parse(input).session_id))' <<<"$run_result")

printf '[agent-tui-poc] asserting startup…\n'
wait_for "Bifrost"
snapshot startup

printf '[agent-tui-poc] asserting dashboard…\n'
send_command "/bifrost"
wait_for "/bifrost preview <prompt>"
snapshot dashboard
"$AGENT_TUI_BIN" --session "$session_id" press Escape >/dev/null
wait_gone "/bifrost preview <prompt>"

printf '[agent-tui-poc] asserting preview dismissal…\n'
send_command "/bifrost classifier off"
wait_for "classifier off"
send_command "/bifrost preview hello"
wait_for "requested candidates (economical):"
snapshot preview
"$AGENT_TUI_BIN" --session "$session_id" press Escape >/dev/null
wait_gone "requested candidates (economical):"
snapshot preview-dismiss

printf '[agent-tui-poc] pass. Snapshots: %s\n' "$ARTIFACT_DIR"
