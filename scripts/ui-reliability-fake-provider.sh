#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
A="${AGENT_TUI_BIN:-$(command -v agent-tui || true)}"
PI="${PI_BIN:-$(command -v pi || true)}"
[[ -n "$A" && -n "$PI" ]] || { echo 'set AGENT_TUI_BIN and PI_BIN' >&2; exit 1; }
tmp="$(mktemp -d)"; home="$tmp/home"; work="$tmp/work"
mkdir -p "$home/.pi/agent" "$work"
node "$ROOT/scripts/fake-provider-server.mjs" >"$tmp/server.json" & server=$!
for _ in {1..50}; do [[ -s "$tmp/server.json" ]] && break; sleep .1; done
port=$(node -p "JSON.parse(require('fs').readFileSync('$tmp/server.json')).port")
cat >"$home/.pi/agent/models.json" <<EOF
{"providers":{"fake":{"baseUrl":"http://127.0.0.1:$port/v1","api":"openai-completions","apiKey":"test","models":[{"id":"fail","reasoning":false},{"id":"healthy","reasoning":false},{"id":"quota","reasoning":false},{"id":"fail-then-ok","reasoning":false}]}}}
EOF
cat >"$work/bifrost.json" <<'EOF'
{"enabled":true,"default":"economical","strategy":"cheapest","classifier":{"enabled":false},"reliability":{"failureThreshold":1,"windowMinutes":5,"cooldownMinutes":60},"models":{"economical":["fake/fail","fake/healthy","fake/quota","fake/fail-then-ok"]},"rules":[{"pattern":"hello","model":"economical"},{"pattern":"quota","model":"economical"},{"pattern":"flaky","model":"economical"}]}
EOF
export AGENT_TUI_SOCKET="$tmp/a.sock" AGENT_TUI_SESSION_STORE="$tmp/s.jsonl" AGENT_TUI_WS_STATE="$tmp/ws.json" AGENT_TUI_UI_STATE="$tmp/ui.json" AGENT_TUI_WS_DISABLED=true
cleanup(){ "$A" --json sessions cleanup --all --yes >/dev/null 2>&1||true; "$A" --json daemon stop --force --yes >/dev/null 2>&1||true; kill "$server" 2>/dev/null||true; [[ "${KEEP:-}" == 1 ]] || rm -rf "$tmp"; }; trap cleanup EXIT

poll_until(){ local path="$1" needle="$2" max="${3:-60}"; for _ in $(seq 1 "$max"); do [[ -f "$path" ]] && grep -q "$needle" "$path" && return 0; sleep 1; done; echo "timed out" >&2; return 1; }
start_pi(){ "$A" --json daemon start >/dev/null; local run; run=$($A --json run --cwd "$work" --cols 120 --rows 36 --env "PI_CODING_AGENT_DIR=$home/.pi/agent" --env "PI_SKIP_VERSION_CHECK=1" -- "$PI" -e "$ROOT" --approve --no-session --no-tools --provider fake --model healthy); node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.parse(s).session_id))' <<<"$run"; }
prompt(){ "$A" --session "$1" type "$2" >/dev/null; "$A" --session "$1" press Escape Enter >/dev/null; }

# ── Scenario 1: terminal stream failure opens circuit ──
echo '--- scenario 1: stream failure ---'
sid=$(start_pi)
"$A" --session "$sid" wait 'Bifrost' --assert --timeout 15000 >/dev/null
prompt "$sid" hello
poll_until "$work/.pi/bifrost-reliability.json" 'fake/fail'
grep -q 'openUntil' "$work/.pi/bifrost-reliability.json" || { echo 'FAIL: circuit not open' >&2; exit 1; }
prompt "$sid" '/bifrost preview hello'
"$A" --session "$sid" wait 'xx fake/fail' --assert --timeout 15000 >/dev/null
"$A" --session "$sid" wait '=> fake/healthy' --assert --timeout 15000 >/dev/null
echo 'scenario 1: pass'
"$A" --json sessions cleanup --all --yes >/dev/null 2>&1||true; "$A" --json daemon stop --force --yes >/dev/null 2>&1||true
# Verify server still alive
curl -sf "http://127.0.0.1:$port/_stats" >/dev/null || { echo 'FAIL: server died after scenario 1' >&2; exit 1; }

# ── Scenario 2: quota (429) opens circuit ──
echo '--- scenario 2: quota ---'
rm -f "$work/.pi/bifrost-reliability.json"
cat >"$work/bifrost.json" <<'EOF'
{"enabled":true,"default":"economical","strategy":"cheapest","classifier":{"enabled":false},"reliability":{"failureThreshold":1,"windowMinutes":5,"cooldownMinutes":60},"models":{"economical":["fake/quota","fake/healthy"]},"rules":[{"pattern":"quota","model":"economical"}]}
EOF
sid=$(start_pi)
"$A" --session "$sid" wait 'Bifrost' --assert --timeout 15000 >/dev/null
prompt "$sid" quota
poll_until "$work/.pi/bifrost-reliability.json" 'fake/quota'
grep -q 'openUntil' "$work/.pi/bifrost-reliability.json" || { echo 'FAIL: quota circuit not open' >&2; exit 1; }
echo 'scenario 2: pass'
"$A" --json sessions cleanup --all --yes >/dev/null 2>&1||true; "$A" --json daemon stop --force --yes >/dev/null 2>&1||true
curl -sf "http://127.0.0.1:$port/_stats" >/dev/null || { echo 'FAIL: server died after scenario 2' >&2; exit 1; }

# ── Scenario 3: successful request creates no circuit state ──
echo '--- scenario 3: no false circuit ---'
rm -f "$work/.pi/bifrost-reliability.json"
cat >"$work/bifrost.json" <<'EOF'
{"enabled":true,"default":"economical","strategy":"cheapest","classifier":{"enabled":false},"reliability":{"failureThreshold":1,"windowMinutes":5,"cooldownMinutes":60},"models":{"economical":["fake/healthy"]},"rules":[{"pattern":"ok","model":"economical"}]}
EOF
sid=$(start_pi)
"$A" --session "$sid" wait 'Bifrost' --assert --timeout 15000 >/dev/null
prompt "$sid" ok
sleep 5
if grep -q 'openUntil' "$work/.pi/bifrost-reliability.json" 2>/dev/null; then
  echo 'FAIL: circuit opened for healthy model' >&2; exit 1
fi
echo 'scenario 3: pass'
"$A" --json sessions cleanup --all --yes >/dev/null 2>&1||true; "$A" --json daemon stop --force --yes >/dev/null 2>&1||true

echo 'all reliability E2E scenarios: pass'
