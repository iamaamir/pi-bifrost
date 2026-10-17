/**
 * Agent-facing configuration helpers.
 *
 * Bifrost owns configuration primitives, validation, and write safety. A coding
 * agent owns the user's goal and composes those primitives with this module:
 *
 *   inspect → check → preview → apply
 *
 * Every operation reads the real config layers and the real model catalog.
 * `check` and `preview` never write and never reach a provider. `apply` writes
 * one reviewed source with the same atomic writer the rest of Bifrost uses,
 * after an explicit confirmation, and only when the proposal still matches the
 * inputs it was generated from.
 *
 * No second schema validator, routing engine, or routing policy lives here:
 * validation delegates to `validateConfig`, routing to `resolveConfiguredTier`
 * through the resolve-only router, and pool matching to `findCandidates`.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  MAX_CONFIG_SOURCE_BYTES,
  classifierTotalTimeoutIssue,
  configLayerPaths,
  loadConfigForReload,
  loadConfigWithSourceOverride,
  validateConfig,
  validateTierPolicyConfig,
  type BifrostConfig,
} from "./config.ts";
import { findCandidates } from "./routing.ts";
import { createRouter, type RouterModel, type RouterRegistrySnapshot, type RouterSnapshot } from "./router.ts";
import { writeTextFile } from "./storage.ts";
import { isGenerativeModel } from "./virtual-model.ts";

// ── Limits ─────────────────────────────────────────────────────

const MAX_PROMPTS = 8;
const MAX_PROMPT_CHARS = 2_000;
const MAX_APPROVAL_MESSAGE_CHARS = 4_000;
const MAX_REPORT_LINES = 120;

// ── Public types ───────────────────────────────────────────────

/** A user-writable Bifrost config source. `extension` is bundled and read-only. */
export type ConfigAgentSource = "project" | "workspace" | "user";

export type ConfigAgentOperation = "inspect" | "check" | "preview" | "apply";

export type ConfigAgentLayerName = "extension" | "global" | "workspace" | "project";

/** Physical model facts the agent may route to. Never carries credentials. */
export interface ConfigAgentModel {
  readonly key: string;
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  /** USD per 1M input tokens, as Pi's registry reports it. */
  readonly inputCost: number;
  /** USD per 1M output tokens, as Pi's registry reports it. */
  readonly outputCost: number;
  readonly contextWindow: number;
  readonly reasoning: boolean;
}

/**
 * The model inventory for one proposal: available entries `findCandidates` can
 * select, every catalog entry that is known but not currently available, and
 * the entries whose cost/context metadata is unusable for routing.
 */
export interface ConfigAgentCatalog {
  readonly available: readonly ConfigAgentModel[];
  readonly known: readonly ConfigAgentModel[];
  readonly knownKeys: readonly string[];
  readonly metadataIncomplete: readonly string[];
}

export interface ConfigAgentRequest {
  readonly source?: ConfigAgentSource;
  /** Complete replacement content for the selected source. */
  readonly candidate?: Record<string, unknown>;
  /** Top-level merge into the selected source. */
  readonly patch?: Record<string, unknown>;
  /** Top-level keys to delete from the selected source; requires `patch`. */
  readonly remove?: readonly string[];
  readonly prompts?: readonly string[];
  readonly proposalDigest?: string;
  readonly sourceDigest?: string;
  readonly effectiveDigest?: string;
  readonly catalogDigest?: string;
}

/** Inputs a proposal was generated from. Apply rejects a changed input. */
export interface ConfigAgentGuards {
  /** Digest of the selected source file, or null when it does not exist. */
  readonly sourceDigest: string | null;
  /** Digest of the effective merged configuration before the change. */
  readonly effectiveDigest: string;
  /** Digest of the model inventory. */
  readonly catalogDigest: string;
}

export interface ConfigAgentChange {
  readonly kind: "add" | "replace" | "remove";
  readonly field: string;
}

export interface ConfigAgentReferenceIssue {
  readonly tier: string;
  readonly entry: string;
  /** `available` resolves now; `known_unavailable` exists in the catalog but cannot route; `unknown` matches nothing. */
  readonly status: "available" | "known_unavailable" | "unknown";
  readonly matches: readonly string[];
}

export type ConfigAgentStatus =
  | "ok"
  | "usage"
  | "rejected"
  | "blocked"
  | "stale"
  | "declined"
  | "approval_required"
  | "write_failed"
  | "reload_failed";

export interface ConfigAgentIssueSummary {
  readonly severity: "error" | "warning";
  readonly code?: string;
  readonly path?: string;
  readonly message: string;
}

export interface ConfigAgentInspectResult {
  readonly operation: "inspect";
  readonly status: "ok" | "usage" | "blocked";
  readonly layers: readonly ConfigAgentLayer[];
  readonly effectiveConfig: Record<string, unknown>;
  readonly issues: readonly ConfigAgentIssueSummary[];
  readonly diagnostics: readonly { readonly layer: ConfigAgentLayerName; readonly message: string }[];
  readonly routing: ConfigAgentRoutingSummary;
  readonly restrictions: readonly string[];
  /** Physical models the agent may route to, narrowed by the optional provider filter. */
  readonly inventory: readonly ConfigAgentModel[];
  /** Total available models before an `inventoryProvider` filter. */
  readonly availableModelCount: number;
  readonly inventoryProvider?: string;
  readonly knownUnavailableCount: number;
  readonly notes: readonly string[];
}

export interface ConfigAgentLayer {
  readonly layer: ConfigAgentLayerName;
  readonly source: ConfigAgentSource | null;
  readonly path: string;
  readonly exists: boolean;
  readonly editable: boolean;
  readonly bytes: number | null;
  readonly digest: string | null;
  readonly fields: readonly string[];
  readonly readError?: string;
}

/** Content-free routing facts the agent needs before changing policy. */
export interface ConfigAgentRoutingSummary {
  readonly enabled: boolean;
  readonly schemaVersion: number;
  readonly defaultTier: string | undefined;
  readonly strategy: string | undefined;
  readonly tiers: readonly {
    readonly tier: string;
    readonly pool: readonly string[];
    readonly strategy: string;
    readonly fallbackTiers: readonly string[] | null;
  }[];
  readonly classifier: {
    readonly enabled: boolean;
    readonly backend: string | undefined;
    readonly criteriaTiers: readonly string[];
  };
  readonly affinity: { readonly mode: string; readonly surfaceNote: string };
  readonly rules: { readonly configRules: number; readonly routeFile: string | null };
  readonly routeFileOverridesRules: boolean;
  readonly reliability: { readonly stateVersion: number; readonly enabled: boolean };
  readonly economics: { readonly configured: boolean; readonly spendCap: false };
}

export interface ConfigAgentCheckResult {
  readonly operation: "check";
  readonly status: ConfigAgentStatus;
  readonly source: ConfigAgentSource;
  readonly sourcePath: string;
  readonly proposalDigest: string | null;
  readonly guards: ConfigAgentGuards | null;
  readonly changes: readonly ConfigAgentChange[];
  readonly nextSource: Record<string, unknown> | null;
  readonly effectiveAfter: Record<string, unknown> | null;
  readonly effectiveBefore: Record<string, unknown> | null;
  readonly issues: readonly ConfigAgentIssueSummary[];
  readonly diagnostics: readonly { readonly layer: ConfigAgentLayerName; readonly message: string }[];
  readonly references: readonly ConfigAgentReferenceIssue[];
  readonly routingAfter: ConfigAgentRoutingSummary | null;
  readonly newlyEligibleModels: readonly string[];
  readonly removedModels: readonly string[];
  readonly writeEligible: boolean;
  readonly notes: readonly string[];
}

