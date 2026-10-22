#!/usr/bin/env node
/**
 * Deterministic routing workload for benchmarks and profiles.
 *
 * Constructs one resolve-only router and resolves the same prompt shape a
 * fixed number of times. It performs no network, file, or clock reads, so a
 * benchmark difference reflects resolver work, not fixture variance.
 *
 * Usage: node --experimental-strip-types scripts/perf-workload.mjs [--iterations N]
 */
import { createRouter } from "../router.ts";

function parseIterations(argv) {
  const index = argv.indexOf("--iterations");
  if (index === -1) return 200_000;
  const raw = argv[index + 1];
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
    throw new Error("--iterations requires a positive integer");
  }
  const value = Number.parseInt(raw, 10);
  if (value > 1_000_000) throw new Error("--iterations must be at most 1000000");
  return value;
}

const iterations = parseIterations(process.argv.slice(2));
const models = Array.from({ length: 10 }, (_, index) => ({
  provider: "example",
  id: `model-${index}`,
  cost: { input: 0.1 + index * 0.01, output: 0.2 },
  contextWindow: 32_768,
}));
const config = {
  models: { quick: models.map((model) => `${model.provider}/${model.id}`) },
  default: "quick",
  strategy: "first",
  rules: [],
};
const router = createRouter({
  config,
  registry: { knownModels: models, availableModels: models },
  now: 1_000_000,
});

const started = process.hrtime.bigint();
let checksum = 0;
for (let index = 0; index < iterations; index += 1) {
  const result = await router.resolve({ prompt: `format file ${index}` });
  if (result.status !== "completed") throw new Error(`unexpected resolve status: ${result.status}`);
  const selected = result.decision.selected ?? "";
  checksum = (checksum + selected.length + selected.charCodeAt(0)) >>> 0;
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

process.stdout.write(`${JSON.stringify({
  workload: "resolve-only",
  iterations,
  checksum,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  selected: "example/model-0",
})}\n`);
