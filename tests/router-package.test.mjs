import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

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
        if (scopedPackage.startsWith(".")) continue;
        symlinkSync(join(sourcePath, scopedPackage), join(destinationPath, scopedPackage), "dir");
      }
    } else {
      symlinkSync(sourcePath, destinationPath, "dir");
    }
  }
}

/** Install the packed API into a temporary consumer that installs nothing else. */
function installPackedPackage(cache, consumer) {
  const packed = JSON.parse(execFileSync("npm", [
    "pack", "--json", "--cache", cache, "--pack-destination", cache,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 }))[0];
  execFileSync("npm", [
    "install", "--prefix", consumer, "--cache", cache, "--offline", "--ignore-scripts",
    "--no-audit", "--no-fund", join(cache, packed.filename),
  ], { cwd: consumer, encoding: "utf8", stdio: "pipe", timeout: 60_000 });
  return packed;
}

function installedRouterFiles(consumer) {
  const packageRoot = join(consumer, "node_modules", "pi-bifrost");
  const routerFiles = readdirSync(join(packageRoot, "dist", "router")).map((name) => `dist/router/${name}`);
  return { packageRoot, routerFiles };
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
  }, "Pi packages must remain optional peers");
}

function packageJsonOf(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

const TYPES_CONSUMER = `
  import { createRouter, type RouterSnapshot, type RouterResolveResult } from "pi-bifrost/router";
  const model = { provider: "fixture", id: "small", cost: { input: 0.1, output: 0.2 }, contextWindow: 32000 };
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
      for (const required of [...rootSources, ...routerFiles, "bifrost.json", "schema.json", "package.json", "README.md", "CHANGELOG.md", "LICENSE", "docs/router-api.md", ...agentSkill]) {
        assert.ok(archivePaths.includes(required), `release archive missing ${required}`);
      }
      assert.ok(archivePaths.every((path) => path.endsWith(".ts") && !path.includes("/")
        || ["bifrost.json", "schema.json", "README.md", "CHANGELOG.md", "LICENSE", "package.json", "docs/router-api.md"].includes(path)
        || routerFiles.includes(path)
        || path.startsWith("examples/")
        || agentSkill.includes(path)), "release contains files outside source, router API, examples, and agent skill allowlists");
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
