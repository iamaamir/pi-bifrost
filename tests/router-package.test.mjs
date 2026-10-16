import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, copyFileSync, cpSync } from "node:fs";
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

function installedDistributorFiles(consumer) {
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

describe("packed experimental router consumer", () => {
  it("installs the packed JS API and resolves without loader flags on Node 22.19+", () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    assert.ok(major > 22 || major === 22 && minor >= 19, "the API package test requires Node 22.19 or newer");
    const temporary = mkdtempSync(join(tmpdir(), "pi-bifrost-router-pack-"));
    const cache = join(temporary, "npm-cache");
    const consumer = join(temporary, "consumer");
    try {
      mkdirSync(cache);
      mkdirSync(join(cache, "packages"));
      mkdirSync(consumer);
      const packed = installPackedPackage(cache, consumer);
      const { packageRoot, routerFiles } = installedDistributorFiles(consumer);
      const archivePaths = packed.files.map((file) => file.path);
      const rootSources = readdirSync(process.cwd()).filter((path) => path.endsWith(".ts"));
      assert.deepEqual(packageJsonOf(packageRoot).exports["./router"], {
        types: "./dist/router/router.d.ts",
        import: "./dist/router/router.js",
      });
      assert.deepEqual(packageJsonOf(packageRoot).exports["./*"], "./*", "legacy package subpaths stay mapped");
      assert.deepEqual(packageJsonOf(packageRoot).pi.extensions, ["./index.ts"], "the Pi extension entry stays unchanged");
      assert.ok(readFileSync(join(packageRoot, "index.ts"), "utf8"));
      for (const required of [...rootSources, ...routerFiles, "bifrost.json", "schema.json", "package.json", "README.md", "CHANGELOG.md", "docs/router-api.md"]) {
        assert.ok(archivePaths.includes(required), `release archive missing ${required}`);
      }
      assert.ok(archivePaths.every((path) => path.endsWith(".ts") && !path.includes("/")
        || ["bifrost.json", "schema.json", "README.md", "CHANGELOG.md", "package.json", "docs/router-api.md"].includes(path)
        || routerFiles.includes(path)
        || path.startsWith("examples/")), "release contains files outside source, router API, and examples allowlists");
      linkInstalledDependencies(join(process.cwd(), "node_modules"), join(consumer, "node_modules"));

      // TypeScript declarations must resolve without the Pi packages present.
      // skipLibCheck stays off so the whole reachable declaration graph is checked.
      writeFileSync(join(consumer, "types-consumer.ts"), `
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
      `);
      execFileSync(process.execPath, [typescriptCompiler,
        "--noEmit", "--strict", "--skipLibCheck", "false", "--target", "ES2022",
        "--module", "NodeNext", "--moduleResolution", "NodeNext", "types-consumer.ts",
      ], { cwd: consumer, encoding: "utf8", stdio: "pipe", timeout: 30_000 });

      const consumerSource = `
        import assert from "node:assert/strict";
        import { existsSync } from "node:fs";
        import { createRouter } from "pi-bifrost/router";
        import { createJiti } from "jiti";
        const piExtension = await createJiti(import.meta.url).import("pi-bifrost/index.ts");
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

  it("runs shipped examples in a clean standalone consumer with no Pi packages installed", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pi-bifrost-router-standalone-"));
    const cache = join(temporary, "npm-cache");
    const consumer = join(temporary, "consumer");
    try {
      mkdirSync(cache);
      mkdirSync(consumer);
      installPackedPackage(cache, consumer);
      const { packageRoot, routerFiles } = installedDistributorFiles(consumer);
      assertNoPackageReferences(packageRoot, routerFiles);
      const consumerModules = join(consumer, "node_modules");
      assert.ok(!existsSync(join(consumerModules, "@earendil-works")), "a standalone consumer must not receive the Pi packages");

      // The consumer toolchain is only the TypeScript compiler host; the test
      // links it explicitly instead of pretending every environment has it.
      mkdirSync(join(consumerModules, "typescript"), { recursive: true });
      cpSync(join(process.cwd(), "node_modules", "typescript"), join(consumerModules, "typescript"), { recursive: true });

      mkdirSync(join(consumer, "examples"));
      for (const example of ["router-standalone.mjs", "host-adapter.mjs"]) {
        copyFileSync(join(process.cwd(), "examples", example), join(consumer, "examples", example));
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
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

function packageJsonOf(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}
