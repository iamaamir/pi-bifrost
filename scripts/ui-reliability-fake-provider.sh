#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
resolve_binary(){ node "$ROOT/scripts/resolve-test-binary.mjs" "$1" "$2" "$ROOT"; }
A="$(resolve_binary AGENT_TUI_BIN agent-tui)"
PI="$(resolve_binary PI_BIN pi)"
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
start_pi(){ "$A" --json daemon start >/dev/null; local run; run=$($A --json run --cwd "$work" --cols 120 --rows 36 --env "HOME=$home" --env "PI_CODING_AGENT_DIR=$home/.pi/agent" --env "PI_SKIP_VERSION_CHECK=1" --env "PI_OFFLINE=1" --env "NODE_OPTIONS=--require=$ROOT/scripts/test-outbound-guard.cjs" --env "BIFROST_TEST_ALLOWED_ORIGIN=http://127.0.0.1:$port" --env "BIFROST_TEST_NETWORK_VIOLATIONS=$tmp/test-network-violations.log" -- "$PI" -e "$ROOT" "$@" --approve --no-session --no-tools --provider fake --model healthy); node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>console.log(JSON.parse(s).session_id))' <<<"$run"; }
prompt(){ "$A" --session "$1" type "$2" >/dev/null; "$A" --session "$1" press Escape Enter >/dev/null; }

wait_mode_state(){
  local path="$1" enabled="$2" max="${3:-60}"
  for _ in $(seq 1 "$max"); do
    if [[ -f "$path" ]] && node -e '
const fs = require("node:fs");
const [statePath, enabled] = process.argv.slice(1);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const hasExpectedMode = enabled === "unset"
  ? !Object.hasOwn(state, "enabled")
  : state.enabled === (enabled === "true");
if (!hasExpectedMode || Object.hasOwn(state, "pinned") || Object.hasOwn(state, "classifierEnabled")) process.exit(1);
' "$path" "$enabled" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "FAIL: runtime state mismatch in $path" >&2
  node -e 'const fs = require("node:fs"); const path = process.argv[1]; console.error(fs.readFileSync(path, "utf8"));' "$path" >&2 || true
  exit 1
}

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
rm -f "$work/.pi/bifrost-reliability.json" "$work/.pi/bifrost-provider-reliability.json"
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
rm -f "$work/.pi/bifrost-reliability.json" "$work/.pi/bifrost-provider-reliability.json"
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

# ── Scenario 4: runtime mode survives reloads ──
echo '--- scenario 4: mode persistence across reloads ---'
rm -f "$work/.pi/bifrost-state.json" "$work/.pi/bifrost-reliability.json" "$work/.pi/bifrost-provider-reliability.json"
cat >"$work/bifrost.json" <<'EOF'
{"enabled":true,"default":"economical","strategy":"cheapest","classifier":{"enabled":false},"reliability":{"failureThreshold":1,"windowMinutes":5,"cooldownMinutes":60},"models":{"economical":["fake/healthy"]},"rules":[{"pattern":"ok","model":"economical"}]}
EOF
sid=$(start_pi)
"$A" --session "$sid" wait 'Bifrost · on · classifier off' --assert --timeout 15000 >/dev/null
prompt "$sid" '/bifrost off'
"$A" --session "$sid" wait 'Bifrost · off' --assert --timeout 15000 >/dev/null
wait_mode_state "$work/.pi/bifrost-state.json" false
prompt "$sid" '/reload'
"$A" --session "$sid" wait 'Bifrost · off' --assert --timeout 15000 >/dev/null
wait_mode_state "$work/.pi/bifrost-state.json" false
prompt "$sid" '/bifrost reload'
"$A" --session "$sid" wait 'Bifrost · off' --assert --timeout 15000 >/dev/null
wait_mode_state "$work/.pi/bifrost-state.json" false
prompt "$sid" '/bifrost on'
"$A" --session "$sid" wait 'Bifrost · on · classifier off' --assert --timeout 15000 >/dev/null
wait_mode_state "$work/.pi/bifrost-state.json" unset
prompt "$sid" '/bifrost pin'
"$A" --session "$sid" wait 'Bifrost · pinned' --assert --timeout 15000 >/dev/null
wait_mode_state "$work/.pi/bifrost-state.json" unset
prompt "$sid" '/reload'
"$A" --session "$sid" wait 'Bifrost · on · classifier off' --assert --timeout 15000 >/dev/null
wait_mode_state "$work/.pi/bifrost-state.json" unset
prompt "$sid" '/bifrost reload'
"$A" --session "$sid" wait 'Bifrost · on · classifier off' --assert --timeout 15000 >/dev/null
wait_mode_state "$work/.pi/bifrost-state.json" unset
echo 'scenario 4: pass'
"$A" --json sessions cleanup --all --yes >/dev/null 2>&1||true; "$A" --json daemon stop --force --yes >/dev/null 2>&1||true