export interface ConfigAgentPreviewCase {
  readonly prompt: string;
  readonly decidedBy: "inline_tier_prefix" | "regex_rule" | "default_tier" | "none";
  /** `deterministic` means no classifier call can change this outcome. */
  readonly confidence: "deterministic" | "classifier_dependent";
  readonly tier?: string;
  readonly selected?: string;
  readonly selectedTier?: string;
  readonly fallbackReason?: string;
  readonly excluded: readonly { readonly model: string; readonly exclusion: string }[];
  readonly unavailable: readonly string[];
}

export interface ConfigAgentPreviewTier {
  readonly tier: string;
  readonly strategy: string;
  readonly patterns: readonly string[];
  readonly selected?: string;
  readonly excluded: readonly { readonly model: string; readonly exclusion: string }[];
  readonly unknownUnavailable: readonly string[];
}

export interface ConfigAgentPreviewResult {
  readonly operation: "preview";
  readonly status: ConfigAgentStatus;
  readonly source: ConfigAgentSource;
  readonly sourcePath: string;
  readonly proposalDigest: string | null;
  readonly guards: ConfigAgentGuards | null;
  readonly network: "disabled";
  readonly promptExecution: "none";
  readonly cases: readonly ConfigAgentPreviewCase[];
  readonly tiers: readonly ConfigAgentPreviewTier[];
  readonly issues: readonly ConfigAgentIssueSummary[];
  readonly notes: readonly string[];
}

export interface ConfigAgentApplyResult {
  readonly operation: "apply";
  readonly status: ConfigAgentStatus;
  readonly source: ConfigAgentSource;
  readonly sourcePath: string;
  readonly applied: boolean;
  readonly reloaded: boolean;
  readonly verified: boolean;
  readonly changes: readonly ConfigAgentChange[];
  readonly effectiveConfig: Record<string, unknown> | null;
  readonly routing: ConfigAgentRoutingSummary | null;
  readonly reason?: string;
  readonly notes: readonly string[];
}

export type ConfigAgentToolResult =
  | ConfigAgentInspectResult
  | ConfigAgentCheckResult
  | ConfigAgentPreviewResult
  | ConfigAgentApplyResult;

// ── Deterministic hashing/encoding ─────────────────────────────

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Stable JSON encoding: object keys sorted at every level, so digests survive key order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function serializeSource(object: Record<string, unknown>): string {
  return `${JSON.stringify(object, null, 2)}\n`;
}

function shortDigest(digest: string | null): string {
  return digest === null ? "absent" : digest.slice(0, 12);
}

// ── Source files ───────────────────────────────────────────────

export function configAgentSourcePaths(
  cwd: string,
  extensionDir: string,
): Record<ConfigAgentSource, string> {
  const paths = configLayerPaths(cwd, extensionDir);
  const find = (layer: ConfigAgentLayerName): string => paths.find(([name]) => name === layer)?.[1] ?? "";
  return { user: find("global"), workspace: find("workspace"), project: find("project") };
}

function readSourceLayer(path: string): { bytes: number | null; text: string | null; object: Record<string, unknown> | null; error?: string } {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, text: null, object: null };
    return { bytes: null, text: null, object: null, error: "is not readable" };
  }
  if (stats.isSymbolicLink()) return { bytes: null, text: null, object: null, error: "is a symlink, so Bifrost will not write it" };
  if (!stats.isFile()) return { bytes: null, text: null, object: null, error: "is not a regular file" };
  if (stats.size > MAX_CONFIG_SOURCE_BYTES) return { bytes: stats.size, text: null, object: null, error: "exceeds the config size limit" };
  let text: string | undefined;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= MAX_CONFIG_SOURCE_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CONFIG_SOURCE_BYTES + 1 - total));
        const count = readSync(fd, chunk, 0, chunk.byteLength, null);
        if (count === 0) break;
        total += count;
        chunks.push(chunk.subarray(0, count));
      }
      if (total > MAX_CONFIG_SOURCE_BYTES) return { bytes: total, text: null, object: null, error: "exceeds the config size limit" };
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } finally {
      closeSync(fd);
    }
  } catch {
    return { bytes: stats.size, text: null, object: null, error: "is not readable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { bytes: stats.size, text, object: null, error: "is not valid JSON" };
  }
  if (!isPlainRecord(parsed)) return { bytes: stats.size, text, object: null, error: "must contain a JSON object" };
  return { bytes: stats.size, text, object: parsed };
}

function inspectLayers(cwd: string, extensionDir: string): ConfigAgentLayer[] {
  const paths = configLayerPaths(cwd, extensionDir);
  return paths.map(([layer, path]) => {
    const read = readSourceLayer(path);
    const source: ConfigAgentSource | null = layer === "global" ? "user"
      : layer === "workspace" ? "workspace" : layer === "project" ? "project" : null;
    return {
      layer,
      source,
      path,
      exists: read.bytes !== null,
      editable: source !== null,
      bytes: read.bytes,
      digest: read.text === null ? null : sha256(read.text),
      fields: read.object ? Object.keys(read.object).sort() : [],
      ...(read.error ? { readError: read.error } : {}),
    };
  });
}

// ── Catalog ────────────────────────────────────────────────────

function toCatalogModel(model: {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly cost?: { readonly input?: number; readonly output?: number };
  readonly contextWindow?: number;
  readonly reasoning?: boolean;
}): ConfigAgentModel | undefined {
  const input = model.cost?.input;
  const output = model.cost?.output;
  const contextWindow = model.contextWindow;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) return undefined;
  if (typeof output !== "number" || !Number.isFinite(output) || output < 0) return undefined;
  if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return undefined;
  return {
    key: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    ...(typeof model.name === "string" ? { name: model.name } : {}),
    inputCost: input,
    outputCost: output,
    contextWindow,
    reasoning: model.reasoning === true,
  };
}

/**
 * Build the inventory from Pi's registry. Both lists are physical chat models:
 * Bifrost virtual entries and classifier entries are not routing targets.
 */
export function buildConfigAgentCatalog(
  available: readonly Model<Api>[],
  known: readonly Model<Api>[],
): ConfigAgentCatalog {
  const knownKeys = new Set<string>();
  const knownModels = new Map<string, ConfigAgentModel>();
  const metadataIncomplete: string[] = [];
  const add = (models: readonly Model<Api>[], collectIncomplete: boolean): void => {
    for (const model of models) {
      if (!isGenerativeModel(model)) continue;
      const key = `${model.provider}/${model.id}`;
      knownKeys.add(key);
      const projected = toCatalogModel(model);
      if (!projected) {
        if (collectIncomplete && !metadataIncomplete.includes(key)) metadataIncomplete.push(key);
        continue;
      }
      knownModels.set(key, projected);
    }
  };
  add(known, true);
  add(available, false);
  const availableModels: ConfigAgentModel[] = [];
  for (const model of available) {
    if (!isGenerativeModel(model)) continue;
    const projected = toCatalogModel(model);
    // Available entries must exist in the known list so the router snapshot stays consistent.
    if (projected && knownModels.has(projected.key)) availableModels.push(projected);
  }
  availableModels.sort((left, right) => left.key.localeCompare(right.key));
  return {
    available: availableModels,
    known: [...knownModels.values()].sort((left, right) => left.key.localeCompare(right.key)),
    knownKeys: [...knownKeys].sort(),
    metadataIncomplete: metadataIncomplete.sort(),
  };
}

