import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { after, before, describe, it, test } from "node:test";
import ts from "typescript";
import { acquirePackLock } from "./fixtures/pack-lock.mjs";

const require = createRequire(import.meta.url);
const typescriptCompiler = require.resolve("typescript/bin/tsc");

function linkInstalledDependencies(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "pi-bifrost") continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.name.startsWith("@")) {
      mkdirSync(destinationPath, { recursive: true });
      for (const scopedPackage of readdirSync(sourcePath)) {
        if (scopedPackage.startsWith(".") || existsSync(join(destinationPath, scopedPackage))) continue;
        symlinkSync(join(sourcePath, scopedPackage), join(destinationPath, scopedPackage), "dir");
      }
    } else if (!existsSync(destinationPath)) {
      // The packed install already placed runtime dependencies; only the
      // host-provided dev dependencies need linking here.
      symlinkSync(sourcePath, destinationPath, "dir");
    }
  }
}

/** Pack the project's runtime dependency closure from the local install so a
 * consumer's `--offline` install never needs the registry. */
function packRuntimeDependencies(cache) {
  const rootPackage = packageJsonOf(process.cwd());
  const tarballs = [];
  const seen = new Set();
  const queue = Object.keys(rootPackage.dependencies ?? {});
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const directory = join(process.cwd(), "node_modules", ...name.split("/"));
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) queue.push(dependency);
    const packed = JSON.parse(execFileSync("npm", [
      "pack", "--json", "--cache", cache, "--pack-destination", cache, directory,
    ], { encoding: "utf8", timeout: 60_000 }))[0];
    tarballs.push(join(cache, packed.filename));
  }
  return tarballs;
}

/** Install the packed API into a temporary consumer that installs nothing else. */
function installPackedPackage(cache, consumer) {
  const packed = JSON.parse(execFileSync("npm", [
    "pack", "--json", "--cache", cache, "--pack-destination", cache,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 }))[0];
  execFileSync("npm", [
    "install", "--prefix", consumer, "--cache", cache, "--offline", "--ignore-scripts",
    "--no-audit", "--no-fund", ...packRuntimeDependencies(cache), join(cache, packed.filename),
  ], { cwd: consumer, encoding: "utf8", stdio: "pipe", timeout: 60_000 });
  return packed;
}

function listFiles(directory, prefix = "") {
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(prefix ? `${prefix}/${child}` : child);
    }
  };
  walk("");
  return files.sort();
}

function installedRouterFiles(consumer) {
  const packageRoot = join(consumer, "node_modules", "pi-bifrost");
  return { packageRoot, routerFiles: listFiles(join(packageRoot, "dist", "router"), "dist/router") };
}

/**
 * Compiled JS and declaration inventory derived from the router build project's
 * own module resolution, not from the emitted directory. TypeScript resolves
 * every import form the build supports (`./`, `../`, path mappings), so a file
 * the build emits cannot drop out of the expectation. An output the build
 * failed to write still shows up as a gap instead of shrinking the expectation.
 */
function expectedRouterInventory(entry, root) {
  const { compilerOptions } = JSON.parse(readFileSync(join(root, "tsconfig.router-build.json"), "utf8"));
  const { options, errors } = ts.convertCompilerOptionsFromJson(compilerOptions, root);
  assert.deepEqual(errors, [], "the router build config must convert without option errors");
  const program = ts.createProgram({ rootNames: [join(root, entry)], options: { ...options, noEmit: true } });
  const rootDir = options.rootDir ?? root;
  const outDir = relative(root, options.outDir ?? join(root, "dist", "router")).split(sep).join("/");
  return program.getSourceFiles()
    .filter((file) => !file.isDeclarationFile && !file.fileName.split(sep).includes("node_modules"))
    .map((file) => relative(rootDir, file.fileName).split(sep).join("/"))
    .flatMap((file) => [`${outDir}/${file.slice(0, -3)}.js`, `${outDir}/${file.slice(0, -3)}.d.ts`])
    .sort();
}

