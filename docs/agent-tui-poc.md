# agent-tui PTY smoke proof of concept

This is an isolated evaluation of [`agent-tui`](https://github.com/pproenca/agent-tui) as a PTY driver for Pi-Bifrost UI smoke tests.

It does **not** replace [`scripts/ui-smoke.py`](../scripts/ui-smoke.py). The existing Python harness remains UI screenshot coverage while this POC evaluates whether agent-tui can provide more reliable terminal emulation and semantic waiting.

## What it proves

`scripts/ui-smoke-agent-tui.sh` starts an isolated agent-tui daemon and drives a real Pi TUI through its PTY. It asserts:

1. Bifrost appears at startup.
2. `/bifrost` opens dashboard with preview action.
3. `/bifrost preview hello` opens result overlay.
4. `Escape` dismisses dashboard and preview overlay.

It writes agent-tui JSON terminal snapshots to `screenshots/ui-agent-tui-poc/` (ignored by Git).

## Run

Install or provide a pinned `agent-tui` binary, then:

```bash
AGENT_TUI_BIN=/path/to/agent-tui npm run test:ui:agent-tui
```

Optional overrides:

```bash
PI_BIN=/path/to/pi \
ARTIFACT_DIR=/tmp/bifrost-agent-tui-poc \
AGENT_TUI_BIN=/path/to/agent-tui \
npm run test:ui:agent-tui
```

## Isolation

Each run creates temporary values for:

- `AGENT_TUI_SOCKET`
- `AGENT_TUI_SESSION_STORE`
- `AGENT_TUI_WS_STATE`
- `AGENT_TUI_UI_STATE`

WebSocket preview is disabled. Cleanup kills session, cleans daemon sessions, stops daemon, and removes temporary state. No global `agent-tui` daemon/session store is used.

## Evaluation gate

Adopt agent-tui as the primary TUI test driver only if this POC:

- passes repeatedly on supported developer/CI hosts;
- can use a pinned binary installation;
- produces reliable semantic `wait --assert` checks;
- retains Pi-Bifrost-owned scenarios and deterministic model/provider fixtures.

`agent-tui` improves PTY lifecycle, terminal emulation, input, and waiting. It does not make Pi's model registry, provider access, or global Pi settings deterministic. Those need separate fixture work.