export function catalogDigest(catalog: ConfigAgentCatalog): string {
  return sha256(canonicalJson(catalog.available.map((model) => ({
    key: model.key,
    input: model.inputCost,
    output: model.outputCost,
    context: model.contextWindow,
  }))));
}

function registryContext(catalog: ConfigAgentCatalog): ExtensionContext {
  const models = catalog.available.map((model) => ({
    provider: model.provider,
    id: model.id,
    cost: { input: model.inputCost, output: model.outputCost },
    contextWindow: model.contextWindow,
  })) as unknown as Model<Api>[];
  const byKey = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  return {
    modelRegistry: {
      getAvailable: () => [...models],
      find: (provider: string, id: string) => byKey.get(`${provider}/${id}`),
    },
  } as unknown as ExtensionContext;
}

/** Reuse the production pool matcher so a reference check cannot drift from routing. */
function poolMatches(catalog: ConfigAgentCatalog, entry: string): string[] {
  return findCandidates(registryContext(catalog), entry).map((model) => `${model.provider}/${model.id}`);
}

function poolEntries(pool: string | string[] | undefined): string[] {
  if (typeof pool === "string") return [pool];
  return Array.isArray(pool) ? pool.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Which configured pool entries cannot route right now, and why. */
export function checkModelReferences(
  config: BifrostConfig,
  catalog: ConfigAgentCatalog,
): ConfigAgentReferenceIssue[] {
  const knownKeys = new Set(catalog.knownKeys);
  const issues: ConfigAgentReferenceIssue[] = [];
  for (const [tier, pool] of Object.entries(config.models ?? {})) {
    for (const entry of poolEntries(pool)) {
      const matches = poolMatches(catalog, entry);
      if (matches.length > 0) continue;
      // An exact `provider/id` that the catalog knows but cannot route is
      // unavailable rather than unknown; everything else matches nothing.
      const status: ConfigAgentReferenceIssue["status"] = entry.includes("/") && knownKeys.has(entry)
        ? "known_unavailable"
        : "unknown";
      issues.push({ tier, entry, status, matches: [] });
    }
  }
  return issues;
}

// ── Effective config + routing summary ─────────────────────────

interface LoadedConfig {
  readonly config: BifrostConfig;
  readonly diagnostics: readonly { readonly layer: ConfigAgentLayerName; readonly message: string }[];
}

function effectiveConfig(cwd: string, extensionDir: string): LoadedConfig {
  const loaded = loadConfigForReload(cwd, extensionDir);
  return { config: loaded.config, diagnostics: loaded.diagnostics };
}

function effectiveDigest(config: BifrostConfig): string {
  return sha256(canonicalJson(config as unknown as Record<string, unknown>));
}

function issuesOf(config: BifrostConfig, diagnostics: readonly { readonly layer: ConfigAgentLayerName; readonly message: string }[]): ConfigAgentIssueSummary[] {
  const issues: ConfigAgentIssueSummary[] = [...validateConfig(config), ...validateTierPolicyConfig(config)]
    .map((issue) => ({
      severity: issue.severity,
      ...(issue.code ? { code: issue.code } : {}),
      ...(issue.path ? { path: issue.path } : {}),
      message: issue.message,
    }));
  const timeout = classifierTotalTimeoutIssue(config);
  if (timeout) issues.push({ severity: timeout.severity, ...(timeout.code ? { code: timeout.code } : {}), ...(timeout.path ? { path: timeout.path } : {}), message: timeout.message });
  for (const diagnostic of diagnostics) issues.push({ severity: "error", code: "config.source_invalid", message: `${diagnostic.layer} config ${diagnostic.message}` });
  const unique = new Map(issues.map((issue) => [`${issue.severity}:${issue.code ?? issue.message}`, issue]));
  return [...unique.values()];
}

function routeFileFor(cwd: string): string | null {
  const candidates = [".pi/bifrost-routes.json", "bifrost-routes.json"].map((relative) => `${cwd}/${relative}`);
  for (const path of candidates) {
    try {
      const stats = lstatSync(path);
      if (stats.isFile()) return path;
    } catch {
      // absent route file
    }
  }
  return null;
}

function routingSummary(config: BifrostConfig, cwd: string): ConfigAgentRoutingSummary {
  const modelTiers = config.models ?? {};
  const tierNames = Object.keys(modelTiers);
  const routeFile = routeFileFor(cwd);
  const classifier = config.classifier;
  const reliabilityVersion = config.reliability?.stateVersion === 2 ? 2 : 1;
  return {
    enabled: config.enabled !== false,
    schemaVersion: config.schemaVersion ?? 1,
    defaultTier: config.default,
    strategy: config.strategy,
    tiers: tierNames.map((tier) => ({
      tier,
      pool: poolEntries(modelTiers[tier]),
      strategy: config.categoryStrategies?.[tier] ?? config.strategy ?? "first",
      fallbackTiers: config.tierPolicies?.[tier]?.fallbackTiers ?? null,
    })),
    classifier: {
      enabled: classifier?.enabled !== false,
      backend: classifier?.backend,
      criteriaTiers: Object.keys(classifier?.criteria ?? {}),
    },
    affinity: {
      mode: config.affinity?.mode ?? "off",
      surfaceNote: "Pi Auto defaults to retain-within-tier; physical routing and the resolve-only API stay off unless configured.",
    },
    rules: { configRules: config.rules?.length ?? 0, routeFile },
    routeFileOverridesRules: routeFile !== null,
    reliability: { stateVersion: reliabilityVersion, enabled: config.reliability?.enabled !== false },
    economics: { configured: config.economics !== undefined, spendCap: false },
  };
}

function tierModelKeys(config: BifrostConfig): string[] {
  const keys = new Set<string>();
  for (const pool of Object.values(config.models ?? {})) {
    for (const entry of poolEntries(pool)) if (entry.includes("/")) keys.add(entry);
  }
  return [...keys].sort();
}

// ── Candidate planning ─────────────────────────────────────────

interface SourceSnapshot {
  readonly source: ConfigAgentSource;
  readonly path: string;
  readonly exists: boolean;
  readonly text: string | null;
  readonly object: Record<string, unknown> | null;
  readonly digest: string | null;
  readonly readError?: string;
}

function readSelectedSource(cwd: string, extensionDir: string, source: ConfigAgentSource): SourceSnapshot {
  const path = configAgentSourcePaths(cwd, extensionDir)[source];
  const read = readSourceLayer(path);
  return {
    source,
    path,
    exists: read.bytes !== null,
    text: read.text,
    object: read.object,
    digest: read.text === null ? null : sha256(read.text),
    ...(read.error ? { readError: read.error } : {}),
  };
}

function isSource(value: unknown): value is ConfigAgentSource {
  return value === "project" || value === "workspace" || value === "user";
}

interface CandidatePlan {
  readonly ok: boolean;
  readonly reason?: string;
  readonly source: ConfigAgentSource;
  readonly sourcePath: string;
  readonly current: SourceSnapshot;
  readonly nextSource: Record<string, unknown>;
  readonly nextText: string;
  readonly changes: ConfigAgentChange[];
}

function planCandidate(
  cwd: string,
  extensionDir: string,
  request: ConfigAgentRequest,
): CandidatePlan {
  const source: ConfigAgentSource = isSource(request.source) ? request.source : "project";
  const current = readSelectedSource(cwd, extensionDir, source);
  const base = current.object ?? {};
  const patch = request.patch;
  const candidate = request.candidate;
  const remove = request.remove ?? [];
  const fail = (reason: string): CandidatePlan => ({
    ok: false, reason, source, sourcePath: current.path, current, nextSource: base, nextText: "", changes: [],
  });
  if (candidate !== undefined && !isPlainRecord(candidate)) return fail("candidate must be a JSON object");
  if (patch !== undefined && !isPlainRecord(patch)) return fail("patch must be a JSON object");
  if (candidate !== undefined && patch !== undefined) return fail("provide either candidate or patch, not both");
  if (candidate === undefined && patch === undefined) return fail("a check, preview, or apply requires candidate or patch");
  if (remove.length > 0 && patch === undefined) return fail("remove requires patch");
  if (candidate !== undefined && remove.length > 0) return fail("remove applies only to patch");
  if (remove.some((key) => typeof key !== "string" || key.length === 0)) return fail("remove entries must be non-empty strings");
  if (current.readError) return fail(`the selected source ${current.readError}`);
  let nextSource: Record<string, unknown>;
  if (candidate !== undefined) {
    nextSource = { ...candidate };
  } else {
    nextSource = { ...base };
    for (const key of remove) delete nextSource[key];
    for (const [key, value] of Object.entries(patch ?? {})) nextSource[key] = value;
  }
  const changes = diffFields(base, nextSource);
  if (changes.length === 0) return fail("the selected source already matches this proposal");
  return {
    ok: true, source, sourcePath: current.path, current, nextSource,
    nextText: serializeSource(nextSource),
    changes,
  };
}

function diffFields(before: Record<string, unknown>, after: Record<string, unknown>): ConfigAgentChange[] {
  const changes: ConfigAgentChange[] = [];
  for (const key of Object.keys(before).sort()) {
    if (!Object.hasOwn(after, key)) changes.push({ kind: "remove", field: key });
    else if (canonicalJson(before[key]) !== canonicalJson(after[key])) changes.push({ kind: "replace", field: key });
  }
  for (const key of Object.keys(after).sort()) {
    if (!Object.hasOwn(before, key)) changes.push({ kind: "add", field: key });
  }
  return changes;
}

// ── check ──────────────────────────────────────────────────────

export interface ConfigAgentCheckInput {
  readonly request: ConfigAgentRequest;
  readonly catalog: ConfigAgentCatalog;
  readonly cwd: string;
  readonly extensionDir: string;
}

export function checkConfigCandidate(input: ConfigAgentCheckInput): ConfigAgentCheckResult {
  const { request, catalog, cwd, extensionDir } = input;
  const plan = planCandidate(cwd, extensionDir, request);
  const empty = (status: ConfigAgentStatus, reason: string): ConfigAgentCheckResult => ({
    operation: "check",
    status,
    source: plan.source,
    sourcePath: plan.sourcePath,
    proposalDigest: null,
    guards: null,
    changes: [],
    nextSource: null,
    effectiveAfter: null,
    effectiveBefore: null,
    issues: [],
    diagnostics: [],
    references: [],
    routingAfter: null,
    newlyEligibleModels: [],
    removedModels: [],
    writeEligible: false,
    notes: [reason],
  });
  if (!plan.ok) return empty("usage", plan.reason ?? "invalid request");

  const bytes = Buffer.from(plan.nextText, "utf-8");
  if (bytes.byteLength > MAX_CONFIG_SOURCE_BYTES) return empty("rejected", "the candidate exceeds Bifrost's config size limit");

  const before = effectiveConfig(cwd, extensionDir);
  const prospective = loadConfigWithSourceOverride(cwd, extensionDir, plan.source, bytes);
  const after: LoadedConfig = {
    config: prospective.config,
    diagnostics: prospective.diagnostics.map(({ layer, message }) => ({ layer, message })),
  };
  const issues = issuesOf(after.config, after.diagnostics);
  const errors = issues.filter((issue) => issue.severity === "error");
  const references = checkModelReferences(after.config, catalog);
  const beforeModels = new Set(tierModelKeys(before.config));
  const afterModels = tierModelKeys(after.config);
  const newlyEligible = afterModels.filter((key) => !beforeModels.has(key)
    && catalog.available.some((model) => model.key === key));
  const removed = [...beforeModels].filter((key) => !afterModels.includes(key)).sort();

  const notes: string[] = [
    "Nothing was written. This check only composes the real config layers with the proposed source bytes.",
  ];
  if (references.some((reference) => reference.status === "unknown")) {
    notes.push("At least one configured pool entry matches no catalog model; it can never be selected.");
  }
  if (references.some((reference) => reference.status === "known_unavailable")) {
    notes.push("At least one configured pool entry exists in the catalog but is not currently available, so routing cannot select it.");
  }
  if (after.config.reliability?.stateVersion === 2) {
    notes.push("reliability.stateVersion 2 requires the v2 migration and only covers supported Auto turns.");
  }
  return {
    operation: "check",
    status: errors.length > 0 ? "rejected" : "ok",
    source: plan.source,
    sourcePath: plan.sourcePath,
    proposalDigest: sha256(plan.nextText),
    guards: {
      sourceDigest: plan.current.digest,
      effectiveDigest: effectiveDigest(before.config),
      catalogDigest: catalogDigest(catalog),
    },
    changes: plan.changes,
    nextSource: plan.nextSource,
    effectiveAfter: after.config as unknown as Record<string, unknown>,
    effectiveBefore: before.config as unknown as Record<string, unknown>,
    issues,
    diagnostics: after.diagnostics,
    references,
    routingAfter: routingSummary(after.config, cwd),
    newlyEligibleModels: newlyEligible,
    removedModels: removed,
    writeEligible: errors.length === 0,
    notes,
  };
}

// ── preview ────────────────────────────────────────────────────

function toRouterModel(model: ConfigAgentModel): RouterModel {
  return {
    provider: model.provider,
    id: model.id,
    cost: { input: model.inputCost, output: model.outputCost },
    contextWindow: model.contextWindow,
  };
}

function routerRegistry(catalog: ConfigAgentCatalog): RouterRegistrySnapshot {
  const known = new Map(catalog.known.map((model) => [model.key, model]));
  for (const model of catalog.available) known.set(model.key, model);
  return {
    knownModels: [...known.values()].map(toRouterModel),
    availableModels: catalog.available.map(toRouterModel),
  };
}

const ROUTER_CONFIG_KEYS = ["schemaVersion", "tierPolicies", "default", "strategy", "categoryStrategies", "models", "rules", "classifier", "reliability", "affinity"] as const;
const ROUTER_RELIABILITY_KEYS = ["enabled", "failureThreshold", "windowMinutes", "cooldownMinutes"] as const;

/** Project a full config onto the subset the resolve-only router accepts. */
function projectRouterConfig(config: BifrostConfig): RouterSnapshot["config"] {
  const source = config as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of ROUTER_CONFIG_KEYS) if (source[key] !== undefined) projected[key] = source[key];
  const reliability = projected.reliability;
  if (isPlainRecord(reliability)) {
    const filtered: Record<string, unknown> = {};
    for (const key of ROUTER_RELIABILITY_KEYS) if (reliability[key] !== undefined) filtered[key] = reliability[key];
    if (Object.keys(filtered).length > 0) projected.reliability = filtered;
    else delete projected.reliability;
  }
  return projected as RouterSnapshot["config"];
}

