/**
 * Architecture rules for Bifrost.
 *
 * These rules encode seams the repository already documents, not aspirational
 * layering:
 * - `AGENTS.md`: "Keep policy separate from host adaptation."
 * - `docs/adr/0014-cross-host-portability.md`: the adapter seam table.
 * - `docs/router-api.md`: the resolve-only `pi-bifrost/router` subpath does not
 *   select models, dispatch, read configuration files, or update session state.
 *
 * A rule only belongs here when the current tree passes it. `npm run check:arch`
 * is the enforcement point; `npm run check:arch:json` produces the raw graph.
 */
const HOST_ADAPTERS = "^(index|commands|ux-status|result-viewer|probe)\\.ts$";
const ADAPTER_OWNERS = "^(index|commands)\\.ts$";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  options: {
    // Keep type-only imports visible so the router rule can allow them while
    // still rejecting runtime imports of the host SDK.
    tsPreCompilationDeps: "specify",
    // Keep npm edges (the router rule needs them) but never traverse packages.
    doNotFollow: { path: "node_modules" },
    exclude: { path: ["^dist", "^coverage", "^screenshots", "^reports", "^evidence"] },
    reporterOptions: {
      dot: { collapsePattern: "node_modules/(?:@[^/]+/[^/]+|[^/]+)" },
    },
  },
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular imports make module initialization order observable and hide policy coupling. Fix the seam instead of relaxing this rule.",
      from: {},
      to: { circular: true },
    },
    {
      name: "router-no-runtime-host-sdk",
      severity: "error",
      comment:
        "The packed pi-bifrost/router subpath is host-neutral. It may use Pi types (erased at build) but must not import the host SDK at runtime.",
      from: { path: "^router\\.ts$" },
      to: {
        path: "^node_modules/@earendil-works/",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "router-no-host-adapters",
      severity: "error",
      comment:
        "The resolve-only API must not reach event wiring, commands, status UI, probe transport, or result rendering.",
      from: { path: "^router\\.ts$" },
      to: { path: HOST_ADAPTERS },
    },
    {
      name: "host-ui-imports-only-from-adapter-entry",
      severity: "error",
      comment:
        "Status, result, probe, and command modules are Pi adapter layer. Only index.ts (wiring) and commands.ts (command handlers) may import them; policy modules must not depend on host UI.",
      from: { pathNot: ADAPTER_OWNERS },
      to: { path: HOST_ADAPTERS },
    },
    {
      name: "production-no-dev-dependency",
      severity: "error",
      comment:
        "Shipped root modules run inside Pi and must not import dev-only tooling (tests, mutation, coverage, fuzzing, repository scripts).",
      from: { path: "^[^/]+\\.ts$" },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["npm-peer"] },
    },
    {
      name: "production-no-repository-tooling",
      severity: "error",
      comment: "Shipped modules must not depend on repository scripts, tests, or fixtures.",
      from: { path: "^[^/]+\\.ts$" },
      to: { path: "^(scripts|tests)/" },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      comment: "Unresolvable imports break the packed extension or the router build.",
      from: {},
      to: { couldNotResolve: true },
    },

  ],
};