# ── Scenario 5: /model picker selects Bifrost Auto and routes a prompt ──
echo '--- scenario 5: model picker -> bifrost/auto ---'
rm -f "$work/.pi/bifrost-state.json" "$work/.pi/bifrost-reliability.json" "$work/.pi/bifrost-provider-reliability.json"
cat >"$work/bifrost.json" <<'EOF'
{"enabled":true,"default":"economical","strategy":"cheapest","classifier":{"enabled":false},"models":{"economical":["fake/healthy"]},"rules":[{"pattern":"hello","model":"economical"}],"debug":{"enabled":true,"path":".pi/bifrost-debug.jsonl"}}
EOF
sid=$(start_pi)
"$A" --session "$sid" wait 'Bifrost' --assert --timeout 15000 >/dev/null
prompt "$sid" '/model'
"$A" --session "$sid" type 'Bifrost Auto' >/dev/null
"$A" --session "$sid" press Enter >/dev/null
"$A" --session "$sid" wait '(bifrost) auto' --assert --timeout 15000 >/dev/null
prompt "$sid" 'hello world'
poll_until "$work/.pi/bifrost-debug.jsonl" '"event":"virtual_auto"'
poll_until "$work/.pi/bifrost-debug.jsonl" '"event":"result"'
grep -q '"event":"dispatch","entryType":"event","model":"fake/healthy"' "$work/.pi/bifrost-debug.jsonl" || { echo 'FAIL: auto route did not dispatch fake/healthy' >&2; exit 1; }
echo 'scenario 5: pass'
"$A" --json sessions cleanup --all --yes >/dev/null 2>&1||true; "$A" --json daemon stop --force --yes >/dev/null 2>&1||true

# ── Scenario 6: steer-queued prompts dispatch and settle within one run ──
# Use the existing fake-provider gate to keep the first request active while
# entering steer prompts. Native lifecycle events, not elapsed time, prove
# whether the messages shared the same run.
observer="$ROOT/tests/fixtures/ui-reliability-run-observer.mjs"
proof="$ROOT/tests/fixtures/ui-reliability-run-proof.mjs"

generation_gate(){
  curl -fsS --max-time 5 -X POST "http://127.0.0.1:$port/_generation-gate/$1?model=$2" >/dev/null
}