export interface ConfigAgentPreviewInput extends ConfigAgentCheckInput {
  readonly now: number;
}

export async function previewConfigCandidate(input: ConfigAgentPreviewInput): Promise<ConfigAgentPreviewResult> {
  const { request, catalog, now } = input;
  const checked = checkConfigCandidate(input);
  const base = {
    operation: "preview" as const,
    source: checked.source,
    sourcePath: checked.sourcePath,
    proposalDigest: checked.proposalDigest,
    guards: checked.guards,
    network: "disabled" as const,
    promptExecution: "none" as const,
    cases: [],
    tiers: [],
    issues: checked.issues,
    notes: [] as string[],
  };
  if (checked.status !== "ok" || !checked.effectiveAfter) {
    return {
      ...base,
      status: "blocked",
      notes: ["Preview needs a candidate that passes validation; run check and fix the reported errors.", ...checked.notes],
    };
  }
  const routerConfig = projectRouterConfig(checked.effectiveAfter as unknown as BifrostConfig);
  let router;
  try {
    router = createRouter({
      config: routerConfig,
      registry: routerRegistry(catalog),
      now,
    });
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      notes: [
        `Preview could not evaluate this candidate with Bifrost's resolver: ${error instanceof Error ? error.message : "unknown error"}`,
        "Nothing was written and no model was called.",
      ],
    };
  }

  const routing = checked.routingAfter;
  const classifiersCanChangeRoutes = routing?.classifier.enabled === true;
  const tiers: ConfigAgentPreviewTier[] = [];
  for (const tier of Object.keys(routerConfig.models ?? {})) {
    try {
      const resolved = await router.resolve({ prompt: "", forcedTier: tier, random: () => 0 });
      if (resolved.status !== "completed") continue;
      const decision = resolved.decision;
      const requested = decision.requested;
      tiers.push({
        tier,
        strategy: requested?.strategy ?? "first",
        patterns: requested?.patterns ?? [],
        ...(decision.selected ? { selected: decision.selected } : {}),
        excluded: (requested?.candidates ?? []).filter((candidate) => candidate.status === "excluded")
          .map((candidate) => ({ model: candidate.model, exclusion: candidate.exclusion ?? "excluded" })),
        unknownUnavailable: resolved.knownUnavailableModels,
      });
    } catch {
      // A tier the resolver rejects is reported by check:validation, not here.
    }
  }

  const cases: ConfigAgentPreviewCase[] = [];
  for (const raw of (request.prompts ?? []).slice(0, MAX_PROMPTS)) {
    if (typeof raw !== "string") continue;
    const prompt = raw.slice(0, MAX_PROMPT_CHARS);
    if (prompt.trim().length === 0) continue;
    const resolved = await router.resolve({ prompt, random: () => 0 });
    if (resolved.status !== "completed") continue;
    const decision = resolved.decision;
    const source = decision.classification.source;
    const decidedBy: ConfigAgentPreviewCase["decidedBy"] = source === "inline" ? "inline_tier_prefix"
      : source === "regex" ? "regex_rule"
        : decision.outcome === "unclassified" ? "none" : "default_tier";
    // A regex rule, an inline tier prefix, and (with the classifier off) the default
    // tier are all decided without a classifier call. Anything else depends on the
    // live classifier that this offline preview deliberately does not invoke.
    const confidence: ConfigAgentPreviewCase["confidence"] = decidedBy === "inline_tier_prefix" || decidedBy === "regex_rule"
      ? "deterministic"
      : decision.outcome !== "unclassified" && !classifiersCanChangeRoutes ? "deterministic" : "classifier_dependent";
    cases.push({
      prompt,
      decidedBy,
      confidence,
      ...(decision.classification.tier !== undefined ? { tier: decision.classification.tier } : {}),
      ...(decision.selected ? { selected: decision.selected } : {}),
      ...(decision.selectedTier !== undefined ? { selectedTier: decision.selectedTier } : {}),
      ...(decision.fallbackReason !== undefined ? { fallbackReason: decision.fallbackReason } : {}),
      excluded: (decision.requested?.candidates ?? []).filter((candidate) => candidate.status === "excluded")
        .map((candidate) => ({ model: candidate.model, exclusion: candidate.exclusion ?? "excluded" })),
      unavailable: resolved.knownUnavailableModels,
    });
  }

  const notes: string[] = [
    "Offline preview: no prompt was sent anywhere and no classifier or model was invoked.",
    "Tier assignments use the configured strategy with a fixed random source, so `random` picks the same candidate every time here.",
  ];
  if (classifiersCanChangeRoutes) {
    notes.push("The candidate enables the classifier, so prompt classification in a live session can pick a different tier than these cases show. Cases marked classifier_dependent show only the no-classifier path.");
  }
  if (catalog.available.length === 0) {
    notes.push("The model catalog reported no available models, so every tier resolves empty.");
  }
  return { ...base, status: "ok", cases, tiers, notes };
}

