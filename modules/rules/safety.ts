import { spawnSync } from "node:child_process";

// Run untrusted canary matches outside Pi so a pathological regex can be killed.
// The structural scan remains the cheap first defense; canaries are heuristic.
const BACKTRACKING_BUDGET_MS = 10;
const BACKTRACKING_PROBE_TIMEOUT_MS = 500;
/**
 * The runtime the backtracking probe runs under.
 *
 * This must not be `process.execPath`: that made the probe's verdict depend on
 * whichever runtime hosted the router. Measured under Bun, `process.execPath` is
 * `bun`, so the probe executed a different regex engine and 4 of 989 mutants were
 * judged differently from a Node-hosted run. Production runs on Node, so the
 * probe pins Node and the verdict is the same everywhere.
 *
 * A Node host therefore probes with its own binary (`process.execPath`), which
 * also means no PATH lookup: a substituted `node` earlier on PATH could answer
 * "safe" for every pattern and silently disable this defense. A non-Node host
 * (Bun, Deno) has no Node binary to reuse, so it looks up `node`; if that is
 * absent the probe falls back to the hosting runtime rather than losing regex
 * rules entirely. `BIFROST_PROBE_NODE` overrides the binary in either case.
 */
const BACKTRACKING_PROBE_NODE_ENV = "BIFROST_PROBE_NODE";

/** The binary the backtracking probe runs under. */
function probeRuntime(): string {
  const override = process.env[BACKTRACKING_PROBE_NODE_ENV];
  if (override) return override;
  const versions = process.versions as Record<string, string | undefined>;
  // Under Node, the hosting binary is the production engine. Resolving `node`
  // through PATH would let the environment choose the verifier.
  if (!versions.bun && !versions.deno) return process.execPath;
  return "node";
}
const BACKTRACKING_CANARIES = [
  "a".repeat(10) + "b", "a".repeat(14) + "b", "a".repeat(18) + "b",
  "a".repeat(20) + "b", "a".repeat(22) + "b", "a".repeat(24) + "b",
  "ab".repeat(11) + "c", "1".repeat(21) + "x", "a".repeat(28) + "b", "a".repeat(32) + "b",
];
const BACKTRACKING_PROBE = `
  const fs = require("node:fs");
  const { performance } = require("node:perf_hooks");
  const { patterns, canaries, budget } = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const pattern of patterns) {
    const re = new RegExp(pattern, "i");
    let unsafe = false;
    for (const canary of canaries) {
      let start = performance.now();
      re.test(canary);
      if (performance.now() - start <= budget) continue;
      start = performance.now();
      re.test(canary);
      if (performance.now() - start > budget) { unsafe = true; break; }
    }
    fs.writeSync(1, unsafe ? "1\\n" : "0\\n");
  }
`;

interface BacktrackingFrame {
  /** Positions of one alternation branch, pattern-start to `|` or group end. */
  branches: string[];
  branchStart: number;
  /** The body carries a variable quantifier somewhere inside it. */
  bodyVarQuant: boolean;
}

type QuantifierKind = "none" | "fixed" | "bounded" | "unbounded";

/** Classify the quantifier starting at `position` without executing anything. */
function classifyQuantifier(pattern: string, position: number): QuantifierKind {
  const ch = pattern[position];
  if (ch === "*" || ch === "+") return "unbounded";
  if (ch === "?") return "bounded";
  if (ch !== "{") return "none";
  const close = pattern.indexOf("}", position + 1);
  if (close === -1) return "none";
  const body = pattern.slice(position + 1, close);
  if (!/^\d+(?:,\d*)?$/.test(body)) return "none";
  if (!body.includes(",")) return "fixed";
  const [min, max] = body.split(",");
  if (max === "") return "unbounded";
  return Number(min) === Number(max) ? "fixed" : "bounded";
}

/**
 * First character of a group's body, after its opening syntax.
 *
 * The `?` that introduces `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>`,
 * `(?>`, or inline flags is group syntax, not an optional quantifier, and it is
 * not part of the branch text used for overlap detection. Returns undefined for
 * constructs this textual scan does not model, which keeps the scan permissive.
 */
function groupBodyStart(pattern: string, open: number): number | undefined {
  const next = open + 1;
  if (pattern[next] !== "?") return next;
  for (const prefix of ["?:", "?=", "?!", "?>"] as const) {
    if (pattern.startsWith(prefix, next)) return next + 2;
  }
  for (const prefix of ["?<=", "?<!"] as const) {
    if (pattern.startsWith(prefix, next)) return next + 3;
  }
  if (pattern.startsWith("?<", next)) {
    const close = pattern.indexOf(">", next + 2);
    return close === -1 ? undefined : close + 1;
  }
  // Inline flags: (?i:...) or (?im-s:...).
  const colon = pattern.indexOf(":", next + 1);
  return colon !== -1 && /^[a-zA-Z-]*$/.test(pattern.slice(next + 1, colon))
    ? colon + 1
    : undefined;
}

