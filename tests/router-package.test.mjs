import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
        symlinkSync(join(sourcePath, scopedPackage), join(destinationPath, scopedPackage), "dir");
      }
    } else {
      symlinkSync(sourcePath, destinationPath, "dir");
    }
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
      const packed = JSON.parse(execFileSync("npm", [
        "pack", "--json", "--cache", cache, "--pack-destination", temporary,
      ], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 }))[0];
      const rootSources = readdirSync(process.cwd()).filter((path) => path.endsWith(".ts"));
      const routerGraph = [
        "cache", "classification-pipeline", "classifier-backends", "classifier", "config", "debug",
        "affinity", "economic-preferences", "economic-signals", "failure-observations", "inline-override", "reliability", "reliability-v1-fence", "router", "routing", "session-fallback", "storage", "virtual-model",
      ].flatMap((name) => [`dist/router/${name}.js`, `dist/router/${name}.d.ts`]);
      const archivePaths = packed.files.map((file) => file.path);
      for (const required of [
        ...rootSources, ...routerGraph, "bifrost.json", "schema.json", "package.json",
        "README.md", "CHANGELOG.md", "docs/router-api.md",
      ]) {
        assert.ok(archivePaths.includes(required), `release archive missing ${required}`);
      }
      assert.ok(archivePaths.every((path) => path.endsWith(".ts") && !path.includes("/")
        || ["bifrost.json", "schema.json", "README.md", "CHANGELOG.md", "package.json", "docs/router-api.md"].includes(path)
        || routerGraph.includes(path)
        || path.startsWith("examples/")), "release contains files outside source, router API, and examples allowlists");
      assert.ok(packed.files.some((file) => file.path === "dist/router/router.js"), "the package must contain built JS");
      assert.ok(packed.files.some((file) => file.path === "dist/router/router.d.ts"), "the package must contain API declarations");
      mkdirSync(consumer);
      execFileSync("npm", [
        "install", "--prefix", consumer, "--cache", cache, "--offline", "--ignore-scripts",
        "--legacy-peer-deps", "--no-audit", "--no-fund", join(temporary, packed.filename),
      ], { cwd: consumer, encoding: "utf8", stdio: "pipe", timeout: 60_000 });
      const consumerModules = join(consumer, "node_modules");
      linkInstalledDependencies(join(process.cwd(), "node_modules"), consumerModules);
      const installedPackage = join(consumerModules, "pi-bifrost");
      const packageJson = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8"));
      assert.deepEqual(packageJson.exports["./router"], {
        types: "./dist/router/router.d.ts",
        import: "./dist/router/router.js",
      });
      assert.deepEqual(packageJson.exports["./*"], "./*", "legacy package subpaths stay mapped");
      assert.deepEqual(packageJson.pi.extensions, ["./index.ts"], "the Pi extension entry stays unchanged");
      assert.ok(readFileSync(join(installedPackage, "index.ts"), "utf8"));
      for (const peerName of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
        assert.ok(readFileSync(join(consumerModules, peerName, "package.json"), "utf8"));
      }
      writeFileSync(join(consumer, "types-consumer.ts"), `
        import { createRouter, type RouterSnapshot } from "pi-bifrost/router";
        const model = { provider: "fixture", id: "small", cost: { input: 0.1, output: 0.2 }, contextWindow: 32000 };
        const snapshot: RouterSnapshot = {
          config: { models: { quick: ["fixture/small"] }, default: "quick", strategy: "first", rules: [] },
          registry: { knownModels: [model], availableModels: [model] },
          now: Date.now(),
        };
        createRouter(snapshot).resolve({ prompt: "typed consumer" });
        // @ts-expect-error prompt is required by the packed declaration.
        createRouter(snapshot).resolve({});
      `);
      execFileSync(process.execPath, [typescriptCompiler,
        "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext",
        "--moduleResolution", "NodeNext", "--skipLibCheck", "true", "types-consumer.ts",
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
});