// ── apply ──────────────────────────────────────────────────────

export interface ConfigAgentApplyInput extends ConfigAgentCheckInput {
  /** Must return true only after the user explicitly approved this exact proposal. */
  readonly confirm: (title: string, message: string) => Promise<boolean> | boolean;
  readonly write?: (path: string, text: string) => void;
  readonly reload: () => boolean;
}

function approvalMessage(checked: ConfigAgentCheckResult): string {
  const lines = [
    `Source: ${checked.source} (${checked.sourcePath})`,
    `Proposal: ${shortDigest(checked.proposalDigest)}`,
    checked.changes.length === 0
      ? "Changes: none"
      : `Changes: ${checked.changes.map((change) => `${change.kind} ${change.field}`).join(", ")}`,
  ];
  const tiers = checked.routingAfter?.tiers ?? [];
  if (tiers.length > 0) {
    lines.push("Tiers after the change:");
    for (const tier of tiers) lines.push(`  ${tier.tier} (${tier.strategy}): ${tier.pool.join(", ") || "empty"}`);
  }
  lines.push("No other config source is modified.");
  return lines.join("\n").slice(0, MAX_APPROVAL_MESSAGE_CHARS);
}

export async function applyConfigCandidate(input: ConfigAgentApplyInput): Promise<ConfigAgentApplyResult> {
  const { request, catalog, cwd, extensionDir, confirm, reload } = input;
  const write = input.write ?? writeTextFile;
  const base = {
    operation: "apply" as const,
    applied: false,
    reloaded: false,
    verified: false,
    source: "project" as ConfigAgentSource,
    sourcePath: "",
    changes: [],
    effectiveConfig: null,
    routing: null,
  };
  const checked = checkConfigCandidate(input);
  const withCheck = {
    ...base,
    source: checked.source,
    sourcePath: checked.sourcePath,
    changes: checked.changes,
  };
  if (checked.status !== "ok" || checked.proposalDigest === null || checked.guards === null) {
    return {
      ...withCheck,
      status: checked.status === "usage" ? "usage" : "rejected",
      reason: checked.issues.find((issue) => issue.severity === "error")?.message ?? checked.notes[0] ?? "the candidate is not valid",
      notes: ["Nothing was written."],
    };
  }
  const missing = (["proposalDigest", "sourceDigest", "effectiveDigest", "catalogDigest"] as const)
    .filter((key) => request[key] === undefined);
  if (missing.length > 0) {
    return {
      ...withCheck,
      status: "usage",
      reason: `apply requires the digests from check or preview: ${missing.join(", ")} missing`,
      notes: ["Nothing was written. Run check, show the user the proposal, then apply the reviewed digests."],
    };
  }
  if (request.proposalDigest !== checked.proposalDigest) {
    return {
      ...withCheck,
      status: "stale",
      reason: "the candidate bytes no longer match the checked proposal",
      notes: ["Nothing was written. Run check again and re-confirm the current proposal."],
    };
  }
  const liveSource = readSelectedSource(cwd, extensionDir, checked.source);
  if (liveSource.readError) {
    return { ...withCheck, status: "rejected", reason: `the selected source ${liveSource.readError}`, notes: ["Nothing was written."] };
  }
  if (liveSource.digest !== request.sourceDigest) {
    return {
      ...withCheck,
      status: "stale",
      reason: "the selected source changed after this proposal was generated",
      notes: ["Nothing was written. Run check again against the current source."],
    };
  }
  const liveEffective = effectiveConfig(cwd, extensionDir);
  if (effectiveDigest(liveEffective.config) !== request.effectiveDigest) {
    return {
      ...withCheck,
      status: "stale",
      reason: "another configuration source changed after this proposal was generated",
      notes: ["Nothing was written. Run check again against the current layers."],
    };
  }
  if (catalogDigest(catalog) !== request.catalogDigest) {
    return {
      ...withCheck,
      status: "stale",
      reason: "the model inventory changed after this proposal was generated",
      notes: ["Nothing was written. Run check and preview again against the current catalog."],
    };
  }

  let approved: boolean;
  try {
    approved = await confirm("Apply this Bifrost configuration?", approvalMessage(checked));
  } catch {
    approved = false;
  }
  if (!approved) {
    return {
      ...withCheck,
      status: "declined",
      reason: "the user did not approve this change",
      notes: ["Nothing was written."],
    };
  }

  try {
    write(checked.sourcePath, serializeSource(checked.nextSource ?? {}));
  } catch {
    return {
      ...withCheck,
      status: "write_failed",
      reason: "the configuration file could not be written; the previous file is intact",
      notes: ["Nothing was changed. Report the failure and retry only if the user wants to."],
    };
  }

  const afterWrite = effectiveConfig(cwd, extensionDir);
  const issues = issuesOf(afterWrite.config, afterWrite.diagnostics);
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    // The atomic write already replaced the file; report the real state rather
    // than claiming success. Validation ran before the write, so this means an
    // unrelated layer changed in between.
    return {
      ...withCheck,
      status: "blocked",
      applied: true,
      reason: `the file was written but the effective configuration is now invalid: ${errors[0]!.message}`,
      effectiveConfig: afterWrite.config as unknown as Record<string, unknown>,
      routing: routingSummary(afterWrite.config, cwd),
      notes: ["Repair the reported issue and run /bifrost reload; Bifrost did not activate the invalid configuration."],
    };
  }

  let reloaded = false;
  try {
    reloaded = reload();
  } catch {
    reloaded = false;
  }
  const notes = reloaded
    ? ["Bifrost reloaded the saved configuration."]
    : ["The reviewed configuration is saved, but Bifrost did not activate it. Tell the user to run /bifrost reload and report the reported errors."];
  return {
    ...withCheck,
    status: reloaded ? "ok" : "reload_failed",
    applied: true,
    reloaded,
    verified: reloaded,
    effectiveConfig: afterWrite.config as unknown as Record<string, unknown>,
    routing: routingSummary(afterWrite.config, cwd),
    notes,
  };
}

