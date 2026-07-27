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
{"providers":{"fake":{"baseUrl":"http://127.0.0.1:$port/v1","api":"openai-completions","apiKey":"test","models":[{"id":"fail","reasoning":false},{"id":"healthy","reasoning":false}]}}}
EOF
cat >"$work/bifrost.json" <<'EOF'
{"enabled":true,"default":"economical","strategy":"cheapest","classifier":{"enabled":false},"reliability":{"failureThreshold":1,"windowMinutes":5,"cooldownMinutes":60},"models":{"economical":["fake/fail","fake/healthy"]},"rules":[{"pattern":"hello","model":"economical"}]}
EOF
export AGENT_TUI_SOCKET="$tmp/a.sock" AGENT_TUI_SESSION_STORE="$tmp/s.jsonl" AGENT_TUI_WS_STATE="$tmp/ws.json" AGENT_TUI_UI_STATE="$tmp/ui.json" AGENT_TUI_WS_DISABLED=true
cleanup(){ "$A" --json sessions cleanup --all --yes >/dev/null 2>&1||true; "$A" --json daemon stop --force --yes >/dev/null 2>&1||true; kill "$server" 2>/dev/null||true; [[ "${KEEP:-}" == 1 ]] || rm -rf "$tmp"; }; trap cleanup EXIT

"$A" --json daemon start >/dev/null
run=$($A --json run --cwd "$work" --cols 120 --rows 36 \
  --env "PI_CODING_AGENT_DIR=$home/.pi/agent" \
  --env "PI_SKIP_VERSION_CHECK=1" \
  -- "$PI" -e "$ROOT" --approve --no-session --no-tools --provider fake --model healthy)
sid=$(node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.parse(s).session_id))' <<<"$run")

# phase 1: prove Bifrost sees fake models
"$A" --session "$sid" wait 'Bifrost' --assert --timeout 15000 >/dev/null

# phase 2: trigger terminal failure and wait for circuit record
"$A" --session "$sid" type hello >/dev/null; "$A" --session "$sid" press Escape Enter >/dev/null
for _ in {1..60}; do
  [[ -f "$work/.pi/bifrost-reliability.json" ]] && grep -q 'fake/fail' "$work/.pi/bifrost-reliability.json" && break
  sleep 1
done
grep -q 'fake/fail' "$work/.pi/bifrost-reliability.json" || { echo 'circuit file never created' >&2; exit 1; }

# phase 3: prove follow-up preview skips broken model
"$A" --session "$sid" type '/bifrost preview hello' >/dev/null; "$A" --session "$sid" press Escape Enter >/dev/null
"$A" --session "$sid" wait 'xx fake/fail' --assert --timeout 15000 >/dev/null
"$A" --session "$sid" wait '=> fake/healthy' --assert --timeout 15000 >/dev/null
echo 'fake-provider reliability E2E: pass'