function inventoryGaps(expected, actual) {
  return expected.filter((file) => !actual.includes(file));
}

/** Host-neutral guarantee: nothing shipped for the router API may reference the Pi packages. */
function assertNoPackageReferences(packageRoot, routerFiles) {
  for (const file of routerFiles) {
    const content = readFileSync(join(packageRoot, file), "utf8");
    assert.ok(!content.includes("earendil"), `${file} references the Pi packages`);
  }
}

function assertOptionalPiPeers(packageRoot) {
  const packageJson = packageJsonOf(packageRoot);
  assert.deepEqual(packageJson.peerDependenciesMeta, {
    "@earendil-works/pi-ai": { optional: true },
    "@earendil-works/pi-coding-agent": { optional: true },
    "@earendil-works/pi-tui": { optional: true },
  }, "Pi packages must remain optional peers");
}

function packageJsonOf(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

/** Publication inventory: runtime TS including declarations, never test artifacts. */
function modulePublishedFiles(root) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "tests") walk(join(directory, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !/\.test\.(?:ts|mjs)$/u.test(entry.name)) {
        files.push(rel);
      }
    }
  };
  try {
    walk("modules", "modules");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return files.sort();
}

const TYPES_CONSUMER = `
  import { createRouter, type RouterSnapshot, type RouterResolveResult } from "pi-bifrost/router";
  import {
    modelContextSize, modelCost, modelInputCost, modelOutputCost, selectModel,
    type RoutingModelBase,
  } from "pi-bifrost/dist/router/routing.js";
  const model = { provider: "fixture", id: "small", cost: { input: 0.1, output: 0.2 }, contextWindow: 32000 };
  // The metric accessors stay declared over the published RoutingModelBase, not
  // the capability's wider structural input. Exact-type equality fails if a
  // re-export widens a parameter, which callers still compile against.
  type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const expectExactType = <T extends true>(): void => undefined;
  expectExactType<Same<typeof modelCost, (model: RoutingModelBase) => number>>();
  expectExactType<Same<typeof modelInputCost, (model: RoutingModelBase) => number>>();
  expectExactType<Same<typeof modelOutputCost, (model: RoutingModelBase) => number>>();
  expectExactType<Same<typeof modelContextSize, (model: RoutingModelBase) => number>>();
  const routingModel: RoutingModelBase = model;
  const metricTotal: number = modelCost(routingModel) + modelInputCost(routingModel)
    + modelOutputCost(routingModel) + modelContextSize(routingModel);
  const selected = selectModel([routingModel], "cheapest");
  void (selected ?? routingModel);
  void metricTotal;
  const snapshot: RouterSnapshot = {
    config: { models: { quick: ["fixture/small"] }, default: "quick", strategy: "first", rules: [] },
    registry: { knownModels: [model], availableModels: [model] },
    now: Date.now(),
  };
  createRouter(snapshot).resolve({ prompt: "typed consumer" });
  // @ts-expect-error prompt is required by the packed declaration.
  createRouter(snapshot).resolve({});
  const checkExhaustive = (result: RouterResolveResult): string =>
    result.status === "aborted"
      ? "aborted"
      : result.decision.outcome === "selected"
        ? result.decision.selected ?? ""
        : result.decision.outcome;
  const checkNarrow: string = checkExhaustive({ version: 1, status: "aborted", asOf: 0 });
`;

function compileTypeConsumer(consumer, source) {
  writeFileSync(join(consumer, "types-consumer.ts"), source);
  execFileSync(process.execPath, [typescriptCompiler,
    "--noEmit", "--strict", "--skipLibCheck", "false", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "types-consumer.ts",
  ], { cwd: consumer, encoding: "utf8", stdio: "pipe", timeout: 30_000 });
}