// ── inspect ────────────────────────────────────────────────────

export interface ConfigAgentInspectInput {
  readonly catalog: ConfigAgentCatalog;
  readonly cwd: string;
  readonly extensionDir: string;
  /** Optional display filter for one provider; it never changes validation or routing. */
  readonly provider?: string;
}

export function inspectConfigAgent(input: ConfigAgentInspectInput): ConfigAgentInspectResult {
  const { catalog, cwd, extensionDir } = input;
  const provider = input.provider?.trim();
  const loaded = effectiveConfig(cwd, extensionDir);
  const layers = inspectLayers(cwd, extensionDir);
  const routeFile = routeFileFor(cwd);
  const restrictions = [
    "Only the user, workspace, and project sources are writable. The bundled extension config is Bifrost's default and is never written.",
    "Bifrost validates against schema versions 1 and 2; other values are rejected.",
    "A route file takes precedence over config `rules` when it exists.",
    "Economic settings are annotated/declared facts. They do not enforce a spend cap.",
    "Bifrost does not manage provider prompt caches and cannot promise cache reuse.",
  ];
  if (routeFile) restrictions.push(`route file present: ${routeFile} (config rules are ignored while it exists)`);
  if (catalog.metadataIncomplete.length > 0) {
    restrictions.push(`${catalog.metadataIncomplete.length} catalog model(s) report unusable cost or context metadata and cannot be routed: ${catalog.metadataIncomplete.slice(0, 8).join(", ")}`);
  }
  const inventory = provider ? catalog.available.filter((model) => model.provider === provider) : catalog.available;
  const knownUnavailableCount = catalog.known.length - catalog.available.length;
  const notes = [
    "No credentials, tokens, or account data are read or reported by this tool.",
    "This inventory is a snapshot. Re-run inspect before relying on it after a registry refresh or a config edit.",
  ];
  if (provider) {
    notes.push(inventory.length > 0
      ? `The reported inventory is filtered to provider "${provider}" for display only.`
      : `No available model belongs to provider "${provider}"; the reported inventory is empty.`);
  }
  return {
    operation: "inspect",
    status: "ok",
    layers,
    effectiveConfig: loaded.config as unknown as Record<string, unknown>,
    issues: issuesOf(loaded.config, loaded.diagnostics),
    diagnostics: loaded.diagnostics,
    routing: routingSummary(loaded.config, cwd),
    restrictions,
    inventory,
    availableModelCount: catalog.available.length,
    ...(provider ? { inventoryProvider: provider } : {}),
    knownUnavailableCount,
    notes,
  };
}

// ── Rendering ──────────────────────────────────────────────────

function modelLine(model: ConfigAgentModel): string {
  return `${model.key} ($${(model.inputCost + model.outputCost).toFixed(2)}/1M tokens, ctx ${model.contextWindow}${model.reasoning ? ", reasoning" : ""})`;
}

function bounded(lines: readonly string[]): string[] {
  return lines.length <= MAX_REPORT_LINES ? [...lines] : [...lines.slice(0, MAX_REPORT_LINES), `... ${lines.length - MAX_REPORT_LINES} more line(s)`];
}

