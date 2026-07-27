# agent-tui PTY evaluation

## Decision

Adopt [`agent-tui`](https://github.com/pproenca/agent-tui) gradually as Pi-Bifrost's **behavioral** TUI test driver.

Keep `scripts/ui-smoke.py` unchanged for current visual screenshot coverage. Do not invest further in its handwritten ANSI `Screen` emulator. Do not make `agent-tui` a Pi-Bifrost runtime dependency.

## Why this evaluation happened

Current `scripts/ui-smoke.py` creates a real PTY and drives Pi, which is valuable. Its output renderer is custom and partial, while its control flow is primarily fixed sleeps and screenshots. It can produce a blank or stale capture without a semantic test failure.

`agent-tui` offers a production terminal-emulation layer with real PTYs, process/session lifecycle, native screen state, JSON snapshots, and explicit wait assertions. It was evaluated only as a development/CI test tool.

## POC implementation

Commit `6c779c57` added an isolated runner:

```bash
AGENT_TUI_BIN=/path/to/agent-tui npm run test:ui:agent-tui
```

- Runner: [`scripts/ui-smoke-agent-tui.sh`](../scripts/ui-smoke-agent-tui.sh)
- Operational guide: [`docs/agent-tui-poc.md`](agent-tui-poc.md)
- Existing Python smoke: [`scripts/ui-smoke.py`](../scripts/ui-smoke.py)

The POC runs Pi through `agent-tui` and asserts:

1. startup exposes Bifrost;
2. `/bifrost` exposes dashboard preview action;
3. `/bifrost preview hello` opens result overlay;
4. `Escape` closes dashboard and preview overlay.

It stores raw agent-tui JSON snapshots under `screenshots/ui-agent-tui-poc/`, which Git ignores.

## Evidence

Evaluated with `agent-tui 1.1.0`, installed only under `/tmp/agent-tui-poc`; no global install was made.

Final verification:

```text
AGENT_TUI_BIN=/tmp/agent-tui-poc/node_modules/.bin/agent-tui npm run test:ui:agent-tui  # pass
npm run test:ui                                                                           # pass
AGENT_TUI_BIN=/tmp/agent-tui-poc/node_modules/.bin/agent-tui npm run test:ui:agent-tui  # pass
```

The POC passed twice. Existing Python smoke still passed unchanged.

## What agent-tui improves

| Capability | Current Python harness | agent-tui POC |
|---|---|---|
| PTY | Real PTY | Real PTY |
| Terminal state | Local partial ANSI emulator | Dedicated terminal emulator |
| Synchronization | Fixed sleeps | `wait --assert` / `wait --gone --assert` |
| Failure evidence | Screenshot may be stale | Native JSON terminal snapshot on assertion failure |
| Lifecycle | Manual subprocess/process-group cleanup | Isolated daemon/session cleanup plus process controls |
| Semantic CI signal | No content assertions | Explicit content assertions with nonzero failure |

## Learnings and constraints

### 1. Character-by-character input activates Pi autocomplete

`agent-tui type` intentionally sends text character-by-character. In Pi, typing `/bifrost classifier off` opens slash-command autocomplete. Sending `Enter` immediately selected root `/bifrost` completion instead of submitting full command, opening the command picker.

POC workaround:

```text
agent-tui type <command>
agent-tui press Escape Enter
```

First `Escape` closes autocomplete while retaining editor text; `Enter` submits it. Keep this behavior covered if runner evolves. Prefer a future paste/raw-input API if agent-tui exposes one and Pi behavior is verified.

### 2. Screen stability is not a universal readiness condition

Pi's animated footer spinner redraws continuously. `agent-tui wait --stable --assert` timed out even when UI was ready.

Use expected-state text assertions instead:

- wait for `Bifrost` at startup;
- wait for dashboard action text;
- wait for overlay content;
- wait for overlay content to disappear.

Do not reintroduce sleeps as readiness logic. A bounded wait is still required to fail rather than hang.

### 3. Native terminal emulation does not isolate Pi

Snapshots showed globally installed Pi extensions and inherited Pi preferences. Pi model registry/provider access and settings can still vary by machine. `agent-tui` solves terminal fidelity, not application determinism.

Before agent-tui becomes CI-required, isolate or fixture:

- Pi settings/profile and extension discovery;
- model registry/provider behavior;
- Bifrost test config;
- required Pi executable/version.

Avoid real classifier/provider calls in required UI tests.

### 4. agent-tui daemon state must be isolated

POC uses a fresh temporary directory for:

- `AGENT_TUI_SOCKET`
- `AGENT_TUI_SESSION_STORE`
- `AGENT_TUI_WS_STATE`
- `AGENT_TUI_UI_STATE`

It disables WebSocket preview and always kills session, cleans sessions, stops daemon, and removes temp state. Preserve this pattern. Never let CI or a test run share default `~/.agent-tui` state.

### 5. Preserve visual coverage during migration

agent-tui snapshots are useful machine-readable terminal state, not a replacement PNG review artifact yet. Keep `scripts/ui-smoke.py` while human visual screenshot review remains needed. New interaction/behavior scenarios should be added first to agent-tui.

## Recommended migration

### Phase A — current state

- Keep both harnesses.
- Treat `test:ui:agent-tui` as opt-in POC.
- Add semantic interaction scenarios to agent-tui only when they need a real PTY.

### Phase B — CI candidate

1. Pin agent-tui version and provide a verified CI installation path.
2. Create deterministic Pi/model fixtures.
3. Run POC scenarios repeatedly on supported macOS/Linux environments.
4. Add agent-tui behavioral suite to CI as non-blocking first.

### Phase C — primary behavioral driver

Promote agent-tui to required behavioral smoke only after Phase B is reliable. Retain or replace Python screenshots separately, based on whether an equivalent human-review artifact is still required.

## Non-goals

- No global agent-tui installation.
- No new Pi-Bifrost runtime dependency.
- No deletion or rewrite of `scripts/ui-smoke.py`.
- No claim that terminal emulation fixes provider/model nondeterminism.