describe("packed experimental router consumer", () => {
  // `npm pack` runs the `prepack` build, which replaces this checkout's shared
  // `dist/router` in place. The unit suite runs this file while the acceptance
  // runner's full unit gate runs the same file in a child process, so
  // without a cross-process lock one pack archives a tree the other is
  // rebuilding (CI saw ENOENT dist/router and TS2307 on ./routing.ts).
  let releasePackLock;
  before(() => { releasePackLock = acquirePackLock(process.cwd()); });
  after(() => { releasePackLock?.(); });

  it("installs the packed JS API and resolves without loader flags on Node 22.19+", () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    assert.ok(major > 22 || major === 22 && minor >= 19, "the API package test requires Node 22.19 or newer");
    const temporary = mkdtempSync(join(tmpdir(), "pi-bifrost-router-pack-"));
    const cache = join(temporary, "npm-cache");
    const consumer = join(temporary, "consumer");
    try {
      mkdirSync(cache);
      mkdirSync(consumer);
      const packed = installPackedPackage(cache, consumer);
      const { packageRoot, routerFiles } = installedRouterFiles(consumer);
      const archivePaths = packed.files.map((file) => file.path);
      const rootSources = readdirSync(process.cwd()).filter((path) => path.endsWith(".ts"));
      const uiSources = readdirSync(join(process.cwd(), "ui")).filter((path) => path.endsWith(".ts")).map((path) => `ui/${path}`);
      const moduleSources = modulePublishedFiles(process.cwd());
      const expectedRouterFiles = expectedRouterInventory("router.ts", process.cwd());
      // The installed walk and the source-derived expectation are independent;
      // a compiled file the archive lost cannot satisfy both.
      assert.deepEqual(routerFiles, expectedRouterFiles,
        "compiled router output must match the entry's source import closure");
      assert.deepEqual(inventoryGaps(expectedRouterFiles, archivePaths), [],
        "every compiled router JS and declaration must ship");
      assert.deepEqual(packageJsonOf(packageRoot).exports["./router"], {
        types: "./dist/router/router.d.ts",
        import: "./dist/router/router.js",
      });
      assert.deepEqual(packageJsonOf(packageRoot).exports["./*"], "./*", "legacy package subpaths stay mapped");
      assert.deepEqual(packageJsonOf(packageRoot).pi.extensions, ["./index.ts"], "the Pi extension entry stays unchanged");
      // The agent skill must be discoverable from the installed package: Pi reads
      // the declared skill directory, which has to contain a readable SKILL.md.
      assert.deepEqual(packageJsonOf(packageRoot).pi.skills, ["./skills/configure-bifrost"], "the package declares its agent skill");
      const installedSkill = join(packageRoot, "skills", "configure-bifrost", "SKILL.md");
      assert.ok(existsSync(installedSkill), "the installed package ships the agent skill");
      assert.match(readFileSync(installedSkill, "utf8"), /^---\nname: configure-bifrost\ndescription: /, "the installed skill has loadable frontmatter");
      assert.ok(existsSync(join(packageRoot, "skills", "configure-bifrost", "references", "configuration-reference.md")));
      assert.ok(readFileSync(join(packageRoot, "index.ts"), "utf8"));
      assertOptionalPiPeers(packageRoot);
      const agentSkill = [
        "skills/configure-bifrost/SKILL.md",
        "skills/configure-bifrost/references/configuration-reference.md",
      ];
      for (const required of [...rootSources, ...uiSources, ...moduleSources, ...expectedRouterFiles, "bifrost.json", "schema.json", "package.json", "README.md", "CHANGELOG.md", "LICENSE", "docs/router-api.md", ...agentSkill]) {
        assert.ok(archivePaths.includes(required), `release archive missing ${required}`);
      }
      assert.ok(archivePaths.every((path) => path.endsWith(".ts") && !path.includes("/")
        || ["bifrost.json", "schema.json", "README.md", "CHANGELOG.md", "LICENSE", "package.json", "docs/router-api.md"].includes(path)
        || routerFiles.includes(path)
        || uiSources.includes(path)
        || moduleSources.includes(path)
        || path.startsWith("examples/")
        || agentSkill.includes(path)), "release contains files outside source, UI, router API, module runtime, examples, and agent skill allowlists");
      assert.ok(archivePaths.includes("dist/router/router.js"), "the package must contain built JS");
      assert.ok(archivePaths.includes("dist/router/router.d.ts"), "the package must contain API declarations");
      assertNoPackageReferences(packageRoot, routerFiles);
      assert.ok(!existsSync(join(consumer, "node_modules", "@earendil-works")),
        "the router package must not install the optional Pi peers on its own");

      // The Pi extension still needs the host packages; link them only for this
      // compatibility half of the test. The standalone half below proves the
      // router API and declarations work without them.
      linkInstalledDependencies(join(process.cwd(), "node_modules"), join(consumer, "node_modules"));

      // TypeScript declarations must resolve without Pi references. skipLibCheck
      // stays off so the whole reachable declaration graph is checked.
      compileTypeConsumer(consumer, TYPES_CONSUMER);

      const consumerSource = `
        import assert from "node:assert/strict";
        import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
        import { tmpdir } from "node:os";
        import { dirname, join } from "node:path";
        import { fileURLToPath } from "node:url";
        import { createRouter } from "pi-bifrost/router";
        import { createJiti } from "jiti";
        const jiti = createJiti(import.meta.url);
        const piExtension = await jiti.import("pi-bifrost/index.ts");
        assert.equal(typeof piExtension.default, "function");
        const model = { provider: "fixture", id: "small", cost: { input: 0.1, output: 0.2 }, contextWindow: 32000 };
        const router = createRouter({
          config: { models: { quick: ["fixture/small"] }, default: "quick", strategy: "first", rules: [] },
          registry: { knownModels: [model], availableModels: [model] }, now: 1000,
        });
        const result = await router.resolve({ prompt: "simple request" });
        assert.equal(result.status, "completed");
        assert.equal(result.decision.selected, "fixture/small");
        assert.equal(result.asOf, 1000);
        assert.equal(existsSync(".pi/bifrost-reliability.json"), false, "resolve-only import and route do not write reliability state");
        assert.equal(import.meta.resolve("pi-bifrost/inline-override.ts").endsWith("/inline-override.ts"), true);

        let classifyStarted = false;
        const abortRouter = createRouter({
          config: { models: { quick: ["fixture/small"] }, default: "quick", rules: [], classifier: { enabled: true } },
          registry: { knownModels: [model], availableModels: [model] }, now: 1000,
        }, { networkClassifierGrant: true, networkClassifier: {
          classify: async () => {
            classifyStarted = true;
            return await new Promise(() => {});
          },
        } });
        const controller = new AbortController();
        const pending = abortRouter.resolve({ prompt: "request", signal: controller.signal });
        const startDeadline = Date.now() + 5_000;
        while (!classifyStarted && Date.now() < startDeadline) await new Promise((resolve) => setTimeout(resolve, 1));
        assert.equal(classifyStarted, true, "the fake classifier must start before the bounded wait expires");
        controller.abort();
        assert.deepEqual(await pending, { version: 1, status: "aborted", asOf: 1000 });

        // A classifier port is a capability, not a grant: it stays cold without an
        // explicit grant even when classification is enabled, and cold when disabled.
        const classifierRegistry = { knownModels: [model], availableModels: [model] };
        let ungrantedCalls = 0;
        const ungrantedRouter = createRouter({
          config: { models: { quick: ["fixture/small"] }, default: "quick", rules: [], classifier: { enabled: true } },
          registry: classifierRegistry, now: 1000,
        }, { networkClassifier: { classify: async () => { ungrantedCalls += 1; return { tier: "quick", backend: "test" }; } } });
        const ungrantedResult = await ungrantedRouter.resolve({ prompt: "ungranted classifier request" });
        assert.equal(ungrantedResult.status, "completed");
        assert.equal(ungrantedCalls, 0, "a classifier port without networkClassifierGrant must never be invoked");
        assert.equal(ungrantedResult.decision.classification.classifier, undefined,
          "an ungranted classifier never contributes a classifier identity");
        assert.equal(ungrantedResult.decision.selected, "fixture/small");

        let disabledCalls = 0;
        const disabledRouter = createRouter({
          config: { models: { quick: ["fixture/small"] }, default: "quick", rules: [], classifier: { enabled: false } },
          registry: classifierRegistry, now: 1000,
        }, { networkClassifierGrant: true, networkClassifier: { classify: async () => { disabledCalls += 1; return { tier: "quick", backend: "test" }; } } });
        const disabledResult = await disabledRouter.resolve({ prompt: "disabled classifier request" });
        assert.equal(disabledResult.status, "completed");
        assert.equal(disabledCalls, 0, "a disabled classifier must never invoke a granted port");
        assert.equal(disabledResult.decision.classification.classifier, undefined);

        // Config-source inheritance composes through the packaged loader: the global
        // layer supplies inherited models, the project layer overrides scalars and
        // colliding entries, and both survive the loader boundary unchanged.
        const { loadConfig } = await jiti.import("pi-bifrost/config-load.ts");
        const inheritanceRoot = mkdtempSync(join(tmpdir(), "pi-bifrost-config-inherit-"));
        try {
          const agentDir = join(inheritanceRoot, "agent");
          const projectCwd = join(inheritanceRoot, "workspace");
          mkdirSync(agentDir, { recursive: true });
          mkdirSync(join(projectCwd, ".pi"), { recursive: true });
          writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
            enabled: true,
            default: "globalTier",
            strategy: "first",
            models: { globalTier: ["fixture/global"], shared: ["fixture/global"] },
          }));
          writeFileSync(join(projectCwd, ".pi", "bifrost.json"), JSON.stringify({
            default: "projectTier",
            models: { projectTier: ["fixture/project"], shared: ["fixture/project"] },
          }));
          const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
          process.env.PI_CODING_AGENT_DIR = agentDir;
          try {
            const extensionDir = dirname(fileURLToPath(import.meta.resolve("pi-bifrost/bifrost.json")));
            const inherited = loadConfig(projectCwd, extensionDir);
            assert.equal(inherited.default, "projectTier", "the project layer overrides the inherited scalar default");
            assert.equal(inherited.strategy, "first", "the inherited global scalar default survives the project layer");
            assert.deepEqual(inherited.models.globalTier, ["fixture/global"], "a global-only model tier is inherited");
            assert.deepEqual(inherited.models.projectTier, ["fixture/project"], "a project-only model tier is added");
            assert.deepEqual(inherited.models.shared, ["fixture/project"], "the project layer overrides a colliding inherited tier");
          } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
          }
        } finally {
          rmSync(inheritanceRoot, { recursive: true, force: true });
        }
      `;
      execFileSync(process.execPath, ["--input-type=module", "-e", consumerSource], {
        cwd: consumer,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 30_000,
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("compiles and runs the shipped examples in a clean standalone consumer with no Pi packages installed", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pi-bifrost-router-standalone-"));
    const cache = join(temporary, "npm-cache");
    const consumer = join(temporary, "consumer");
    try {
      mkdirSync(cache);
      mkdirSync(consumer);
      installPackedPackage(cache, consumer);
      const { packageRoot, routerFiles } = installedRouterFiles(consumer);
      assertNoPackageReferences(packageRoot, routerFiles);
      assertOptionalPiPeers(packageRoot);
      const consumerModules = join(consumer, "node_modules");
      assert.ok(!existsSync(join(consumerModules, "@earendil-works")), "a standalone consumer must not receive the Pi packages");

      // The published declaration graph must resolve without Pi packages and
      // without skipLibCheck.
      compileTypeConsumer(consumer, TYPES_CONSUMER);

      mkdirSync(join(consumer, "examples"));
      for (const example of ["router-standalone.mjs", "host-adapter.mjs"]) {
        const publishedExample = join(packageRoot, "examples", example);
        assert.ok(existsSync(publishedExample), `the published package must contain examples/${example}`);
        copyFileSync(publishedExample, join(consumer, "examples", example));
      }
      const before = readdirSync(consumer);
      const standalone = execFileSync(process.execPath, ["examples/router-standalone.mjs"], {
        cwd: consumer, encoding: "utf8", timeout: 30_000,
      });
      assert.match(standalone, /selected: example\/fast-small/, "the standalone example must resolve a concrete model");
      assert.match(standalone, /no decision: outcome=/, "the standalone example must exercise a no-decision path");

      const hostAdapter = execFileSync(process.execPath, ["examples/host-adapter.mjs"], {
        cwd: consumer, encoding: "utf8", timeout: 30_000,
      });
      assert.match(hostAdapter, /host picked host-provider\/host-small/, "the host adapter must translate its inventory through the public DTOs");
      assert.match(hostAdapter, /dispatch: \{/, "the host adapter must execute through its own dispatch path");

      const after = readdirSync(consumer);
      assert.deepEqual(after, before, "running the examples must not create files in the consumer");
      assert.ok(!existsSync(join(consumer, ".pi")), "no Bifrost state directory is created");
      assert.ok(!existsSync(join(consumerModules, "@earendil-works")), "the standalone consumer still has no Pi packages");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects a Pi dependency injected into the actual packed router graph and restores it", (t) => {
    const temporary = mkdtempSync(join(tmpdir(), "pi-bifrost-router-graph-fault-"));
    const cache = join(temporary, "npm-cache");
    const consumer = join(temporary, "consumer");
    try {
      mkdirSync(cache); mkdirSync(consumer);
      installPackedPackage(cache, consumer);
      const { packageRoot, routerFiles } = installedRouterFiles(consumer);
      const target = join(packageRoot, "dist", "router", "router.js");
      const source = readFileSync(target, "utf8");
      const mutant = 'import "@earendil-works/pi-ai";\n' + source;
      const hash = (text) => createHash("sha256").update(text).digest("hex");
      assertNoPackageReferences(packageRoot, routerFiles);
      try {
        writeFileSync(target, mutant);
        assert.notEqual(hash(mutant), hash(source));
        assert.throws(() => assertNoPackageReferences(packageRoot, routerFiles),
          (error) => error.name === "AssertionError" && error.message.includes("dist/router/router.js references the Pi packages"),
          "an injected Pi dependency must fail the named published-graph assertion, not a later import");
      } finally { writeFileSync(target, source); }
      assert.equal(readFileSync(target, "utf8"), source, "the installed package graph must restore exactly");
      assertNoPackageReferences(packageRoot, routerFiles);
      t.diagnostic(JSON.stringify({ target: "dist/router/router.js", sourceSha256: hash(source), faultSha256: hash(mutant), restoredSha256: hash(readFileSync(target, "utf8")), phases: ["GREEN", "named dependency AssertionError RED", "restored GREEN"] }));
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});

test("installed router inspection is recursive and rejects a nested host reference", () => {
  const consumer = mkdtempSync(join(tmpdir(), "pi-bifrost-nested-router-"));
  try {
    const router = join(consumer, "node_modules", "pi-bifrost", "dist", "router");
    mkdirSync(join(router, "nested"), { recursive: true });
    writeFileSync(join(router, "router.js"), "export const router = 1;\n");
    writeFileSync(join(router, "nested", "inner.js"), 'import "@earendil-works/pi-ai";\n');
    const { routerFiles } = installedRouterFiles(consumer);
    assert.ok(routerFiles.includes("dist/router/nested/inner.js"), "nested build output must be inspected");
    assert.throws(() => assertNoPackageReferences(join(consumer, "node_modules", "pi-bifrost"), routerFiles),
      (error) => error.name === "AssertionError" && error.message.includes("dist/router/nested/inner.js references the Pi packages"),
      "a forbidden nested host reference must fail the published-graph assertion");
    writeFileSync(join(router, "nested", "inner.js"), "export const inner = 1;\n");
    assertNoPackageReferences(join(consumer, "node_modules", "pi-bifrost"), routerFiles);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

// A nested capability whose entry reaches a sibling and a package-level parent
// by `./` and `../`. A resolver that only understands `./` silently drops the
// parent files from the expectation, so their omission could never be caught.
test("nested capability compilation, packing and installation match the parent-relative inventory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bifrost-router-nested-build-"));
  const cache = join(root, "npm-cache");
  const consumer = join(root, "consumer");
  const app = join(root, "app");
  const { compilerOptions } = JSON.parse(readFileSync(join(process.cwd(), "tsconfig.router-build.json"), "utf8"));
  for (const [name, body] of Object.entries({
    "types.ts": "export type Shared = { id: string };\n",
    "capability/router.ts": 'import type { Shared } from "../types.ts";\nimport { inner } from "./nested/inner.ts";\nexport const router: Shared = { id: inner.id };\n',
    "capability/nested/inner.ts": 'import type { Shared } from "../../types.ts";\nexport const inner: Shared = { id: "inner" };\n',
  })) {
    const file = join(app, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  // The real build settings name the `node` type library, which resolves from
  // this checkout's install; the capability sources use no host APIs.
  symlinkSync(join(process.cwd(), "node_modules"), join(app, "node_modules"), "dir");
  // The real package is an ES module, which `verbatimModuleSyntax` requires.
  writeFileSync(join(app, "package.json"), JSON.stringify({
    name: "router-nested-capability", version: "1.0.0", type: "module", private: true,
    files: ["dist/router/", "capability/**/*.ts"],
  }));
  writeFileSync(join(app, "tsconfig.router-build.json"), JSON.stringify({
    compilerOptions: { ...compilerOptions, rootDir: ".", outDir: "dist/router" },
    include: ["capability/router.ts"],
  }));
  writeFileSync(join(app, "tsconfig.json"), readFileSync(join(app, "tsconfig.router-build.json")));
  // Written by hand: neither the build output nor the packlist may define it.
  const expected = [
    "dist/router/capability/nested/inner.d.ts", "dist/router/capability/nested/inner.js",
    "dist/router/capability/router.d.ts", "dist/router/capability/router.js",
    "dist/router/types.d.ts", "dist/router/types.js",
  ];
  try {
    mkdirSync(cache);
    mkdirSync(consumer);
    assert.deepEqual(expectedRouterInventory("capability/router.ts", app), expected,
      "TypeScript resolution must follow `../` imports into the expected inventory");

    const build = spawnSync(process.execPath, [typescriptCompiler, "-p", app], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    assert.deepEqual(listFiles(join(app, "dist", "router"), "dist/router"), expected,
      "the build must emit JS and declarations for every resolved source");

    const packed = JSON.parse(execFileSync("npm", [
      "pack", "--json", "--cache", cache, "--pack-destination", cache,
    ], { cwd: app, encoding: "utf8", timeout: 60_000 }))[0];
    const archivePaths = packed.files.map((file) => file.path);
    assert.deepEqual(inventoryGaps(expected, archivePaths), [], "the archive must carry the compiled inventory");

    execFileSync("npm", [
      "install", "--prefix", consumer, "--cache", cache, "--offline", "--ignore-scripts",
      "--no-audit", "--no-fund", join(cache, packed.filename),
    ], { cwd: consumer, encoding: "utf8", stdio: "pipe", timeout: 60_000 });
    const installed = join(consumer, "node_modules", "router-nested-capability", "dist", "router");
    assert.deepEqual(listFiles(installed, "dist/router"), expected, "the installed package must carry the compiled inventory");

    // Omission control on real installed output: the same comparison must name
    // the parent-relative file instead of absorbing its disappearance.
    rmSync(join(installed, "types.js"));
    assert.deepEqual(inventoryGaps(expected, listFiles(installed, "dist/router")), ["dist/router/types.js"],
      "a missing parent-relative compiled file must be reported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function packFixture(filesPatterns, tree) {
  const directory = mkdtempSync(join(tmpdir(), "pi-bifrost-module-pack-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "module-pack-fixture", version: "1.0.0", files: filesPatterns }));
  for (const [name, body] of Object.entries(tree)) {
    const target = join(directory, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, body);
  }
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: directory, encoding: "utf8", timeout: 60_000 }))[0];
  return { directory, paths: packed.files.map((file) => file.path) };
}

test("native packlist ships module runtime TS recursively and excludes module-local artifacts", () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const tree = {
    "index.ts": "export const root = 1;\n",
    "modules/alpha/widget.ts": "export const widget = 1;\n",
    "modules/alpha/types.d.ts": "export declare const typed: number;\n",
    "modules/alpha/nested/deep.ts": "export const deep = 1;\n",
    "modules/alpha/tests/widget.test.ts": "test('x', () => {});\n",
    "modules/alpha/tests/fixtures/helper.ts": "export const helper = 1;\n",
    "modules/alpha/README.md": "# local guide\n",
    "modules/alpha/widget.test.ts": "test('misplaced', () => {});\n",
    "modules/beta/thing.ts": "export const thing = 1;\n",
  };
  // Written independently of both the fixture tree walk and the archive, so an
  // unmet expectation cannot shrink to match whatever the packer shipped.
  const expectedModuleRuntime = [
    "modules/alpha/nested/deep.ts", "modules/alpha/types.d.ts",
    "modules/alpha/widget.ts", "modules/beta/thing.ts",
  ];
  let packed;
  let empty;
  let fault;
  let omitted;
  try {
    packed = packFixture(manifest.files, tree);
    for (const required of ["index.ts", ...expectedModuleRuntime]) {
      assert.ok(packed.paths.includes(required), `archive must ship runtime source ${required}`);
    }
    assert.deepEqual(inventoryGaps(expectedModuleRuntime, packed.paths), [],
      "the archive must contain the independent module runtime inventory");
    for (const forbidden of [
      "modules/alpha/tests/widget.test.ts", "modules/alpha/tests/fixtures/helper.ts",
      "modules/alpha/README.md", "modules/alpha/widget.test.ts",
    ]) {
      assert.ok(!packed.paths.includes(forbidden), `archive must exclude ${forbidden}`);
    }
    empty = packFixture(manifest.files, { "index.ts": "export const root = 1;\n" });
    assert.deepEqual(empty.paths.filter((path) => path.startsWith("modules/")), [], "zero modules add no archive entries");
    fault = packFixture(manifest.files.filter((pattern) => !pattern.startsWith("!modules/")), tree);
    assert.ok(fault.paths.includes("modules/alpha/tests/widget.test.ts"),
      "fault control: removing the module exclusions must ship module tests");
    assert.ok(manifest.files.includes("modules/**/*.ts"), "the runtime pattern under test must be configured");
    omitted = packFixture(manifest.files.filter((pattern) => pattern !== "modules/**/*.ts"), tree);
    assert.deepEqual(inventoryGaps(expectedModuleRuntime, omitted.paths), expectedModuleRuntime,
      "omission fault control: dropping the module runtime pattern must be detected, not absorbed");
  } finally {
    rmSync(packed?.directory, { recursive: true, force: true });
    rmSync(empty?.directory, { recursive: true, force: true });
    rmSync(fault?.directory, { recursive: true, force: true });
    rmSync(omitted?.directory, { recursive: true, force: true });
  }
});