function renderInspect(result: ConfigAgentInspectResult): string {
  const lines = [
    "--- bifrost configuration ---",
    `enabled: ${result.routing.enabled}`,
    `schemaVersion: ${result.routing.schemaVersion}`,
    `default tier: ${result.routing.defaultTier ?? "none"}`,
    `global strategy: ${result.routing.strategy ?? "first"}`,
    "layers (lowest to highest precedence):",
    ...result.layers.map((layer) => `  ${layer.layer}${layer.editable ? "" : " (read-only)"}: ${layer.path}${layer.exists ? ` [${layer.bytes} bytes, ${layer.fields.length} field(s)]` : " [absent]"}${layer.readError ? ` -- ${layer.readError}` : ""}`),
    "tiers:",
    ...result.routing.tiers.map((tier) => `  ${tier.tier} (${tier.strategy})${tier.fallbackTiers ? ` fallback: [${tier.fallbackTiers.join(", ")}]` : ""}: ${tier.pool.join(", ") || "empty"}`),
    `classifier: ${result.routing.classifier.enabled ? `enabled (${result.routing.classifier.backend ?? "auto backend"})` : "disabled"}`,
    `affinity: ${result.routing.affinity.mode}`,
    `reliability: v${result.routing.reliability.stateVersion}${result.routing.reliability.enabled ? "" : " (disabled)"}`,
    `available models: ${result.inventory.length}${result.inventoryProvider ? ` of ${result.availableModelCount} (provider "${result.inventoryProvider}")` : ""}`,
    `known but unavailable models: ${result.knownUnavailableCount}`,
  ];
  lines.push("available model inventory:");
  for (const model of result.inventory.slice(0, 40)) lines.push(`  ${modelLine(model)}`);
  if (result.inventory.length > 40) lines.push(`  ... ${result.inventory.length - 40} more; repeat inspect with a provider to narrow this list`);
  if (result.issues.length > 0) {
    lines.push("issues:");
    for (const issue of result.issues) lines.push(`  ${issue.severity}: ${issue.message}`);
  }
  lines.push("restrictions:");
  for (const restriction of result.restrictions) lines.push(`  ${restriction}`);
  lines.push("-----------------------------");
  return bounded(lines).join("\n");
}

function changeLine(change: ConfigAgentChange): string {
  return `${change.kind} ${change.field}`;
}

/**
 * The agent has to pass these digests back to apply, so the model-facing report
 * carries them in full even though the summary lines stay abbreviated.
 */
function digestLines(proposalDigest: string | null, guards: ConfigAgentGuards | null): string[] {
  if (!proposalDigest || !guards) return [];
  return [
    "apply digests (pass these back unchanged):",
    `  proposalDigest: ${proposalDigest}`,
    `  sourceDigest: ${guards.sourceDigest ?? "absent"}`,
    `  effectiveDigest: ${guards.effectiveDigest}`,
    `  catalogDigest: ${guards.catalogDigest}`,
  ];
}

function renderCheck(result: ConfigAgentCheckResult): string {
  const lines = [
    "--- bifrost candidate check ---",
    `status: ${result.status}`,
    `source: ${result.source} (${result.sourcePath})`,
    `proposal: ${shortDigest(result.proposalDigest)}`,
  ];
  if (result.status === "usage" || result.status === "rejected") {
    lines.push("nothing was written");
    for (const issue of result.issues.filter((issue) => issue.severity === "error")) lines.push(`  error: ${issue.message}`);
    for (const note of result.notes) lines.push(`  ${note}`);
    lines.push("------------------------------");
    return bounded(lines).join("\n");
  }
  lines.push(result.changes.length === 0 ? "changes: none" : "changes:");
  for (const change of result.changes) lines.push(`  ${changeLine(change)}`);
  lines.push("tiers after the change:");
  for (const tier of result.routingAfter?.tiers ?? []) {
    lines.push(`  ${tier.tier} (${tier.strategy})${tier.fallbackTiers ? ` fallback: [${tier.fallbackTiers.join(", ")}]` : ""}: ${tier.pool.join(", ") || "empty"}`);
  }
  if (result.references.length > 0) {
    lines.push("pool entries that cannot route:");
    for (const reference of result.references) lines.push(`  ${reference.tier}: ${reference.entry} (${reference.status})`);
  }
  if (result.newlyEligibleModels.length > 0) lines.push(`newly referenced models that are available: ${result.newlyEligibleModels.join(", ")}`);
  if (result.removedModels.length > 0) lines.push(`models no longer referenced by any tier: ${result.removedModels.join(", ")}`);
  const warnings = result.issues.filter((issue) => issue.severity === "warning");
  if (warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of warnings) lines.push(`  ${warning.message}`);
  }
  for (const note of result.notes) lines.push(`note: ${note}`);
  lines.push(`write eligible: ${result.writeEligible}`);
  if (result.writeEligible) lines.push(...digestLines(result.proposalDigest, result.guards));
  lines.push("------------------------------");
  return bounded(lines).join("\n");
}

function renderPreview(result: ConfigAgentPreviewResult): string {
  const lines = [
    "--- bifrost candidate preview (offline) ---",
    `status: ${result.status}`,
    `source: ${result.source} (${result.sourcePath})`,
    `proposal: ${shortDigest(result.proposalDigest)}`,
    `network: ${result.network}; prompt execution: ${result.promptExecution}`,
  ];
  if (result.status !== "ok") {
    for (const note of result.notes) lines.push(`  ${note}`);
    lines.push("-------------------------------------------");
    return bounded(lines).join("\n");
  }
  lines.push("tier assignments (forced tier resolution, deterministic):");
  for (const tier of result.tiers) {
    lines.push(`  ${tier.tier} (${tier.strategy}) -> ${tier.selected ?? "nothing resolved"}`);
    for (const excluded of tier.excluded) lines.push(`    excluded: ${excluded.model} (${excluded.exclusion})`);
    if (tier.unknownUnavailable.length > 0) lines.push(`    known but unavailable: ${tier.unknownUnavailable.join(", ")}`);
  }
  if (result.cases.length > 0) {
    lines.push("representative prompts:");
    for (const entry of result.cases) {
      lines.push(`  "${entry.prompt.slice(0, 80)}" -> ${entry.decidedBy} / ${entry.confidence}: ${entry.selected ? `${entry.selectedTier} => ${entry.selected}` : "no selection"}`);
      if (entry.fallbackReason) lines.push(`    fallback: ${entry.fallbackReason}`);
      for (const excluded of entry.excluded) lines.push(`    excluded: ${excluded.model} (${excluded.exclusion})`);
      if (entry.unavailable.length > 0) lines.push(`    known but unavailable: ${entry.unavailable.join(", ")}`);
    }
  }
  for (const note of result.notes) lines.push(`note: ${note}`);
  lines.push(...digestLines(result.proposalDigest, result.guards));
  lines.push("-------------------------------------------");
  return bounded(lines).join("\n");
}

function renderApply(result: ConfigAgentApplyResult): string {
  const lines = [
    "--- bifrost configuration apply ---",
    `status: ${result.status}`,
    `source: ${result.source} (${result.sourcePath})`,
    `applied: ${result.applied}; reloaded: ${result.reloaded}; verified: ${result.verified}`,
  ];
  if (result.reason) lines.push(`reason: ${result.reason}`);
  for (const change of result.changes) lines.push(`  ${changeLine(change)}`);
  if (result.routing) lines.push(`active default tier: ${result.routing.defaultTier ?? "none"}; tiers: ${result.routing.tiers.map((tier) => tier.tier).join(", ") || "none"}`);
  for (const note of result.notes) lines.push(`note: ${note}`);
  lines.push("----------------------------------");
  return bounded(lines).join("\n");
}

function reportText(result: ConfigAgentToolResult): string {
  switch (result.operation) {
    case "inspect": return renderInspect(result);
    case "check": return renderCheck(result);
    case "preview": return renderPreview(result);
    case "apply": return renderApply(result);
  }
}

