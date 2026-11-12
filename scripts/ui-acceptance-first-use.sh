#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
resolve_binary(){ node "$ROOT/scripts/resolve-test-binary.mjs" "$1" "$2" "$ROOT"; }
AGENT_TUI_BIN="${AGENT_TUI_BIN:-$(resolve_binary AGENT_TUI_BIN agent-tui)}"
PI_BIN="${PI_BIN:-$(resolve_binary PI_BIN pi)}"
ARTIFACT_DIR="${BIFROST_ACCEPTANCE_ARTIFACT_DIR:-$(mktemp -d)}"
mkdir -p "$ARTIFACT_DIR/captures"

runtime="$(mktemp -d)"
home="$runtime/home"
workspace="$runtime/work"
mkdir -p "$home/.pi/agent" "$workspace"
session_id=""
server_pid=""
port=""

export HOME="$home"
export PI_CODING_AGENT_DIR="$home/.pi/agent"

export AGENT_TUI_SOCKET="$runtime/agent-tui.sock"
export AGENT_TUI_SESSION_STORE="$runtime/sessions.jsonl"
export AGENT_TUI_WS_STATE="$runtime/ws.json"
export AGENT_TUI_UI_STATE="$runtime/ui.json"
export AGENT_TUI_WS_DISABLED=true

tui(){ env -i \
  PATH="$PATH" HOME="$HOME" PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" \
  AGENT_TUI_SOCKET="$AGENT_TUI_SOCKET" AGENT_TUI_SESSION_STORE="$AGENT_TUI_SESSION_STORE" \
  AGENT_TUI_WS_STATE="$AGENT_TUI_WS_STATE" AGENT_TUI_UI_STATE="$AGENT_TUI_UI_STATE" \
  AGENT_TUI_WS_DISABLED=true TERM=xterm-256color \
  "$AGENT_TUI_BIN" "$@"; }

record(){ printf '%s\n' "$1" >>"$ARTIFACT_DIR/tui-first-use.jsonl"; }
release_gates(){
  [[ -n "$port" ]] || return 0
  for model in auto-selection-held-general frontier-healthy; do
    curl --silent --show-error --fail -X POST "http://127.0.0.1:$port/_probe-gate/release?model=$model" >/dev/null 2>&1 || true
  done
}
cleanup(){
  release_gates
  if [[ -n "$session_id" ]]; then
    tui --session "$session_id" kill --yes >/dev/null 2>&1 || true
  fi
  tui --json sessions cleanup --all --yes >/dev/null 2>&1 || true
  tui --json daemon stop --force --yes >/dev/null 2>&1 || true
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  rm -rf "$runtime"
}
trap cleanup EXIT INT TERM

node "$ROOT/scripts/fake-provider-server.mjs" >"$runtime/server.json" &
server_pid=$!
node --input-type=module - "$runtime/server.json" <<'NODE'
import { readFileSync } from "node:fs";
const path = process.argv[2];
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  try {
    const ready = JSON.parse(readFileSync(path, "utf8"));
    if (ready.port) { process.stdout.write(String(ready.port)); process.exit(0); }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 20));
}
throw new Error("local fake provider did not become ready before the deadline");
NODE
port="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port.toString())' "$runtime/server.json")"
cat >"$home/.pi/agent/models.json" <<EOF
{"providers":{"fake":{"baseUrl":"http://127.0.0.1:$port/v1","api":"openai-completions","apiKey":"fixture-only","models":[{"id":"auto-selection-held-general","reasoning":false,"cost":{"input":2,"output":2,"cacheRead":0,"cacheWrite":0}},{"id":"frontier-healthy","reasoning":false,"cost":{"input":10,"output":10,"cacheRead":0,"cacheWrite":0}}]}}}
EOF
cat >"$home/.pi/agent/settings.json" <<'EOF'
{"retry":{"enabled":false},"enabledModels":["fake/*","bifrost/*"]}
EOF