wait_settled_count(){
  local expected="$1"
  for _ in $(seq 1 60); do
    if [[ -f "$work/.pi/ui-run.jsonl" ]] &&
       [[ $(grep -c '"type":"settled"' "$work/.pi/ui-run.jsonl" || true) -ge "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "FAIL: native settlement $expected not observed" >&2
  cat "$work/.pi/ui-run.jsonl" >&2 || true
  return 1
}

wait_held_generation(){
  local model="$1"
  for _ in $(seq 1 60); do
    curl -fsS --max-time 5 "http://127.0.0.1:$port/_stats" >"$work/current-stats.json"
    if node -e '
const fs = require("node:fs");
const [before, current] = process.argv.slice(1, 3).map((path) => JSON.parse(fs.readFileSync(path)));
if (!current.stats.slice(before.stats.length).some((stat) => stat.kind === "generation" && stat.model === process.argv[3] && !stat.completed)) process.exit(1);
' "$work/before.json" "$work/current-stats.json" "$model"; then return 0; fi
    sleep 1
  done
  echo 'FAIL: held initial generation not observed' >&2
  return 1
}

# Collect all independent proof failures in one run. Setup, transport and
# terminal-wait failures still abort immediately under set -e.
proof_failed=0
check_multi_dispatch_proof(){
  local mode="$1" snapshot="$2"
  if ! node "$proof" "$mode" "$work" "$work/before.json" "$snapshot"; then
    proof_failed=1
    echo "FAIL: scenario 6 $mode proof" >&2
    cat "$work/.pi/ui-run.jsonl" "$work/.pi/bifrost-reliability.json" >&2 || true
    cat "$work/before.json" "$snapshot" >&2 || true
    tail -n 80 "$work/.pi/bifrost-debug.jsonl" >&2 || true
  fi
}

run_multi_dispatch(){
  local mode="$1"
  home="$tmp/home-$mode"; work="$tmp/work-$mode"
  mkdir -p "$home/.pi/agent" "$work/.pi"
  cat >"$home/.pi/agent/models.json" <<EOF
{"providers":{"fake":{"baseUrl":"http://127.0.0.1:$port/v1","api":"openai-completions","apiKey":"test","models":[{"id":"healthy","reasoning":false},{"id":"fast","reasoning":false},{"id":"strong","reasoning":false},{"id":"slow","reasoning":false}]}}}
EOF
  echo '{"retry":{"enabled":false},"steeringMode":"one-at-a-time"}' >"$home/.pi/agent/settings.json"
  cat >"$work/bifrost.json" <<'EOF'
{"enabled":true,"default":"quick","strategy":"first","classifier":{"enabled":false},"reliability":{"enabled":true,"failureThreshold":1,"windowMinutes":5,"cooldownMinutes":60},"models":{"quick":["fake/fast"],"frontier":["fake/strong"],"hold":["fake/slow"]},"rules":[{"pattern":"hold","model":"hold"}],"debug":{"enabled":true,"path":".pi/bifrost-debug.jsonl"}}
EOF
  echo '{"version":1,"models":{"fake/fast":{"failures":[1],"openUntil":1,"trialActive":false}}}' >"$work/.pi/bifrost-reliability.json"
  sid=$(start_pi -e "$observer")
  "$A" --session "$sid" wait 'Bifrost' --assert --timeout 15000 >/dev/null
  prompt "$sid" '/model'
  "$A" --session "$sid" type 'Bifrost Auto' >/dev/null
  "$A" --session "$sid" press Enter >/dev/null
  "$A" --session "$sid" wait '(bifrost) auto' --assert --timeout 15000 >/dev/null
  curl -fsS --max-time 5 "http://127.0.0.1:$port/_stats" >"$work/before.json"
  generation_gate hold slow
  if [[ "$mode" == positive ]]; then generation_gate hold fast; fi
  prompt "$sid" 'hold please'
  wait_held_generation slow
  if [[ "$mode" == separate ]]; then
    generation_gate release slow
    wait_settled_count 1
    prompt "$sid" 'frontier one'
    wait_settled_count 2
    prompt "$sid" 'quick two'
    wait_settled_count 3
  else
    "$A" --session "$sid" type 'frontier one' >/dev/null
    "$A" --session "$sid" press Enter >/dev/null
    if [[ "$mode" == positive ]]; then
      "$A" --session "$sid" type 'quick two' >/dev/null
      "$A" --session "$sid" press Enter >/dev/null
    fi
    generation_gate release slow
    if [[ "$mode" == positive ]]; then
      wait_held_generation fast
      # Real negative control: the third dispatch exists, but it is held
      # before completion and its trial is still active. The same proof must
      # reject this snapshot before accepting the eventual settled run.
      check_multi_dispatch_proof pending "$work/current-stats.json"
      generation_gate release fast
    fi
    wait_settled_count 1
  fi
  # The outcome event precedes the persisted write; require both within the
  # existing bound before accepting the settled trial.
  local expected=3
  [[ "$mode" != missing ]] || expected=2
  for _ in $(seq 1 60); do
    if [[ -f "$work/.pi/bifrost-debug.jsonl" ]] &&
       [[ $(grep -c '"event":"legacy_outcome_observed"' "$work/.pi/bifrost-debug.jsonl" || true) -ge "$expected" ]]; then
      curl -fsS --max-time 5 "http://127.0.0.1:$port/_stats" >"$work/after.json"
      if [[ "$mode" == missing ]] || node "$proof" settled-state "$work" "$work/before.json" "$work/after.json" >/dev/null 2>&1; then
        break
      fi
    fi
    sleep 1
  done
  [[ -f "$work/after.json" ]] || curl -fsS --max-time 5 "http://127.0.0.1:$port/_stats" >"$work/after.json"
  check_multi_dispatch_proof "$mode" "$work/after.json"
  "$A" --json sessions cleanup --all --yes >/dev/null 2>&1||true
  "$A" --json daemon stop --force --yes >/dev/null 2>&1||true
}
echo '--- scenario 6: queued multi-dispatch settlement and runtime controls ---'
run_multi_dispatch positive
run_multi_dispatch missing
run_multi_dispatch separate
if (( proof_failed != 0 )); then
  echo 'FAIL: one or more scenario 6 lifecycle proofs failed' >&2
  exit 1
fi
echo 'scenario 6: pass'

if [[ -s "$tmp/test-network-violations.log" ]]; then
  echo 'FAIL: test network guard recorded a blocked external request' >&2
  cat "$tmp/test-network-violations.log" >&2
  exit 1
fi
echo 'all reliability E2E scenarios: pass'