/**
 * Textual detection of superlinear shapes; no regular expression executes.
 * True for a group repeated without a finishing bound whose body carries a
 * variable quantifier, or whose alternation splits a subject ambiguously
 * (a branch that is a prefix of another branch, or an empty branch), regardless
 * of anchors and lookarounds written in front of the group. Bounded repetition
 * and fixed-length tokens keep this false, so fixed-brace rules survive.
 */
function patternHasSuperlinearShape(pattern: string): boolean {
  const frames: BacktrackingFrame[] = [];
  let escape = false;
  let inClass = false;
  const overlaps = (frame: BacktrackingFrame): boolean => frame.branches.some(
    (branch, k) => branch === ""
      || frame.branches.some((other, j) => j !== k && other.startsWith(branch)),
  );
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (inClass) { if (ch === "]") inClass = false; continue; }
    if (ch === "[") { inClass = true; continue; }
    if (ch === "(") {
      if (pattern.startsWith("(?#", i)) {
        const end = pattern.indexOf(")", i + 3);
        if (end === -1) return false;
        i = end;
        continue;
      }
      const bodyStart = groupBodyStart(pattern, i);
      if (bodyStart === undefined) return false;
      frames.push({ branches: [], branchStart: bodyStart, bodyVarQuant: false });
      i = bodyStart - 1;
      continue;
    }
    if (ch === "|" && frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      frame.branches.push(pattern.slice(frame.branchStart, i));
      frame.branchStart = i + 1;
      continue;
    }
    if (ch === ")" && frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      frame.branches.push(pattern.slice(frame.branchStart, i));
      if (classifyQuantifier(pattern, i + 1) === "unbounded"
        && (frame.bodyVarQuant || (frame.branches.length > 1 && overlaps(frame)))) {
        return true;
      }
      frames.pop();
      if (frames.length > 0) frames[frames.length - 1]!.bodyVarQuant ||= frame.bodyVarQuant;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
      const kind = classifyQuantifier(pattern, i);
      if (kind === "bounded" || kind === "unbounded") {
        if (frames.length > 0) frames[frames.length - 1]!.bodyVarQuant = true;
      }
      if (ch === "{") {
        const close = pattern.indexOf("}", i + 1);
        if (close !== -1) i = close;
      }
      if (kind !== "none" && pattern[i + 1] === "?") i += 1;
    }
  }
  return false;
}

// Verdicts by pattern text, so the per-message classify() path neither re-scans
// nor re-probes a configured rule and a rejection is reported once per process.
const patternVerdicts = new Map<string, boolean>();

/** Probe unknown patterns in batches; a timed-out pattern cannot stall later rules. */
export function verifyRulePatterns(patterns: readonly string[]): void {
  let pending: string[] = [];
  const reject = (pattern: string): void => {
    patternVerdicts.set(pattern, true);
    console.error(`[bifrost] rejecting rule pattern with unbounded backtracking or unverifiable safety: "${pattern}"`);
  };
  for (const pattern of new Set(patterns)) {
    if (patternVerdicts.has(pattern)) continue;
    if (patternHasSuperlinearShape(pattern)) reject(pattern);
    else pending.push(pattern);
  }
  while (pending.length > 0) {
    const batch = pending.slice(0, 32);
    const probeArgs = ["-e", BACKTRACKING_PROBE];
    const probeOptions = {
      input: JSON.stringify({ patterns: batch, canaries: BACKTRACKING_CANARIES, budget: BACKTRACKING_BUDGET_MS }),
      encoding: "utf8" as const,
      timeout: BACKTRACKING_PROBE_TIMEOUT_MS + batch.length * 20,
      killSignal: "SIGKILL" as const,
      maxBuffer: Math.max(1024, batch.length * 4),
      env: { ...process.env, NODE_OPTIONS: "" },
    };
    const probeNode = probeRuntime();
    let result = spawnSync(probeNode, probeArgs, probeOptions);
    // A host without `node` on PATH falls back to the hosting runtime, so regex
    // rules keep working. Only the engine-stability guarantee is lost.
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" && probeNode !== process.execPath) {
      result = spawnSync(process.execPath, probeArgs, probeOptions);
    }
    const lines = (result.stdout ?? "").split("\n").filter(Boolean);
    let completed = 0;
    for (const line of lines) {
      if (completed >= batch.length || (line !== "0" && line !== "1")) break;
      const pattern = pending[completed++]!;
      if (line === "1") reject(pattern);
      else patternVerdicts.set(pattern, false);
    }
    pending = pending.slice(completed);
    if (completed === batch.length) continue;
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      reject(pending[0]!);
      pending = pending.slice(1);
    } else {
      const failed = batch.length - completed;
      for (const pattern of pending.slice(0, failed)) reject(pattern);
      pending = pending.slice(failed);
    }
  }
}

/**
 * Whether the process has a verdict for this pattern and the verdict is accepted.
 * The map itself stays private so verification state cannot be mutated from outside.
 */
export function isPatternAccepted(pattern: string): boolean {
  return patternVerdicts.get(pattern) === false;
}