stats(){ node --input-type=module - "$port" <<'NODE'
const response = await fetch(`http://127.0.0.1:${process.argv[2]}/_stats`);
if (!response.ok) throw new Error("fake provider stats unavailable");
process.stdout.write(JSON.stringify(await response.json()));
NODE
}
wait_for_stats(){
  local expression="$1" description="$2"
  node --input-type=module - "$port" "$expression" "$description" <<'NODE'
const [port, expression, description] = process.argv.slice(2);
const predicate = new Function("stats", `return (${expression});`);
const deadline = Date.now() + 20_000;
let last;
while (Date.now() < deadline) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  last = await response.json();
  if (predicate(last.stats)) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 25));
}
throw new Error(`timed out waiting for ${description}; observed ${JSON.stringify(last?.stats ?? [])}`);
NODE
}
snapshot(){ tui --session "$session_id" --json screenshot >"$ARTIFACT_DIR/captures/$1.json"; }
wait_ui(){ echo "[acceptance-tui] waiting for $1"; if ! tui --session "$session_id" --json wait "$1" --assert --timeout 15000 >/dev/null; then snapshot ui-failure; return 1; fi; }
wait_session_exit(){
  local capture="$ARTIFACT_DIR/captures/active-sessions-after-exit.json"
  local deadline=$((SECONDS + 20))
  while (( SECONDS < deadline )); do
    tui --json sessions list >"$capture"
    if node --input-type=module - "$ROOT/scripts/acceptance/journeys.mjs" "$capture" "$session_id" <<'NODE'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [journeysModule, path, sessionId] = process.argv.slice(2);
try {
  const listing = JSON.parse(readFileSync(path, "utf8"));
  const { isSessionActiveInListing } = await import(pathToFileURL(journeysModule));
  if (isSessionActiveInListing(listing, sessionId)) process.exit(1);
} catch {
  process.exit(2);
}
NODE
    then
      return 0
    else
      local status=$?
      if (( status != 1 )); then
        echo "agent-tui session listing was malformed or lacked structured session state" >&2
        return "$status"
      fi
    fi
sleep 0.05
  done
  echo "agent-tui still lists the Pi session after shutdown" >&2
  return 1
}
send(){
  tui --session "$session_id" type "$1" >/dev/null
  tui --session "$session_id" press Escape Enter >/dev/null
}

for model in auto-selection-held-general frontier-healthy; do
  curl --silent --show-error --fail -X POST "http://127.0.0.1:$port/_probe-gate/hold?model=$model" >/dev/null
done
tui --json daemon start >/dev/null
run_result=$(tui --json run --cwd "$workspace" --cols 120 --rows 36 \
  --env "HOME=$home" \
  --env "PI_CODING_AGENT_DIR=$home/.pi/agent" \
  --env "PI_SKIP_VERSION_CHECK=1" \
  --env "PI_OFFLINE=1" \
  --env "TERM=xterm-256color" \
  --env "NODE_OPTIONS=--require=$ROOT/scripts/test-outbound-guard.cjs" \
  --env "BIFROST_TEST_ALLOWED_ORIGIN=http://127.0.0.1:$port" \
  --env "BIFROST_TEST_NETWORK_VIOLATIONS=$runtime/network-violations.log" \
  -- "$PI_BIN" -e "$ROOT" --approve --no-session --no-tools --provider fake --model auto-selection-held-general)
session_id=$(node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).session_id))' <<<"$run_result")

wait_for_stats 'stats.filter(x=>x.kind==="probe"&&!x.completed).length===2' "both controlled probes to remain pending"
snapshot pending-probes
node --input-type=module - "$ROOT/scripts/acceptance/journeys.mjs" "$ARTIFACT_DIR/captures/pending-probes.json" <<'NODE'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [journeysPath, capturePath] = process.argv.slice(2);
const { stripTuiControlSequences } = await import(pathToFileURL(journeysPath));
const capture = JSON.parse(readFileSync(capturePath, "utf8"));
const rendered = stripTuiControlSequences(String(capture.rendered ?? ""));
if (!rendered.includes("Checking models: 0/2") || !rendered.includes("Bifrost · on")) {
  throw new Error(`pending snapshot lacks visible setup progress and Bifrost status context: ${rendered}`);
}
NODE
record '{"event":"pending_progress","pendingProbes":2,"visible":"Checking models: 0/2","status":"Bifrost · on"}'

