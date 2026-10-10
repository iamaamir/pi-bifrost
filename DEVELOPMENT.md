# Development

## Requirements

- Use Node.js 24, as CI does. It supports `--experimental-strip-types`.
- Tests use the pinned Pi 1.0.1 dependency.
- Python 3 and Pillow are needed for `npm run test:ui`.
- The project dependencies include `agent-tui` for reliability UI tests.

Install the project dependencies from the repository root:

```bash
npm ci
python3 -m pip install Pillow==12.3.0
```

Use a Python virtual environment if your system Python requires one. Put its executables on `PATH` before running the checks. The committed npm lock file fixes the Node dependency versions.

## Complete verification

Run all release checks with one command:

```bash
npm run verify:release
```

The command checks Pi, Python Pillow, and `agent-tui` before running unit tests, typecheck, the router build, fake-provider integrations, and both UI suites. It records the revision, source hashes, gate results, and log paths under `screenshots/verification/<run>/result.json`. A failed gate or a revision or source change makes the command fail. Local dirty files belong to the tested source snapshot; the manifest records whether the working tree was clean.

CI runs the same command. It uploads the result manifest on each run and uploads logs and screenshots after a failure. The tests use isolated homes and local fake providers. They need no live provider credentials.

Use [the coverage contract](docs/testing-coverage.md) when adding a feature or regression test. Pi tests must assert behavior at the host boundary. Consumer API and deterministic race tests use their own public boundaries.

## Checks

Run the unit tests and TypeScript check before you send a change for review:

```bash
npm test
npm run typecheck
```

Run integration tests when a change affects Pi commands, model dispatch, or routing:

```bash
npm run test:integration
```

The integration tests start Pi in isolated workspaces. Several suites use a local fake provider and block external network requests.

Run the terminal UI smoke test for visible Pi changes:

```bash
npm run test:ui
```

This test uses a local fake provider. It needs Python 3 and Pillow. It writes screenshots and logs under `screenshots/ui-smoke/`.

Run the reliability UI scenarios for circuit, reload, Auto, and queued-turn changes:

```bash
npm run test:ui:reliability
```

This test uses a local fake provider and `agent-tui`. It sets `PI_OFFLINE=1` and blocks external network requests.

`npm run test:ui:agent-tui` is a separate proof of concept. It uses the local Ollama model `gemma4:12b-mlx`. It does not replace `npm run test:ui`.

## Build the router package

The router build creates files in `dist/router/`:

```bash
npm run build:router
```

`npm pack` runs this build through the `prepack` script.
