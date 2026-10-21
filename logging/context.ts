// ── Logging context ───────────────────────────────────────────────
// Identity and destination resolution. IDs are untrusted filesystem input:
// they are recorded as provided but sanitized before they become path segments.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
import {
  DEFAULT_DIRECTORY,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_BATCH_ENTRIES,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_ROTATED_FILES,
  DEFAULT_SHARED_PATH,
  type DebugConfig,
  type LogDestination,
  type LogIdentity,
  type LogIdentityHint,
  type ResolvedDebugConfig,
} from "./types.ts";
import { parseLogLevel } from "./severity.ts";
import { isOverflowPolicyName } from "./overflow-policy.ts";

export const UNATTRIBUTED_SESSION = "_unattributed";

const MAX_FRAGMENT_LENGTH = 96;
const MAX_CORRELATION_LENGTH = 200;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function positiveFinite(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max
    ? value
    : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveUserPath(cwd: string, value: string): string | null {
  if (value.includes("\0")) return null;
  const expanded = value.replace(/^~(?=$|[\\/])/, homedir());
  return normalize(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}

function identityString(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text ? text.slice(0, 256) : undefined;
}

/**
 * Resolve user configuration into safe, finite values. Invalid values fall back
 * to defaults; configuration validation reports the error separately. Setup
 * must remain usable even when it is called without prior validation.
 */
export function resolveDebugConfig(config: DebugConfig | undefined, cwd: string): ResolvedDebugConfig {
  const source = config && typeof config === "object" ? config : {};
  const sharedRaw = nonEmptyString(source.path);
  const scope = source.scope === "file" ? "file" : "session";
  const sharedPath = sharedRaw
    ? resolveUserPath(cwd, sharedRaw)
    : scope === "file"
      ? resolveUserPath(cwd, DEFAULT_SHARED_PATH)
      : null;
  const directory = resolveUserPath(cwd, nonEmptyString(source.directory) ?? DEFAULT_DIRECTORY)
    ?? resolveUserPath(cwd, DEFAULT_DIRECTORY)
    ?? join(cwd, ".pi", "bifrost", "logs");

  const maxBytes = integerInRange(source.queue?.maxBytes, DEFAULT_MAX_BYTES, 1_024, 64 * 1024 * 1024);
  const maxEntries = integerInRange(source.queue?.maxEntries, DEFAULT_MAX_ENTRIES, 1, 100_000);
  const overflowPolicy = isOverflowPolicyName(source.queue?.overflowPolicy)
    ? source.queue.overflowPolicy
    : "severity-first";
  const intervalMs = integerInRange(source.drain?.intervalMs, DEFAULT_FLUSH_INTERVAL_MS, 1, 60_000);
  // A batch can never exceed the queue it drains. Clamp instead of silently
  // falling back to the default when the configured batch is larger.
  const maxBatchBytes = Math.min(
    integerInRange(source.drain?.maxBatchBytes, DEFAULT_MAX_BATCH_BYTES, 1_024, 64 * 1024 * 1024),
    maxBytes,
  );
  const maxFileSizeMB = positiveFinite(source.sink?.maxFileSizeMB, DEFAULT_MAX_FILE_SIZE_MB, 1_024);
  const rotatedFiles = integerInRange(source.sink?.rotatedFiles, DEFAULT_ROTATED_FILES, 0, 10);

  return {
    enabled: source.enabled === true,
    sharedPath,
    level: parseLogLevel(source.level),
    directory,
    queue: { maxEntries, maxBytes, overflowPolicy },
    drain: { intervalMs, maxBatchBytes, maxBatchEntries: DEFAULT_MAX_BATCH_ENTRIES },
    sink: { maxFileSizeBytes: Math.floor(maxFileSizeMB * 1024 * 1024), rotatedFiles },
  };
}

export interface AgentEnvironmentIdentity {
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly rootSessionId?: string;
}

/**
 * Optional subagent metadata. `PI_SUBAGENT_RUN_ID` is a run marker, not proof
 * of a parent session; a root is adopted only when the host propagates one
 * explicitly. Otherwise the child gets an independent session log.
 */
export function agentIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): AgentEnvironmentIdentity {
  if (env.PI_SUBAGENT_CHILD !== "1") return {};
  const agentId = identityString(env.PI_SUBAGENT_CHILD_AGENT)
    ?? identityString(env.PI_SUBAGENT_AGENT_ID)
    ?? identityString(env.PI_SUBAGENT_RUN_ID);
  const parentAgentId = identityString(env.PI_SUBAGENT_PARENT_AGENT_ID)
    ?? identityString(env.PI_SUBAGENT_PARENT_RUN_ID);
  const rootSessionId = identityString(env.PI_SUBAGENT_ROOT_SESSION_ID)
    ?? identityString(env.PI_SUBAGENT_PARENT_SESSION_ID);
  return {
    ...(agentId ? { agentId } : {}),
    ...(parentAgentId ? { parentAgentId } : {}),
    ...(rootSessionId ? { rootSessionId } : {}),
  };
}

/** Existing correlation identifiers kept for trace compatibility. */
export function processCorrelation(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const correlation: Record<string, string> = {};
  const pattern = nonEmptyString(env.BIFROST_PATTERN_RUN_ID);
  const subagent = nonEmptyString(env.PI_SUBAGENT_RUN_ID);
  if (pattern) correlation.pattern_run_id = pattern.slice(0, MAX_CORRELATION_LENGTH);
  if (subagent) correlation.subagent_run_id = subagent.slice(0, MAX_CORRELATION_LENGTH);
  return correlation;
}

export function createProcessIdentity(
  env: NodeJS.ProcessEnv = process.env,
  processId: number = process.pid,
): LogIdentity {
  const agent = agentIdentityFromEnv(env);
  const root = agent.rootSessionId ?? UNATTRIBUTED_SESSION;
  return {
    rootSessionId: root,
    sessionId: root,
    runId: randomUUID(),
    processId,
    ...(agent.agentId ? { agentId: agent.agentId } : {}),
    ...(agent.parentAgentId ? { parentAgentId: agent.parentAgentId } : {}),
  };
}

/** Merge an explicit session hint into the process identity. */
export function mergeIdentity(base: LogIdentity, hint?: LogIdentityHint): LogIdentity {
  const sessionId = identityString(hint?.sessionId);
  if (!sessionId) return base;
  const agentId = identityString(hint?.agentId) ?? base.agentId;
  const parentAgentId = identityString(hint?.parentAgentId) ?? base.parentAgentId;
  const rootSessionId = identityString(hint?.rootSessionId)
    ?? (base.agentId && base.rootSessionId !== UNATTRIBUTED_SESSION ? base.rootSessionId : sessionId);
  return {
    rootSessionId,
    sessionId,
    runId: base.runId,
    processId: base.processId,
    ...(agentId ? { agentId } : {}),
    ...(parentAgentId ? { parentAgentId } : {}),
  };
}

/** Remove separators and traversal markers from an untrusted path segment. */
export function sanitizeFragment(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return undefined;
  let safe = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, MAX_FRAGMENT_LENGTH)
    .replace(/[. ]+$/g, "");
  if (!safe || safe === "." || safe === "..") return undefined;
  if (WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
  return safe;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

export function destinationFor(config: ResolvedDebugConfig, identity: LogIdentity): LogDestination {
  if (config.sharedPath) {
    return { key: `shared:${config.sharedPath}`, path: config.sharedPath, shared: true };
  }
  const root = sanitizeFragment(identity.rootSessionId) ?? UNATTRIBUTED_SESSION;
  const agent = sanitizeFragment(identity.agentId);
  const run = sanitizeFragment(identity.runId) ?? randomUUID();
  const relativePath = agent
    ? join(root, "subagents", agent, `${run}.jsonl`)
    : join(root, "main", `${run}.jsonl`);
  const candidate = join(config.directory, relativePath);
  if (isInside(config.directory, candidate)) {
    return { key: candidate, path: candidate, shared: false, root: config.directory };
  }
  const fallback = join(config.directory, UNATTRIBUTED_SESSION, "main", `${run}.jsonl`);
  return { key: fallback, path: fallback, shared: false, root: config.directory };
}