send "synthetic first-use request"
wait_for_stats 'stats.some(x=>x.kind==="generation"&&x.model==="auto-selection-held-general"&&x.completed)' "first physical generation to complete while probes are held"
wait_ui 'healthy'
snapshot first-turn-held
record '{"event":"first_turn","model":"auto-selection-held-general","completed":true,"probePending":true}'

send "/model"
snapshot model-picker
tui --session "$session_id" type "Bifrost Auto" >/dev/null
tui --session "$session_id" press Enter >/dev/null
wait_ui '(bifrost) auto'
snapshot auto-selected
const_counts=$(stats)
node --input-type=module - "$const_counts" <<'NODE'
const result = JSON.parse(process.argv[2]);
for (const model of ["auto-selection-held-general", "frontier-healthy"]) {
  const probes = result.stats.filter((item) => item.kind === "probe" && item.model === model);
  if (probes.length !== 1 || probes[0].completed) throw new Error(`${model} must retain exactly one pending probe after picker selection`);
}
NODE
counts=$(node --input-type=module - "$const_counts" <<'NODE'
const result = JSON.parse(process.argv[2]);
const models = ["auto-selection-held-general", "frontier-healthy"];
process.stdout.write(JSON.stringify({
  event: "request_counts",
  counts: Object.fromEntries(models.map((model) => [model, Object.fromEntries(["probe", "generation", "classifier"].map((kind) =>
    [kind, result.stats.filter((item) => item.model === model && item.kind === kind).length]))])),
}));
NODE
)
record "$counts"
record '{"event":"auto_selected_during_pending_probes","probeRequests":2,"duplicates":0,"savedConfig":false}'

# Let one probe report, leaving the other deliberately pending at shutdown.
curl --silent --show-error --fail -X POST "http://127.0.0.1:$port/_probe-gate/release?model=frontier-healthy" >/dev/null
wait_for_stats 'stats.some(x=>x.kind==="probe"&&x.model==="frontier-healthy"&&x.completed)&&stats.some(x=>x.kind==="probe"&&x.model==="auto-selection-held-general"&&!x.completed)' "one progress callback with the other probe held"
wait_ui 'Checking models: 1/2'
snapshot one-of-two
send "/quit"
wait_session_exit
session_id=""
wait_for_stats 'stats.some(x=>x.kind==="probe"&&x.model==="auto-selection-held-general"&&x.clientClosed)' "Pi shutdown to cancel its outstanding probe request"
if [[ -e "$workspace/.pi/bifrost.json" || -e "$workspace/.pi/bifrost-reconcile-ownership.json" ]]; then
  echo "shutdown wrote an incomplete bootstrap config or ownership receipt" >&2
  exit 1
fi
curl --silent --show-error --fail -X POST "http://127.0.0.1:$port/_probe-gate/release?model=auto-selection-held-general" >/dev/null
if [[ -e "$workspace/.pi/bifrost.json" || -e "$workspace/.pi/bifrost-reconcile-ownership.json" ]]; then
  echo "releasing the late probe wrote an incomplete bootstrap config or ownership receipt" >&2
  exit 1
fi
if [[ -s "$runtime/network-violations.log" ]]; then
  echo "outbound network guard recorded a violation" >&2
  exit 1
fi
record '{"event":"shutdown_cancelled_pending_probe","gracefulExitObserved":true,"sessionAbsentFromActiveList":true,"probeClientClosed":true,"lateSave":false,"staleUiCallbacks":"not_observed_after_session_exit","shutdownCommand":"/quit","lastVisibleCaption":"Checking models: 1/2"}'
echo "ACCEPTANCE_TUI_PASS"