// ── Tool ───────────────────────────────────────────────────────

/** Tool name the skill and the agent-facing instructions refer to. */
export const BIFROST_CONFIG_TOOL_NAME = "bifrost_config";

export interface ConfigAgentToolDeps {
  readonly extensionDir: string;
  /** Re-read the config layers and install them through Bifrost's existing reload path. */
  readonly reload: (ctx: ExtensionToolContext) => boolean;
  readonly cwd?: () => string;
  readonly now?: () => number;
  readonly write?: (path: string, text: string) => void;
}

function catalogFromContext(ctx: ExtensionContext): ConfigAgentCatalog {
  const registry = ctx.modelRegistry;
  let available: Model<Api>[] = [];
  let known: Model<Api>[] = [];
  try { available = registry.getAvailable() ?? []; } catch { available = []; }
  try {
    known = typeof registry.getAll === "function" ? registry.getAll() ?? [] : available;
  } catch {
    known = available;
  }
  return buildConfigAgentCatalog(available, known.length > 0 ? known : available);
}

const CONFIG_OBJECT_SCHEMA = Type.Record(Type.String(), Type.Unknown(), {
  description: "A Bifrost config object. Only supported v2 fields are ever written.",
});

const ConfigAgentParameters = Type.Object({
  operation: Type.Union([
    Type.Literal("inspect"),
    Type.Literal("check"),
    Type.Literal("preview"),
    Type.Literal("apply"),
  ], {
    description: "inspect: read models, layers, and effective policy. check: validate a candidate without writing. preview: evaluate representative routing cases offline. apply: write the approved candidate to one source.",
  }),
  source: Type.Optional(Type.Union([
    Type.Literal("project"),
    Type.Literal("workspace"),
    Type.Literal("user"),
  ], { description: "Config source to change. Defaults to project (.pi/bifrost.json)." })),
  candidate: Type.Optional(CONFIG_OBJECT_SCHEMA),
  patch: Type.Optional(CONFIG_OBJECT_SCHEMA),
  remove: Type.Optional(Type.Array(Type.String(), { description: "Top-level keys to delete. Requires patch." })),
  prompts: Type.Optional(Type.Array(Type.String(), { description: "Representative prompts to evaluate in preview. Offline: nothing is sent anywhere." })),
  provider: Type.Optional(Type.String({ description: "Restrict the inventory reported by inspect to one provider. Display only." })),
  proposalDigest: Type.Optional(Type.String({ description: "proposalDigest returned by check or preview for this exact candidate." })),
  sourceDigest: Type.Optional(Type.String({ description: "sourceDigest returned by check or preview for this exact candidate." })),
  effectiveDigest: Type.Optional(Type.String({ description: "effectiveDigest returned by check or preview for this exact candidate." })),
  catalogDigest: Type.Optional(Type.String({ description: "catalogDigest returned by check or preview for this exact candidate." })),
});

function readRequest(params: {
  readonly source?: ConfigAgentSource;
  readonly candidate?: Record<string, unknown>;
  readonly patch?: Record<string, unknown>;
  readonly remove?: readonly string[];
  readonly prompts?: readonly string[];
  readonly proposalDigest?: string;
  readonly sourceDigest?: string;
  readonly effectiveDigest?: string;
  readonly catalogDigest?: string;
}): ConfigAgentRequest {
  return {
    ...(params.source !== undefined ? { source: params.source } : {}),
    ...(params.candidate !== undefined ? { candidate: params.candidate } : {}),
    ...(params.patch !== undefined ? { patch: params.patch } : {}),
    ...(params.remove !== undefined ? { remove: params.remove } : {}),
    ...(params.prompts !== undefined ? { prompts: params.prompts } : {}),
    ...(params.proposalDigest !== undefined ? { proposalDigest: params.proposalDigest } : {}),
    ...(params.sourceDigest !== undefined ? { sourceDigest: params.sourceDigest } : {}),
    ...(params.effectiveDigest !== undefined ? { effectiveDigest: params.effectiveDigest } : {}),
    ...(params.catalogDigest !== undefined ? { catalogDigest: params.catalogDigest } : {}),
  };
}

/**
 * The one agent-facing Bifrost configuration tool. Operations share the same
 * layer loading, validation, resolution, and write path as the commands.
 */
export function createBifrostConfigTool(deps: ConfigAgentToolDeps): ToolDefinition<typeof ConfigAgentParameters, ConfigAgentToolResult, unknown> {
  const cwdOf = deps.cwd ?? (() => process.cwd());
  const nowOf = deps.now ?? (() => Date.now());
  return {
    name: BIFROST_CONFIG_TOOL_NAME,
    label: "Bifrost config",
    description: [
      "Inspect and safely change Bifrost's routing configuration.",
      "Use inspect to read the real model inventory, config layers, and effective policy;",
      "check to validate a proposed candidate without writing;",
      "preview to see offline routing outcomes for a candidate;",
      "apply to write an approved candidate to one config source.",
      "apply shows the exact changes, requires explicit user approval, and refuses when inputs changed since check/preview.",
    ].join(" "),
    promptSnippet: "Configure Bifrost routing from the user's goal without hand-editing JSON",
    parameters: ConfigAgentParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const operation = params.operation as ConfigAgentOperation;
      const request = readRequest(params);
      const cwd = cwdOf();
      const catalog = catalogFromContext(ctx);
      const input: ConfigAgentCheckInput = { request, catalog, cwd, extensionDir: deps.extensionDir };
      let result: ConfigAgentToolResult;
      switch (operation) {
        case "inspect":
          result = inspectConfigAgent({
            catalog,
            cwd,
            extensionDir: deps.extensionDir,
            ...(params.provider !== undefined ? { provider: params.provider } : {}),
          });
          break;
        case "check":
          result = checkConfigCandidate(input);
          break;
        case "preview":
          result = await previewConfigCandidate({ ...input, now: nowOf() });
          break;
        case "apply": {
          if (!ctx.hasUI) {
            result = {
              operation: "apply",
              status: "approval_required",
              source: request.source ?? "project",
              sourcePath: configAgentSourcePaths(cwd, deps.extensionDir)[request.source ?? "project"],
              applied: false,
              reloaded: false,
              verified: false,
              changes: [],
              effectiveConfig: null,
              routing: null,
              reason: "this session has no interactive confirmation, so Bifrost refuses to write configuration",
              notes: ["Nothing was written. Show the user the proposal and ask them to apply it in an interactive Pi session."],
            };
            break;
          }
          result = await applyConfigCandidate({
            ...input,
            confirm: (title, message) => ctx.ui.confirm(title, message),
            reload: () => deps.reload(ctx),
            ...(deps.write ? { write: deps.write } : {}),
          });
          break;
        }
        default:
          result = {
            operation: "check",
            status: "usage",
            source: "project",
            sourcePath: "",
            proposalDigest: null,
            guards: null,
            changes: [],
            nextSource: null,
            effectiveAfter: null,
            effectiveBefore: null,
            issues: [],
            diagnostics: [],
            references: [],
            routingAfter: null,
            newlyEligibleModels: [],
            removedModels: [],
            writeEligible: false,
            notes: [`unknown operation ${String(operation)}; use inspect, check, preview, or apply`],
          };
      }
      return {
        content: [{ type: "text", text: reportText(result) }],
        details: result,
        isError: result.status !== "ok",
      };
    },
  };
}
