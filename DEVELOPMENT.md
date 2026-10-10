# Development

## Requirements

- Node.js must support `--experimental-strip-types`.
- Pi 1.0.1 or newer must be available for integration tests.
- Python 3 and Pillow are needed for `npm run test:ui`.

Install the project dependencies from the repository root:

```bash
npm install --package-lock=false
```

The repository does not track a package lock file. The command above installs the declared packages without creating one.

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
