/**
 * Agent-facing configuration helpers.
 *
 * Bifrost owns configuration primitives, validation, and write safety. A coding
 * agent owns the user's goal and composes those primitives with this module:
 *
 *   inspect → check → preview → apply
 *
 * Every operation reads the real config layers and the real model catalog.
 * `check` and `preview` never write and never send a model request; the adapter
 * resolves provider sign-in state, which may refresh an expired OAuth token.
 * `apply` writes one reviewed source with the same atomic writer the rest of
 * Bifrost uses, after an explicit confirmation, and only when the proposal
 * still matches the inputs it was generated from.
 *
 * No second schema validator, routing engine, or routing policy lives here:
 * validation delegates to `validateConfig`, routing to `resolveConfiguredTier`
 * through the resolve-only router, and pool matching to `findCandidates`.
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { configLayerPaths, exceedsConfigNestingDepth, loadConfigForReload, loadConfigWithSourceOverride, loadRules, type ConfigLoadDiagnostic } from "./config-load.ts";
import {
  MAX_CONFIG_SOURCE_BYTES,
  SUPPORTED_SCHEMA_VERSIONS,
  classifierTotalTimeoutIssue,
  schemaVersionAtLeast,
  validateConfig,
  validateTierPolicyConfig,
  type BifrostConfig,
} from "./config.ts";
import type { ClassifierBackend } from "./classifier-backends.ts";
import { validateConfigSourceStructure } from "./config-schema.ts";
import { reconcileEconomicSnapshot } from "./economic-config.ts";
import { findCandidates } from "./routing.ts";
import { checkProviderScope, compileRoutingScope } from "./routing-scope.ts";
import { createRouter, type RouterModel, type RouterRegistrySnapshot, type RouterSnapshot } from "./router.ts";
import { writeTextFile } from "./storage.ts";
import { isGenerativeModel } from "./virtual-model.ts";
import { approveConfig } from "./config-approval.ts";

// ── Limits ─────────────────────────────────────────────────────

const MAX_PROMPTS = 8;
const MAX_PROMPT_CHARS = 2_000;
// Bound approval text sent to the terminal; larger complete diffs fail closed.
const MAX_APPROVAL_MESSAGE_CHARS = 2_000_000;

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

/** What Pi can tell Bifrost about a provider's stored sign-in, without a model request. */
export type ConfigAgentProviderAuthState = "ready" | "not_configured" | "invalid" | "unknown";

export interface ConfigAgentProviderAuth {
  readonly provider: string;
  readonly state: ConfigAgentProviderAuthState;
  /** Where Pi found the credential, when it reports one. Never the credential itself. */
  readonly source?: string;
  /** Bounded single-line resolution failure, for `invalid`. */
  readonly reason?: string;
}

/** The registry surface auth resolution needs; both members are optional on older hosts. */
interface ConfigAgentAuthRegistry {
  getProviderAuthStatus?(provider: string): { configured: boolean; source?: string };
  getProviderAuth?(provider: string): Promise<unknown>;
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
  readonly classifierRuntimeDigest?: string;
}

/** Inputs a proposal was generated from. Apply rejects a changed input. */
export interface ConfigAgentGuards {
  /** Digest of the selected source file, or null when it does not exist. */
  readonly sourceDigest: string | null;
  /** Digest of the effective merged configuration before the change. */
  readonly effectiveDigest: string;
  /** Digest of the model inventory. */
  readonly catalogDigest: string;
  /** Effective classifier mode/backend snapshot; rechecked before and after approval. */
  readonly classifierRuntimeDigest: string | null;
}

export interface ConfigAgentClassifierRuntimeSnapshot {
  readonly enabled: boolean;
  readonly configuredEnabled: boolean;
  readonly source: "configuration" | "session" | "legacy-conflict" | "runtime-state-invalid";
  readonly backend?: string;
  readonly criteriaTiers?: readonly string[];
  readonly legacyConflict?: { readonly saved: boolean; readonly configured: boolean };
  readonly runtimeStateIssue?: "unreadable" | "invalid-json" | "invalid-shape";
}

/** Candidate projection is top-level; `actual` is the runtime from loaded config. */
export interface ConfigAgentClassifierRuntime extends ConfigAgentClassifierRuntimeSnapshot {
  readonly actual?: ConfigAgentClassifierRuntimeSnapshot;
  readonly loadedConfigDigest?: string;
  readonly configGeneration?: number;
  readonly diskState?: { readonly enabled: boolean; readonly legacyClassifierEnabled?: boolean; readonly runtimeStateIssue?: "unreadable" | "invalid-json" | "invalid-shape" };
}

export type ConfigAgentClassifierRuntimeProvider = (config: BifrostConfig) => ConfigAgentClassifierRuntime;

export interface ConfigAgentChange {
  readonly kind: "add" | "replace" | "remove";
  readonly field: string;
  /** The value the change replaces; absent when there is none. */
  readonly before?: unknown;
  /** The value the change introduces; absent when the change removes it. */
  readonly after?: unknown;
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
  | "cancelled"
  | "approval_failed"
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
  readonly diagnostics: readonly ConfigLoadDiagnostic[];
  readonly routing: ConfigAgentRoutingSummary;
  /** Sign-in state per inventory provider; `invalid` cannot route until re-authenticated. */
  readonly providerAuth: readonly ConfigAgentProviderAuth[];
  readonly restrictions: readonly string[];
  /** Physical models the agent may route to, narrowed by the optional provider filter. */
  readonly inventory: readonly ConfigAgentModel[];
  /** Total available models before an `inventoryProvider` filter. */
  readonly availableModelCount: number;
  readonly inventoryProvider?: string;
  /** Start of the reported page within the sorted display list; absent on the first page. */
  readonly inventoryOffset?: number;
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
    readonly configuredEnabled: boolean;
    readonly source: "configuration" | "session" | "legacy-conflict" | "runtime-state-invalid" | "config-only";
    readonly backend: string | undefined;
    readonly criteriaTiers: readonly string[];
    readonly legacyConflict?: { readonly saved: boolean; readonly configured: boolean };
    readonly runtimeStateIssue?: "unreadable" | "invalid-json" | "invalid-shape";
    readonly projected?: ConfigAgentClassifierRuntimeSnapshot;
    readonly loadedConfigMatches?: boolean;
    readonly configGeneration?: number;
  };
  readonly affinity: { readonly mode: string; readonly surfaceNote: string };
  readonly rules: { readonly configRules: number; readonly routeFile: string | null };
  readonly routeFileOverridesRules: boolean;
  readonly reliability: { readonly stateVersion: number; readonly enabled: boolean };
  readonly economics: { readonly configured: boolean; readonly spendCap: false };
}

/** One live-check outcome for a model the candidate routes to. */
export interface ConfigAgentProbeResult {
  readonly model: string;
  readonly status: "ok" | "error" | "timeout" | "skipped";
  readonly reason?: string;
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
  readonly diagnostics: readonly ConfigLoadDiagnostic[];
  readonly references: readonly ConfigAgentReferenceIssue[];
  /** Sign-in state the adapter resolved for this proposal; drives advisory warnings. */
  readonly providerAuth: readonly ConfigAgentProviderAuth[];
  readonly routingBefore: ConfigAgentRoutingSummary | null;
  readonly routingAfter: ConfigAgentRoutingSummary | null;
  readonly newlyEligibleModels: readonly string[];
  readonly removedModels: readonly string[];
  readonly writeEligible: boolean;
  readonly notes: readonly string[];
  /** Live probe outcomes, present only when the caller asked for one. */
  readonly liveProbe?: readonly ConfigAgentProbeResult[];
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
  readonly requestedTier?: string;
  readonly strategy: string;
  readonly patterns: readonly string[];
  readonly selected?: string;
  readonly selectedTier?: string;
  readonly fallbackReason?: string;
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
  readonly routing: ConfigAgentRoutingSummary | null;
  readonly notes: readonly string[];
}

export interface ConfigAgentApplyResult {
  readonly operation: "apply";
  readonly status: ConfigAgentStatus;
  readonly source: ConfigAgentSource | null;
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

/**
 * Canonical text form of a source digest. An absent source has no digest
 * (`null`), and the tool schema only accepts strings, so an agent can only
 * ever pass back the literal `"absent"` for a file that does not exist yet.
 * Both sides of the apply guard are normalized through this.
 */
function sourceDigestText(digest: string | null | undefined): string {
  return digest ?? "absent";
}

/** Short digest form shared by the approval dialog and the rendered report, so
 * the value a user approves is recognizably the value check printed. */
export function shortDigest(digest: string | null): string {
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
  // `available` keeps Pi's registry order on purpose: pool matching and
  // `first` selection are order-sensitive, so the preview router must see
  // the same order live routing sees. `inspect` sorts only its display.
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

const MAX_AUTH_REASON_CHARS = 200;

function boundedAuthReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Provider text is stripped of terminal escapes, flattened, and reduced to
  // printable text so a hostile or noisy error cannot inject into the report.
  const line = message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim() || "sign-in could not be resolved";
  return line.length <= MAX_AUTH_REASON_CHARS ? line : `${line.slice(0, MAX_AUTH_REASON_CHARS - 3)}...`;
}

/**
 * Resolve each provider's stored sign-in through Pi's registry. Pi's
 * synchronous auth status only reports that a credential is stored, not that it
 * works, so a dead OAuth refresh is invisible to `getProviderAuthStatus` and
 * only surfaces when credentials are actually resolved. Resolving may refresh
 * an expired token; it never sends a model request. Failures are reported, not
 * thrown: this signal is advisory.
 */
async function resolveProviderAuth(
  registry: ConfigAgentAuthRegistry,
  providers: readonly string[],
): Promise<ConfigAgentProviderAuth[]> {
  const resolved: ConfigAgentProviderAuth[] = [];
  for (const provider of [...new Set(providers)].sort()) {
    let source: string | undefined;
    // Whether Pi reports a credential on disk for this provider. Pi resolves a
    // credential it cannot use to nothing rather than throwing, so only a
    // stored credential makes an empty resolution a finding.
    let stored = false;
    try {
      const status = registry.getProviderAuthStatus?.(provider);
      if (status) {
        if (status.configured === false) {
          resolved.push({ provider, state: "not_configured" });
          continue;
        }
        stored = status.configured === true;
        source = status.source;
      }
    } catch {
      // A throwing status is not evidence either way; try to resolve instead.
    }
    if (typeof registry.getProviderAuth !== "function") {
      resolved.push({ provider, state: "unknown", ...(source ? { source } : {}) });
      continue;
    }
    try {
      const auth = await registry.getProviderAuth(provider);
      if (auth === undefined || auth === null) {
        // No usable credential came back: a stored one is broken, and without
        // one there is nothing to report beyond a name the catalog does not know.
        resolved.push(stored
          ? { provider, state: "invalid", ...(source ? { source } : {}), reason: "the stored sign-in cannot be used for this provider" }
          : { provider, state: "unknown", ...(source ? { source } : {}) });
        continue;
      }
      resolved.push({ provider, state: "ready", ...(source ? { source } : {}) });
    } catch (error) {
      resolved.push({ provider, state: "invalid", ...(source ? { source } : {}), reason: boundedAuthReason(error) });
    }
  }
  return resolved;
}

function registryContext(catalog: ConfigAgentCatalog, source: readonly ConfigAgentModel[] = catalog.available): ExtensionContext {
  const models = source.map((model) => ({
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

/** The same matcher over the known catalog, including models Pi cannot route right now. */
function knownPoolMatches(catalog: ConfigAgentCatalog, entry: string): string[] {
  return findCandidates(registryContext(catalog, catalog.known), entry).map((model) => `${model.provider}/${model.id}`);
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

/**
 * Tiers whose pool resolves to a provider whose stored sign-in does not work.
 * Advisory on purpose: a user may intend to re-authenticate after applying, so
 * this warns loudly without blocking the write.
 */
function providerAuthIssues(
  config: BifrostConfig,
  catalog: ConfigAgentCatalog,
  providerAuth: readonly ConfigAgentProviderAuth[],
): ConfigAgentIssueSummary[] {
  const problem = new Map(providerAuth
    .filter((auth) => auth.state === "invalid" || auth.state === "not_configured")
    .map((auth) => [auth.provider, auth]));
  if (problem.size === 0) return [];
  const providerOfModel = new Map<string, string>();
  for (const model of catalog.known) providerOfModel.set(model.key, model.provider);
  for (const model of catalog.available) providerOfModel.set(model.key, model.provider);
  // A dead sign-in removes the provider's models from every catalog Pi
  // exposes, so a pool entry has to be matched against the known catalog and
  // against the provider its `provider/model` prefix names: that is exactly
  // the case this warning exists for.
  const candidateKeys = (entry: string): string[] => [...new Set([
    ...poolMatches(catalog, entry),
    ...knownPoolMatches(catalog, entry),
  ])];
  // `routingScope` is a hard eligibility filter, so a provider it forbids for
  // this tier can never be selected and its dead sign-in is not this tier's
  // problem. Reporting it would push the user toward an unnecessary change.
  const scope = compileRoutingScope(config.routingScope);
  const issues: ConfigAgentIssueSummary[] = [];
  const reported = new Set<string>();
  for (const [tier, pool] of Object.entries(config.models ?? {})) {
    for (const entry of poolEntries(pool)) {
      const keys = candidateKeys(entry);
      const slash = entry.indexOf("/");
      const named = slash > 0 ? entry.slice(0, slash) : undefined;
      const providers = new Set(keys.map((key) => providerOfModel.get(key)).filter((provider): provider is string => provider !== undefined));
      if (named) providers.add(named);
      for (const provider of providers) {
        const auth = problem.get(provider);
        if (!auth) continue;
        const matched = keys.find((key) => providerOfModel.get(key) === provider);
        // An unconfigured provider only earns a warning when a real model
        // matched; a bare entry prefix could also just be a typo. A stored
        // credential Pi cannot resolve is evidence on its own: Pi hides those
        // models from the catalog, so the name is all that is left.
        if (!matched && auth.state !== "invalid") continue;
        if (!checkProviderScope(scope, provider, { tier }).allowed) continue;
        const dedupe = `${tier}:${provider}:${auth.state}`;
        if (reported.has(dedupe)) continue;
        reported.add(dedupe);
        const reference = matched ?? entry;
        issues.push({
          severity: "warning",
          code: auth.state === "invalid" ? "config.provider_auth_invalid" : "config.provider_auth_not_configured",
          path: `models.${tier}`,
          message: auth.state === "invalid"
            ? `Provider "${provider}" sign-in cannot be resolved (${auth.reason ?? "unknown error"}), so ${reference} would fail when selected. Sign in to ${provider} in Pi again before relying on tier "${tier}".`
            : `Provider "${provider}" has no configured sign-in, so ${reference} cannot route. Set up ${provider} in Pi or remove it from tier "${tier}".`,
        });
      }
    }
  }
  return issues;
}

/**
 * Exact catalog models a composed candidate routes to. A pool entry may be a
 * bare id or name a model Pi hides right now, so both catalogs are consulted;
 * a live probe only ever targets exact `provider/id` keys.
 */
function probeModelKeys(
  pools: Iterable<string>,
  catalog: ConfigAgentCatalog,
): string[] {
  const known = new Set([
    ...catalog.available.map((model) => model.key),
    ...catalog.known.map((model) => model.key),
  ]);
  const keys = new Set<string>();
  for (const entry of pools) {
    for (const key of poolMatches(catalog, entry)) if (known.has(key)) keys.add(key);
    for (const key of knownPoolMatches(catalog, entry)) if (known.has(key)) keys.add(key);
  }
  return [...keys].sort();
}

/** Warning for a model the live check reached and could not answer. */
function probeIssues(
  probed: readonly ConfigAgentProbeResult[],
): ConfigAgentIssueSummary[] {
  return probed
    .filter((entry) => entry.status === "error" || entry.status === "timeout")
    .map((entry) => ({
      severity: "warning" as const,
      code: "config.probe_failed",
      message: `Live probe of ${entry.model} ${entry.status === "timeout" ? "timed out" : "failed"}${entry.reason ? `: ${entry.reason}` : ""}. That model would fail when a tier selects it; the candidate is still writable.`,
    }));
}

/**
 * Models a live probe may target: the resolved pools of the composed config,
 * minus every candidate a hard provider scope forbids for its tier. Probing an
 * excluded provider would spend a request on a model that can never be
 * selected, which is exactly the credit the opt-in is meant to account for.
 */
function probeTargets(
  result: ConfigAgentCheckResult,
  catalog: ConfigAgentCatalog,
): string[] {
  const scope = compileRoutingScope(((result.effectiveAfter ?? {}) as BifrostConfig).routingScope);
  const providerOf = new Map<string, string>();
  for (const model of catalog.known) providerOf.set(model.key, model.provider);
  for (const model of catalog.available) providerOf.set(model.key, model.provider);
  const targets = new Set<string>();
  for (const tier of result.routingAfter?.tiers ?? []) {
    for (const key of probeModelKeys(tier.pool, catalog)) {
      const provider = providerOf.get(key);
      if (provider !== undefined && !checkProviderScope(scope, provider, { tier: tier.tier }).allowed) continue;
      targets.add(key);
    }
  }
  return [...targets].sort();
}

/**
 * Run the opt-in live check against the models a candidate would route to.
 * Advisory on purpose: a probe failure is evidence about the provider, not
 * proof that the candidate is wrong, so it warns and leaves the write eligible.
 */
async function applyLiveProbe(
  result: ConfigAgentCheckResult,
  catalog: ConfigAgentCatalog,
  deps: ConfigAgentToolDeps,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<ConfigAgentCheckResult> {
  if (result.status !== "ok") {
    return { ...result, notes: [...result.notes, "Live probe skipped: the candidate did not pass check."] };
  }
  const models = probeTargets(result, catalog);
  if (models.length === 0) {
    return { ...result, notes: [...result.notes, "Live probe skipped: this candidate routes to no model the catalog knows."] };
  }
  if (!deps.probeModels) {
    return { ...result, notes: [...result.notes, "Live probe is unavailable in this host; nothing was sent."] };
  }
  // A cancelled call must not start more provider requests; the transport gets
  // the same signal so it can stop queued work it already owns.
  if (signal?.aborted) {
    return { ...result, notes: [...result.notes, "Live probe cancelled before it started; nothing was sent."] };
  }
  let probed: readonly ConfigAgentProbeResult[];
  try {
    probed = await deps.probeModels(models, ctx, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...result,
      notes: [...result.notes, `Live probe could not run (${message}); nothing was written.`],
    };
  }
  if (probed.length === 0) {
    return { ...result, notes: [...result.notes, "Live probe returned no result; nothing was written."] };
  }
  const cancelled = signal?.aborted === true;
  return {
    ...result,
    liveProbe: probed,
    // Partial results after a cancellation are shown but not turned into
    // warnings: a stopped probe says nothing about the model it never reached.
    issues: cancelled ? result.issues : [...result.issues, ...probeIssues(probed)],
    notes: [...result.notes, cancelled
      ? "Live probe was cancelled; the reported outcomes are partial and were not turned into warnings."
      : "Live probe sends one tiny prompt per model and spends a small amount of credit."],
  };
}

// ── Effective config + routing summary ─────────────────────────

interface LoadedConfig {
  readonly config: BifrostConfig;
  readonly diagnostics: readonly ConfigLoadDiagnostic[];
  /** Structural findings the domain validators own: boot and reload print
   * these, so the agent's inspect/check/preview report must carry them too. */
  readonly warnings: readonly ConfigLoadDiagnostic[];
}

function effectiveConfig(cwd: string, extensionDir: string): LoadedConfig {
  const loaded = loadConfigForReload(cwd, extensionDir);
  return { config: loaded.config, diagnostics: loaded.diagnostics, warnings: loaded.warnings };
}

function effectiveDigest(config: BifrostConfig): string {
  return sha256(canonicalJson(config as unknown as Record<string, unknown>));
}

/** Stable config fingerprint shared with the Pi adapter for loaded-vs-disk reporting. */
export function configAgentConfigDigest(config: BifrostConfig): string {
  return effectiveDigest(config);
}

function issuesOf(
  config: BifrostConfig,
  diagnostics: readonly ConfigLoadDiagnostic[],
  warnings: readonly ConfigLoadDiagnostic[] = [],
  classifierRuntime?: ConfigAgentClassifierRuntime,
): ConfigAgentIssueSummary[] {
  const issues: ConfigAgentIssueSummary[] = [...validateConfig(config, {
    ...(classifierRuntime?.backend ? { effectiveClassifierBackend: classifierRuntime.backend as ClassifierBackend } : {}),
    ...(classifierRuntime ? { classifierEnabled: classifierRuntime.enabled } : {}),
  }), ...validateTierPolicyConfig(config)]
    .map((issue) => ({
      severity: issue.severity,
      ...(issue.code ? { code: issue.code } : {}),
      ...(issue.path ? { path: issue.path } : {}),
      message: issue.message,
    }));
  const timeout = classifierTotalTimeoutIssue(config);
  if (timeout) issues.push({ severity: timeout.severity, ...(timeout.code ? { code: timeout.code } : {}), ...(timeout.path ? { path: timeout.path } : {}), message: timeout.message });
  // Loader messages already name their layer ("project config …"), so they are
  // reported verbatim rather than re-prefixed. Warnings carry no code: the
  // de-duplication below keys on the code when present, and distinct structural
  // findings must not collapse into one line.
  for (const diagnostic of diagnostics) issues.push({ severity: "error", code: "config.source_invalid", message: diagnostic.message });
  for (const warning of warnings) issues.push({ severity: "warning", message: warning.message });
  const unique = new Map(issues.map((issue) => [`${issue.severity}:${issue.code ?? ""}:${issue.path ?? ""}:${issue.message}`, issue]));
  return [...unique.values()];
}

function routeFileFor(cwd: string): string | null {
  const candidates = [join(cwd, ".pi", "bifrost-routes.json"), join(cwd, "bifrost-routes.json")];
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

function routingSummary(
  config: BifrostConfig,
  cwd: string,
  runtime?: ConfigAgentClassifierRuntime,
): ConfigAgentRoutingSummary {
  const modelTiers = config.models ?? {};
  const tierNames = Object.keys(modelTiers);
  const routeFile = routeFileFor(cwd);
  const classifier = config.classifier;
  const actual = runtime?.actual ?? runtime;
  const projected = runtime;
  const loadedConfigMatches = runtime?.loadedConfigDigest === undefined
    ? undefined : runtime.loadedConfigDigest === effectiveDigest(config);
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
      enabled: actual?.enabled ?? classifier?.enabled !== false,
      configuredEnabled: actual?.configuredEnabled ?? classifier?.enabled !== false,
      source: actual?.source ?? "config-only",
      backend: actual?.backend ?? classifier?.backend,
      criteriaTiers: actual?.criteriaTiers ?? Object.keys(classifier?.criteria ?? {}),
      ...(actual?.legacyConflict ? { legacyConflict: actual.legacyConflict } : {}),
      ...(actual?.runtimeStateIssue ? { runtimeStateIssue: actual.runtimeStateIssue } : {}),
      ...(projected ? { projected: {
        enabled: projected.enabled,
        configuredEnabled: projected.configuredEnabled,
        source: projected.source,
        backend: projected.backend,
        criteriaTiers: projected.criteriaTiers ?? Object.keys(classifier?.criteria ?? {}),
        ...(projected.legacyConflict ? { legacyConflict: projected.legacyConflict } : {}),
        ...(projected.runtimeStateIssue ? { runtimeStateIssue: projected.runtimeStateIssue } : {}),
      } } : {}),
      ...(loadedConfigMatches !== undefined ? { loadedConfigMatches } : {}),
      ...(runtime?.configGeneration !== undefined ? { configGeneration: runtime.configGeneration } : {}),
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

function classifierRuntimeDigest(before: ConfigAgentClassifierRuntime | undefined, after: ConfigAgentClassifierRuntime | undefined): string | null {
  return after ? sha256(canonicalJson({ before: before ?? null, after })) : null;
}

function authoredStructureIssues(
  candidate: Record<string, unknown>,
  changedFields?: readonly string[],
): ConfigAgentIssueSummary[] {
  const changed = changedFields ? new Set(changedFields) : undefined;
  return validateConfigSourceStructure(candidate)
    .filter((issue) => !changed || (issue.path !== undefined && changed.has(issue.path.split(".")[0]!)))
    .map((issue) => ({
      severity: "error",
      ...(issue.code ? { code: issue.code } : {}),
      ...(issue.path ? { path: issue.path } : {}),
      message: issue.message,
    }));
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
  allowUnchanged = false,
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
  if (exceedsConfigNestingDepth(base) || exceedsConfigNestingDepth(nextSource)) return fail("configuration exceeds the nesting depth limit");
  const changes = diffFields(base, nextSource);
  if (changes.length === 0 && !allowUnchanged) return fail("the selected source already matches this proposal");
  return {
    ok: true, source, sourcePath: current.path, current, nextSource,
    nextText: serializeSource(nextSource),
    changes,
  };
}

function diffFields(before: Record<string, unknown>, after: Record<string, unknown>): ConfigAgentChange[] {
  const changes: ConfigAgentChange[] = [];
  for (const key of Object.keys(before).sort()) {
    if (!Object.hasOwn(after, key)) changes.push({ kind: "remove", field: key, before: before[key] });
    else if (canonicalJson(before[key]) !== canonicalJson(after[key])) {
      changes.push({ kind: "replace", field: key, before: before[key], after: after[key] });
    }
  }
  for (const key of Object.keys(after).sort()) {
    if (!Object.hasOwn(before, key)) changes.push({ kind: "add", field: key, after: after[key] });
  }
  return changes;
}

// ── check ──────────────────────────────────────────────────────

export interface ConfigAgentCheckInput {
  readonly request: ConfigAgentRequest;
  readonly catalog: ConfigAgentCatalog;
  readonly cwd: string;
  readonly extensionDir: string;
  readonly classifierRuntime?: ConfigAgentClassifierRuntimeProvider;
  /** Sign-in state resolved by the adapter; absent means the host has no signal. */
  readonly providerAuth?: readonly ConfigAgentProviderAuth[];
  readonly allowUnchanged?: boolean;
}

/**
 * Shared shape for a check result that produced nothing to report: usage and
 * rejection answers from both the pure check path and the tool's unknown-
 * operation default return this. */
function emptyCheckResult(
  status: ConfigAgentStatus,
  reason: string,
  source: ConfigAgentSource,
  sourcePath: string,
): ConfigAgentCheckResult {
  return {
    operation: "check",
    status,
    source,
    sourcePath,
    proposalDigest: null,
    guards: null,
    changes: [],
    nextSource: null,
    effectiveAfter: null,
    effectiveBefore: null,
    issues: [],
    diagnostics: [],
    references: [],
    providerAuth: [],
    routingBefore: null,
    routingAfter: null,
    newlyEligibleModels: [],
    removedModels: [],
    writeEligible: false,
    notes: [reason],
  };
}

export function checkConfigCandidate(input: ConfigAgentCheckInput): ConfigAgentCheckResult {
  const { request, catalog, cwd, extensionDir } = input;
  const plan = planCandidate(cwd, extensionDir, request, input.allowUnchanged);
  if (!plan.ok) return emptyCheckResult("usage", plan.reason ?? "invalid request", plan.source, plan.sourcePath);

  const bytes = Buffer.from(plan.nextText, "utf-8");
  if (bytes.byteLength > MAX_CONFIG_SOURCE_BYTES) return emptyCheckResult("rejected", "the candidate exceeds Bifrost's config size limit", plan.source, plan.sourcePath);

  const before = effectiveConfig(cwd, extensionDir);
  const prospective = loadConfigWithSourceOverride(cwd, extensionDir, plan.source, bytes);
  const after: LoadedConfig = {
    config: prospective.config,
    diagnostics: prospective.diagnostics.map(({ layer, message }) => ({ layer, message })),
    warnings: prospective.warnings.map(({ layer, message }) => ({ layer, message })),
  };
  const runtimeBefore = input.classifierRuntime?.(before.config);
  const runtimeAfter = input.classifierRuntime?.(after.config);
  const providerAuth = input.providerAuth ?? [];
  const combinedIssues = [
    ...issuesOf(after.config, after.diagnostics, after.warnings, runtimeAfter),
    ...providerAuthIssues(after.config, catalog, providerAuth),
    ...authoredStructureIssues(plan.nextSource, request.candidate === undefined ? Object.keys(request.patch ?? {}) : undefined),
  ];
  const issues = [...new Map(combinedIssues.map((issue) => [
    `${issue.severity}:${issue.code ?? ""}:${issue.path ?? ""}:${issue.message}`, issue,
  ])).values()];
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
  if (runtimeBefore?.loadedConfigDigest !== undefined && runtimeBefore.loadedConfigDigest !== effectiveDigest(before.config)) {
    notes.push("The active loaded config differs from current disk layers; routing continues with the loaded config until a successful reload.");
  }
  if (runtimeBefore?.runtimeStateIssue) {
    notes.push("Runtime state is invalid; classifier use is fail-closed even when the current session requests enablement. Repair the state file and reload.");
  }
  if (references.some((reference) => reference.status === "unknown")) {
    notes.push("At least one configured pool entry matches no catalog model; it can never be selected.");
  }
  if (references.some((reference) => reference.status === "known_unavailable")) {
    notes.push("At least one configured pool entry exists in the catalog but is not currently available, so routing cannot select it.");
  }
  if (runtimeAfter?.legacyConflict) {
    notes.push(runtimeAfter.source === "session"
      ? `Legacy classifierEnabled=${runtimeAfter.legacyConflict.saved} conflicts with configured=${runtimeAfter.legacyConflict.configured}; explicit session override is active.`
      : runtimeAfter.legacyConflict.configured
        ? "Classifier is paused: legacy classifierEnabled=false conflicts with configured true; an explicit session choice is required before classification can send prompts."
        : "Classifier remains disabled because configured false overrides legacy classifierEnabled=true. Run /bifrost classifier on only if the user wants classification for this session.");
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
      classifierRuntimeDigest: classifierRuntimeDigest(runtimeBefore, runtimeAfter),
    },
    changes: plan.changes,
    nextSource: plan.nextSource,
    effectiveAfter: after.config as unknown as Record<string, unknown>,
    effectiveBefore: before.config as unknown as Record<string, unknown>,
    issues,
    diagnostics: after.diagnostics,
    references,
    providerAuth,
    routingBefore: routingSummary(before.config, cwd, runtimeBefore),
    routingAfter: routingSummary(after.config, cwd, runtimeAfter),
    newlyEligibleModels: newlyEligible,
    removedModels: removed,
    writeEligible: errors.length === 0 && plan.changes.length > 0,
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

const ROUTER_CONFIG_KEYS = ["schemaVersion", "tierPolicies", "routingScope", "default", "strategy", "categoryStrategies", "models", "rules", "classifier", "reliability", "affinity"] as const;
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
  const { request, catalog, cwd, now } = input;
  const checked = checkConfigCandidate({
    ...input,
    allowUnchanged: true,
    request: request.candidate === undefined && request.patch === undefined && !request.remove?.length
      ? { ...request, patch: {} }
      : request,
  });
  const base = {
    operation: "preview" as const,
    source: checked.source,
    sourcePath: checked.sourcePath,
    proposalDigest: checked.changes.length > 0 ? checked.proposalDigest : null,
    guards: checked.changes.length > 0 ? checked.guards : null,
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
      routing: null,
      notes: ["Preview needs a candidate that passes validation; run check and fix the reported errors.", ...checked.notes],
    };
  }
  const afterConfig = checked.effectiveAfter as unknown as BifrostConfig;
  // Preview must route like the active router: rules resolve from the
  // bifrost-routes.json override first, and the candidate's economic policy
  // and declared facts join the snapshot through the same offline helper.
  const routerConfig = { ...projectRouterConfig(afterConfig), rules: loadRules(cwd, afterConfig) };
  const economics = reconcileEconomicSnapshot(undefined, undefined, afterConfig.economics);
  const economic = economics.policy ? { policy: economics.policy, snapshot: economics.snapshot } : undefined;
  let router;
  try {
    router = createRouter({
      config: routerConfig,
      registry: routerRegistry(catalog),
      now,
      ...(economic ? { economic } : {}),
    });
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      routing: null,
      notes: [
        `Preview could not evaluate this candidate with Bifrost's resolver: ${error instanceof Error ? error.message : "unknown error"}`,
        "Nothing was written and no model was called.",
      ],
    };
  }

  const routing = checked.routingAfter;
  const classifiersCanChangeRoutes = (routing?.classifier.projected?.enabled ?? routing?.classifier.enabled) === true;
  const tiers: ConfigAgentPreviewTier[] = [];
  for (const tier of Object.keys(routerConfig.models ?? {})) {
    try {
      const resolved = await router.resolve({ prompt: "", forcedTier: tier, random: () => 0 });
      if (resolved.status !== "completed") {
        tiers.push({ tier, strategy: afterConfig.categoryStrategies?.[tier] ?? afterConfig.strategy ?? "first", patterns: poolEntries(afterConfig.models?.[tier]), excluded: [], unknownUnavailable: [] });
        continue;
      }
      const decision = resolved.decision;
      const requested = decision.requested;
      tiers.push({
        tier,
        ...(requested?.tier ? { requestedTier: requested.tier } : {}),
        strategy: requested?.strategy ?? "first",
        patterns: requested?.patterns ?? [],
        ...(decision.selected ? { selected: decision.selected } : {}),
        ...(decision.selectedTier ? { selectedTier: decision.selectedTier } : {}),
        ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}),
        excluded: (requested?.candidates ?? []).filter((candidate) => candidate.status === "excluded")
          .map((candidate) => ({ model: candidate.model, exclusion: candidate.exclusion ?? "excluded" })),
        unknownUnavailable: resolved.knownUnavailableModels,
      });
    } catch {
      // A tier the resolver rejects is reported by check:validation, not here.
    }
  }

  const tierNames = new Set(Object.keys(routerConfig.models ?? {}));
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
    // An inline tier prefix is decided before any classification, and a rule that
    // names a physical model is applied before the pipeline ever calls a classifier,
    // so both are deterministic. A rule that names a tier only runs after the live
    // classifier (see classification-pipeline.ts), so with classification enabled
    // this offline case shows the classifier-free fallback, not the live route.
    const ruleNamesModel = typeof decision.classification.tier === "string"
      && decision.classification.tier.includes("/")
      && !tierNames.has(decision.classification.tier);
    const confidence: ConfigAgentPreviewCase["confidence"] =
      decidedBy === "inline_tier_prefix" || (decidedBy === "regex_rule" && ruleNamesModel)
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
    "Preview assumes healthy models: saved circuit breaks and provider cooldowns are not loaded, so live routing may skip a paused model that resolves here.",
  ];
  const emptyTiers = routing?.tiers.filter((tier) => tier.pool.length === 0).map((tier) => tier.tier) ?? [];
  if (emptyTiers.length > 0) {
    notes.push(`Empty tiers remain configured boundaries and were not filtered: ${emptyTiers.join(", ")}. Inspect requested tier, selected tier, and fallback reason below; no implicit fallback is added.`);
  }
  if (classifiersCanChangeRoutes) {
    notes.push("Projected classifier runtime is enabled, so prompt classification after apply and reload can pick a different tier than these cases show. Cases marked classifier_dependent show only the offline no-classifier path.");
  }
  if (catalog.available.length === 0) {
    notes.push("The model catalog reported no available models, so every tier resolves empty.");
  }
  return { ...base, status: "ok", cases, tiers, routing, notes };
}

// ── apply ──────────────────────────────────────────────────────

export interface ConfigAgentApplyInput extends ConfigAgentCheckInput {
  /** Must return true only after the user explicitly approved this exact proposal. */
  readonly confirm: (title: string, summary: string, details: string) => Promise<boolean> | boolean;
  readonly write?: (path: string, text: string) => void;
  readonly reload: () => boolean;
  /** Re-derives the model inventory when apply revalidates after approval. */
  readonly liveCatalog?: () => ConfigAgentCatalog;
}

/** ASCII JSON escapes make whitespace, controls, and bidi/zero-width text unambiguous. */
function approvalJson(value: unknown): string {
  return canonicalJson(value).replace(/[^\x21-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Warning prose keeps spaces readable; only control and non-ASCII characters are escaped. */
function approvalText(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function approvalDetails(checked: ConfigAgentCheckResult): string | null {
  const lines = [
    `Source: ${checked.source} (${approvalJson(checked.sourcePath)})`,
    `Proposal: ${shortDigest(checked.proposalDigest)}`,
    checked.changes.length === 0
      ? "Changes: none"
      : `Changes: ${checked.changes.map((change) => `${change.kind} ${approvalJson(change.field)}`).join(", ")}`,
  ];
  for (const change of checked.changes) {
    if (change.kind === "add") lines.push(`  ${approvalJson(change.field)}: ${approvalJson(change.after)}`);
    else if (change.kind === "remove") lines.push(`  ${approvalJson(change.field)}: ${approvalJson(change.before)} (removed)`);
    else lines.push(`  ${approvalJson(change.field)}: ${approvalJson(change.before)} -> ${approvalJson(change.after)}`);
  }
  const runtime = checked.routingAfter?.classifier;
  if (runtime) {
    lines.push(`Classifier runtime: ${runtime.enabled ? "enabled" : "disabled"} (${runtime.source}); configured=${runtime.configuredEnabled ? "on" : "off"}; backend=${runtime.backend ?? "unresolved"}${runtime.legacyConflict ? `; legacy saved=${runtime.legacyConflict.saved} conflicts with configured=${runtime.legacyConflict.configured}` : ""}`);
  }
  const tiers = checked.routingAfter?.tiers ?? [];
  if (tiers.length > 0) {
    lines.push("Tiers after the change:");
    for (const tier of tiers) lines.push(`  ${approvalJson(tier.tier)} (${approvalJson(tier.strategy)}): ${approvalJson(tier.pool)}`);
  }
  for (const warning of checked.issues.filter((issue) => issue.severity === "warning")) {
    lines.push(`Warning: ${approvalText(warning.message)}`);
  }
  lines.push("No other config source is modified.");
  const message = lines.join("\n");
  return message.length <= MAX_APPROVAL_MESSAGE_CHARS ? message : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

function approvalValue(value: unknown): string {
  if (value === undefined) return "(not set)";
  const text = approvalJson(value);
  return text.length <= 180 ? text : `${text.slice(0, 177)}... (see full exact change)`;
}

function approvalList(values: readonly string[], limit: number): string {
  const shown = values.slice(0, limit).join(", ");
  return values.length > limit ? `${shown}, … ${values.length - limit} more (see full exact change)` : shown;
}

function ruleChanges(beforeValue: unknown, afterValue: unknown): { before: number; after: number; removed: string[]; added: string[]; orderChanged: boolean } | undefined {
  const before = Array.isArray(beforeValue) ? beforeValue : [];
  const after = Array.isArray(afterValue) ? afterValue : [];
  if (canonicalJson(before) === canonicalJson(after)) return undefined;
  const counts = (rules: readonly unknown[]): Map<string, number> => {
    const result = new Map<string, number>();
    for (const rule of rules) {
      const key = canonicalJson(rule);
      result.set(key, (result.get(key) ?? 0) + 1);
    }
    return result;
  };
  const beforeCounts = counts(before);
  const afterCounts = counts(after);
  const delta = (from: Map<string, number>, to: Map<string, number>): string[] =>
    [...from].flatMap(([rule, count]) => Array.from({ length: Math.max(0, count - (to.get(rule) ?? 0)) }, () => rule)).sort();
  const removed = delta(beforeCounts, afterCounts);
  const added = delta(afterCounts, beforeCounts);
  return { before: before.length, after: after.length, removed, added, orderChanged: removed.length === 0 && added.length === 0 };
}

function summarizeRules(checked: ConfigAgentCheckResult, before: Record<string, unknown>, after: Record<string, unknown>, lines: string[]): void {
  const source = checked.changes.find((change) => change.field === "rules");
  const sourceDelta = source ? ruleChanges(source.before, source.after) : undefined;
  const effectiveDelta = ruleChanges(before.rules, after.rules);
  const sameImpact = sourceDelta && effectiveDelta
    && canonicalJson(sourceDelta.removed) === canonicalJson(effectiveDelta.removed)
    && canonicalJson(sourceDelta.added) === canonicalJson(effectiveDelta.added)
    && sourceDelta.orderChanged === effectiveDelta.orderChanged;
  const orderNote = (delta: NonNullable<typeof sourceDelta>): string =>
    delta.orderChanged ? "; first-match priority order changed — inspect Details" : "";
  if (sameImpact && sourceDelta && effectiveDelta) {
    lines.push(`Rules: source ${sourceDelta.before} → ${sourceDelta.after}; effective ${effectiveDelta.before} → ${effectiveDelta.after}; ${effectiveDelta.removed.length} removed, ${effectiveDelta.added.length} added${sourceDelta.after === 0 && sourceDelta.before > 0 ? " — ALL target-source rules removed" : ""}${orderNote(sourceDelta)}.`);
  } else {
    if (sourceDelta) lines.push(`Target-source rules: ${sourceDelta.before} → ${sourceDelta.after}; ${sourceDelta.removed.length} removed, ${sourceDelta.added.length} added${sourceDelta.after === 0 && sourceDelta.before > 0 ? " — ALL target-source rules removed" : ""}${orderNote(sourceDelta)}.`);
    if (effectiveDelta) lines.push(`Effective rules: ${effectiveDelta.before} → ${effectiveDelta.after}; ${effectiveDelta.removed.length} removed, ${effectiveDelta.added.length} added${effectiveDelta.after === 0 && effectiveDelta.before > 0 ? " — ALL effective rules removed" : ""}${orderNote(effectiveDelta)}.`);
    else if (sourceDelta) lines.push("Effective rules unchanged; source edit has no current routing effect.");
  }
}

function changedKeys(beforeValue: unknown, afterValue: unknown): string[] {
  const before = asRecord(beforeValue);
  const after = asRecord(afterValue);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key])).sort();
}

function mapDelta(beforeValue: unknown, afterValue: unknown, valueSummary: (value: unknown) => string): string | undefined {
  const before = asRecord(beforeValue);
  const after = asRecord(afterValue);
  const keys = changedKeys(before, after);
  if (keys.length === 0) return undefined;
  const examples = keys.slice(0, 3).map((key) => `${approvalValue(key)} ${valueSummary(before[key])} → ${valueSummary(after[key])}`);
  return `${keys.length} tier${keys.length === 1 ? "" : "s"} (${examples.join("; ")}${keys.length > 3 ? `; +${keys.length - 3} more` : ""})`;
}

function poolCount(value: unknown): string {
  return String(poolEntries(value as string | string[] | undefined).length);
}

function modelPools(value: unknown, schemaVersion: unknown): Record<string, unknown> {
  const models = asRecord(value);
  return schemaVersionAtLeast(schemaVersion, 3)
    ? Object.fromEntries(Object.entries(models).filter(([key]) => key !== "description"))
    : models;
}

function policyFallbacks(value: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(asRecord(value)).map(([tier, policy]) => [tier, asRecord(policy).fallbackTiers]));
}

function sameMapImpact(sourceBefore: unknown, sourceAfter: unknown, effectiveBefore: unknown, effectiveAfter: unknown): boolean {
  const sourceKeys = changedKeys(sourceBefore, sourceAfter);
  const effectiveKeys = changedKeys(effectiveBefore, effectiveAfter);
  return canonicalJson(sourceKeys) === canonicalJson(effectiveKeys) && sourceKeys.every((key) =>
    canonicalJson(asRecord(sourceBefore)[key]) === canonicalJson(asRecord(effectiveBefore)[key])
      && canonicalJson(asRecord(sourceAfter)[key]) === canonicalJson(asRecord(effectiveAfter)[key]),
  );
}

function summarizeMap(label: string, sourceBefore: unknown, sourceAfter: unknown, effectiveBefore: unknown, effectiveAfter: unknown, lines: string[], valueSummary: (value: unknown) => string): void {
  const source = mapDelta(sourceBefore, sourceAfter, valueSummary);
  const effective = mapDelta(effectiveBefore, effectiveAfter, valueSummary);
  if (source && effective && sameMapImpact(sourceBefore, sourceAfter, effectiveBefore, effectiveAfter)) {
    lines.push(`${label}: ${effective}.`);
  } else {
    if (source) lines.push(`Target-source ${label.toLowerCase()}: ${source}.`);
    if (effective) lines.push(`Effective ${label.toLowerCase()}: ${effective}.`);
    else if (source) lines.push(`Effective ${label.toLowerCase()} unchanged; source edit has no current routing effect.`);
  }
}

function classifierState(value: unknown): string {
  return asRecord(value).enabled === false ? "OFF" : "ON";
}

function summarizeClassifier(checked: ConfigAgentCheckResult, before: Record<string, unknown>, after: Record<string, unknown>, lines: string[]): void {
  const source = checked.changes.find((change) => change.field === "classifier");
  const effectiveBefore = before.classifier;
  const effectiveAfter = after.classifier;
  const effectiveChanged = canonicalJson(effectiveBefore) !== canonicalJson(effectiveAfter);
  if (!source && !effectiveChanged) return;
  const stateChange = `${classifierState(source?.before)} → ${classifierState(source?.after)}`;
  const sourceLabel = source?.kind === "remove" ? "removed from target source" : `settings changed (enabled ${stateChange})`;
  const effectiveStateChange = `${classifierState(effectiveBefore)} → ${classifierState(effectiveAfter)}`;
  if (source && effectiveChanged && stateChange === effectiveStateChange && stateChange !== "ON → ON") {
    lines.push(`Classifier policy: ${stateChange} in source and effective config.`);
  } else if (source && canonicalJson(source.before) === canonicalJson(effectiveBefore) && canonicalJson(source.after) === canonicalJson(effectiveAfter)) {
    lines.push(`Classifier settings (source + effective): ${sourceLabel}.`);
  } else {
    if (source) lines.push(`Target-source classifier: ${sourceLabel}.`);
    if (effectiveChanged) {
      const state = `${classifierState(effectiveBefore)} → ${classifierState(effectiveAfter)}`;
      lines.push(`Effective classifier policy: ${state}.`);
    } else if (source) lines.push(`Effective classifier policy remains ${classifierState(effectiveBefore)}; source edit has no current effect.`);
  }
}

function approvalSummary(checked: ConfigAgentCheckResult): string {
  const counts = { add: 0, replace: 0, remove: 0 };
  for (const change of checked.changes) counts[change.kind] += 1;
  const fields = checked.changes.map((change) => approvalValue(change.field));
  const removed = checked.changes.filter((change) => change.kind === "remove").map((change) => approvalValue(change.field));
  const lines = [
    "TOOL-GENERATED SUMMARY — impact only; not full values.",
    `Source: ${checked.source}.`,
    `Fields: ${counts.add} added, ${counts.replace} replaced, ${counts.remove} removed: ${fields.join(", ") || "none"}`,
  ];
  if (removed.length > 0) lines.push(`REMOVED source keys: ${approvalList(removed.slice(0, 5), 5)}${removed.length > 5 ? `; +${removed.length - 5} more` : ""}`);

  const before = asRecord(checked.effectiveBefore);
  const after = asRecord(checked.effectiveAfter);
  summarizeClassifier(checked, before, after, lines);
  const runtimeBefore = checked.routingBefore?.classifier;
  const runtimeAfter = checked.routingAfter?.classifier;
  const projectedAfter = runtimeAfter?.projected;
  const classifierChanged = checked.changes.some((change) => change.field === "classifier");
  const runtimeDiffersFromProjection = runtimeAfter && projectedAfter
    && (runtimeAfter.enabled !== projectedAfter.enabled || runtimeAfter.source !== projectedAfter.source || runtimeAfter.backend !== projectedAfter.backend);
  if (runtimeAfter && (runtimeAfter.loadedConfigMatches === false || runtimeAfter.runtimeStateIssue || runtimeAfter.legacyConflict || runtimeDiffersFromProjection)) {
    lines.push(`Current classifier runtime: ${runtimeAfter.enabled ? "enabled" : "disabled"} (${runtimeAfter.source}; backend=${runtimeAfter.backend ?? "unresolved"}); loaded config generation=${runtimeAfter.configGeneration ?? "unknown"}; configured=${runtimeAfter.configuredEnabled ? "on" : "off"}.`);
  }
  if (runtimeBefore?.loadedConfigMatches === false) lines.push("Current runtime uses loaded config that differs from effective disk layers; inspection and approval show both states.");
  if ((classifierChanged || runtimeAfter?.loadedConfigMatches === false) && projectedAfter) {
    lines.push(`Classifier runtime after apply and reload: ${projectedAfter.enabled ? "enabled" : "disabled"} (${projectedAfter.source}; backend=${projectedAfter.backend ?? "unresolved"}); configured=${projectedAfter.configuredEnabled ? "on" : "off"}${projectedAfter.runtimeStateIssue ? `; runtime state invalid=${projectedAfter.runtimeStateIssue}` : ""}.`);
  }
  if (runtimeAfter?.runtimeStateIssue) lines.push("Classification is paused by invalid runtime state. Repair .pi/bifrost-state.json: it must be a JSON object, and enabled and classifierEnabled must be booleans if present. Then run /bifrost reload.");
  summarizeRules(checked, before, after, lines);
  const models = checked.changes.find((change) => change.field === "models");
  summarizeMap("Model pools", modelPools(models?.before, before.schemaVersion), modelPools(models?.after, after.schemaVersion), modelPools(before.models, before.schemaVersion), modelPools(after.models, after.schemaVersion), lines, poolCount);
  const policies = checked.changes.find((change) => change.field === "tierPolicies");
  summarizeMap("Fallbacks", policyFallbacks(policies?.before), policyFallbacks(policies?.after), policyFallbacks(before.tierPolicies), policyFallbacks(after.tierPolicies), lines, approvalValue);
  // A dead provider sign-in is the one warning that makes an otherwise valid
  // config fail on its first routed turn, so the approval summary repeats it.
  for (const warning of checked.issues.filter((issue) => issue.severity === "warning")) {
    lines.push(`WARNING: ${approvalText(warning.message)}`);
  }
  lines.push("Details shows exact values. Summary approval skips them.");
  return lines.join("\n");
}

export async function applyConfigCandidate(input: ConfigAgentApplyInput): Promise<ConfigAgentApplyResult> {
  const { request, catalog, cwd, extensionDir, confirm, reload, liveCatalog } = input;
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
  /** Every gate that refuses an already-proposed change has the same shape:
   * nothing was written, and the agent must re-run check. */
  const stale = (reason: string, note: string): ConfigAgentApplyResult => ({
    ...withCheck,
    status: "stale",
    reason,
    notes: [note],
  });
  if (checked.status !== "ok" || checked.proposalDigest === null || checked.guards === null) {
    return {
      ...withCheck,
      status: checked.status === "usage" ? "usage" : "rejected",
      reason: checked.issues.find((issue) => issue.severity === "error")?.message ?? checked.notes[0] ?? "the candidate is not valid",
      notes: ["Nothing was written."],
    };
  }
  const requiredDigests = ["proposalDigest", "sourceDigest", "effectiveDigest", "catalogDigest"] as const;
  const missing: string[] = requiredDigests.filter((key) => request[key] === undefined);
  if (checked.guards.classifierRuntimeDigest !== null && request.classifierRuntimeDigest === undefined) {
    missing.push("classifierRuntimeDigest");
  }
  if (missing.length > 0) {
    return {
      ...withCheck,
      status: "usage",
      reason: `apply requires the digests from check or preview: ${missing.join(", ")} missing`,
      notes: ["Nothing was written. Run check, show the user the proposal, then apply the reviewed digests."],
    };
  }
  if (request.proposalDigest !== checked.proposalDigest) {
    return stale("the candidate bytes no longer match the checked proposal", "Nothing was written. Run check again and re-confirm the current proposal.");
  }
  const liveSource = readSelectedSource(cwd, extensionDir, checked.source);
  if (liveSource.readError) {
    return { ...withCheck, status: "rejected", reason: `the selected source ${liveSource.readError}`, notes: ["Nothing was written."] };
  }
  if (sourceDigestText(liveSource.digest) !== sourceDigestText(request.sourceDigest)) {
    return stale("the selected source changed after this proposal was generated", "Nothing was written. Run check again against the current source.");
  }
  const liveEffective = effectiveConfig(cwd, extensionDir);
  if (effectiveDigest(liveEffective.config) !== request.effectiveDigest) {
    return stale("another configuration source changed after this proposal was generated", "Nothing was written. Run check again against the current layers.");
  }
  if (catalogDigest(catalog) !== request.catalogDigest) {
    return stale("the model inventory changed after this proposal was generated", "Nothing was written. Run check and preview again against the current catalog.");
  }
  if (checked.guards.classifierRuntimeDigest !== null) {
    const runtimeDigest = classifierRuntimeDigest(
      input.classifierRuntime?.(liveEffective.config),
      input.classifierRuntime?.(checked.effectiveAfter as unknown as BifrostConfig),
    );
    if (runtimeDigest !== request.classifierRuntimeDigest) {
      return stale("classifier runtime digest does not match; the state may have changed or the digest may be incorrect", "Nothing was written. Run check again and use its proposal handle.");
    }
  }

  const message = approvalDetails(checked);
  if (message === null) {
    return { ...withCheck, status: "rejected", reason: "the full change is too large to show for approval", notes: ["Nothing was written. Make a smaller change or edit the config manually."] };
  }
  let approved: boolean;
  let approvalFailed = false;
  try {
    approved = await confirm("Apply this Bifrost configuration?", approvalSummary(checked), message);
  } catch {
    approved = false;
    approvalFailed = true;
  }
  if (!approved) {
    return {
      ...withCheck,
      status: approvalFailed ? "approval_failed" : "cancelled",
      reason: approvalFailed ? "approval dialog failed; nothing was written" : "approval was cancelled; nothing was written",
      notes: ["Nothing was written."],
    };
  }

  // ── Revalidate after confirmation ────────────────────────────────
  // The pre-approval checks above describe the state the user agreed to;
  // the authoritative gate re-reads every guarded input now. A file edit,
  // an unrelated layer change, or a catalog refresh while the dialog was
  // open must not be overwritten by the approved proposal.
  const confirmedSource = readSelectedSource(cwd, extensionDir, checked.source);
  if (confirmedSource.readError) {
    return stale(`the selected source ${confirmedSource.readError}`, "Nothing was written. Run check again against the current source.");
  }
  if (sourceDigestText(confirmedSource.digest) !== sourceDigestText(request.sourceDigest)) {
    return stale("the selected source changed while the change was awaiting approval", "Nothing was written. Run check again against the current source.");
  }
  const confirmedEffective = effectiveConfig(cwd, extensionDir);
  if (effectiveDigest(confirmedEffective.config) !== request.effectiveDigest) {
    return stale("another configuration source changed while the change was awaiting approval", "Nothing was written. Run check again against the current sources.");
  }
  const confirmedCatalog = liveCatalog ? liveCatalog() : catalog;
  if (catalogDigest(confirmedCatalog) !== request.catalogDigest) {
    return stale("the model inventory changed while the change was awaiting approval", "Nothing was written. Run check and preview again against the current catalog.");
  }
  if (checked.guards.classifierRuntimeDigest !== null) {
    const runtimeDigest = classifierRuntimeDigest(
      input.classifierRuntime?.(confirmedEffective.config),
      input.classifierRuntime?.(checked.effectiveAfter as unknown as BifrostConfig),
    );
    if (runtimeDigest !== request.classifierRuntimeDigest) {
      return stale("classifier runtime state changed while the change was awaiting approval", "Nothing was written. Run check again and review the current classifier mode.");
    }
  }
  // The digests above cover one source, the merged result, and the catalog. A
  // layer that a higher-precedence layer currently masks is invisible to the
  // merged digest, yet it becomes visible as soon as this change removes the
  // masking value. Recompose the approved candidate against the live layers and
  // require the result the user approved, so a masked edit cannot surface here.
  const recomposed = checkConfigCandidate(input);
  if (
    recomposed.status !== "ok"
    || recomposed.effectiveAfter === null
      || (checked.guards.classifierRuntimeDigest !== null
        && recomposed.guards?.classifierRuntimeDigest !== request.classifierRuntimeDigest)
    || effectiveDigest(recomposed.effectiveAfter as unknown as BifrostConfig)
      !== effectiveDigest(checked.effectiveAfter as unknown as BifrostConfig)
  ) {
    return stale("the configuration layers no longer compose to the result this proposal was approved with", "Nothing was written. Run check again against the current layers.");
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
  const runtimeAfterWrite = input.classifierRuntime?.(afterWrite.config);
  const issues = issuesOf(afterWrite.config, afterWrite.diagnostics, afterWrite.warnings, runtimeAfterWrite);
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
      routing: routingSummary(afterWrite.config, cwd, runtimeAfterWrite),
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
    routing: routingSummary(afterWrite.config, cwd, input.classifierRuntime?.(afterWrite.config)),
    notes,
  };
}

// ── inspect ────────────────────────────────────────────────────

export interface ConfigAgentInspectInput {
  readonly catalog: ConfigAgentCatalog;
  readonly cwd: string;
  readonly extensionDir: string;
  readonly classifierRuntime?: ConfigAgentClassifierRuntimeProvider;
  /** Sign-in state resolved by the adapter; absent means the host has no signal. */
  readonly providerAuth?: readonly ConfigAgentProviderAuth[];
  /** Optional display filter for one provider; it never changes validation or routing. */
  readonly provider?: string;
  /** Page start within the sorted, filtered inventory; it never changes validation or routing. */
  readonly offset?: number;
}

export function inspectConfigAgent(input: ConfigAgentInspectInput): ConfigAgentInspectResult {
  const { catalog, cwd, extensionDir } = input;
  const provider = input.provider?.trim();
  const loaded = effectiveConfig(cwd, extensionDir);
  const layers = inspectLayers(cwd, extensionDir);
  const routeFile = routeFileFor(cwd);
  const restrictions = [
    "Only the user, workspace, and project sources are writable. The bundled extension config is Bifrost's default and is never written.",
    `Bifrost validates against schema versions ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}; other values are rejected.`,
    "Unknown fields, invalid values, and wrong types load with a warning that names the path; they never change routing silently.",
    "A route file takes precedence over config `rules` when it exists.",
    "Economic settings are annotated/declared facts. They do not enforce a spend cap.",
    "Bifrost does not manage provider prompt caches and cannot promise cache reuse.",
  ];
  if (routeFile) restrictions.push(`route file present: ${routeFile} (config rules are ignored while it exists)`);
  if (catalog.metadataIncomplete.length > 0) {
    restrictions.push(`${catalog.metadataIncomplete.length} catalog model(s) report unusable cost or context metadata and cannot be routed: ${catalog.metadataIncomplete.slice(0, 8).join(", ")}`);
  }
  const filtered = provider ? catalog.available.filter((model) => model.provider === provider) : catalog.available;
  // Routing keeps Pi's registry order (see buildConfigAgentCatalog); inspect
  // sorts a copy only so the report reads in a stable, predictable order.
  const sorted = [...filtered].sort((left, right) => left.key.localeCompare(right.key));
  const offset = Math.max(input.offset ?? 0, 0);
  const inventory = sorted.slice(offset);
  const knownUnavailableCount = catalog.known.length - catalog.available.length;
  const providerAuth = input.providerAuth ?? [];
  const notes = [
    "No stored sign-in values, tokens, or account data are read or reported; only whether each provider's sign-in resolves.",
    "This inventory is a snapshot. Re-run inspect before relying on it after a registry refresh or a config edit.",
  ];
  for (const auth of providerAuth) {
    if (auth.state === "not_configured") notes.push(`Provider "${auth.provider}" has no configured sign-in, so its models cannot route.`);
    else if (auth.state === "invalid") notes.push(`Provider "${auth.provider}" sign-in cannot be resolved: ${auth.reason ?? "unknown error"}. Its models stay listed but fail when selected until the provider is signed in again; check reports this as a warning.`);
    else if (auth.state === "unknown") notes.push(`Pi did not expose sign-in state for provider "${auth.provider}"; availability is unverified.`);
  }
  if (provider) {
    notes.push(inventory.length > 0
      ? `The reported inventory is filtered to provider "${provider}" for display only.`
      : `No available model belongs to provider "${provider}"; the reported inventory is empty.`);
  }
  if (offset > 0) {
    notes.push(`Inventory continues from offset ${offset} of the sorted display list; models before it were listed by the previous page.`);
  }
  return {
    operation: "inspect",
    status: "ok",
    layers,
    effectiveConfig: loaded.config as unknown as Record<string, unknown>,
    issues: issuesOf(loaded.config, loaded.diagnostics, loaded.warnings, input.classifierRuntime?.(loaded.config)),
    diagnostics: loaded.diagnostics,
    routing: routingSummary(loaded.config, cwd, input.classifierRuntime?.(loaded.config)),
    providerAuth,
    restrictions,
    inventory,
    availableModelCount: catalog.available.length,
    ...(provider ? { inventoryProvider: provider } : {}),
    ...(offset > 0 ? { inventoryOffset: offset } : {}),
    knownUnavailableCount,
    notes,
  };
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
  /** Resolve the currently effective session/config classifier state without network access. */
  readonly classifierRuntime?: (config: BifrostConfig, ctx: ExtensionToolContext) => ConfigAgentClassifierRuntime;
  /**
   * Send one tiny request to each named model and report what came back.
   * Injected by the host so core policy never owns provider transport, and
   * only called when the caller opts in with `probe: true`.
   */
  readonly probeModels?: (
    models: readonly string[],
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => Promise<readonly ConfigAgentProbeResult[]>;
  /** Render a result for the model. Injected by the host entry so this module
   * owns policy and IO only and the presentation module stays a leaf. */
  readonly render: (result: ConfigAgentToolResult) => string;
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

const CONFIG_CANDIDATE_SCHEMA = Type.Record(Type.String(), Type.Unknown(), {
  description: "Complete replacement content for the selected config source. Only fields supported by schema.json are written.",
});
const CONFIG_PATCH_SCHEMA = Type.Record(Type.String(), Type.Unknown(), {
  description: "Shallow merge into selected source. Each supplied top-level value replaces that whole field; nested objects are not deep-merged.",
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
  candidate: Type.Optional(CONFIG_CANDIDATE_SCHEMA),
  patch: Type.Optional(CONFIG_PATCH_SCHEMA),
  remove: Type.Optional(Type.Array(Type.String(), { description: "Top-level keys to delete. Requires patch." })),
  prompts: Type.Optional(Type.Array(Type.String(), { description: "Representative prompts to evaluate in preview. Offline: nothing is sent anywhere." })),
  provider: Type.Optional(Type.String({ description: "Restrict the inventory reported by inspect to one provider. Display only." })),
  offset: Type.Optional(Type.Number({ minimum: 0, description: "Page start for the inspect inventory (sorted display order); repeat inspect with the suggested offset to list more models. Display only." })),
  proposalHandle: Type.Optional(Type.String({ description: "Session-local handle returned by check. Apply with this handle alone; the tool retains the candidate and stale guards." })),
  proposalDigest: Type.Optional(Type.String({ description: "proposalDigest returned by check or preview for this exact candidate." })),
  sourceDigest: Type.Optional(Type.String({ description: "sourceDigest returned by check or preview for this exact candidate. When the source file does not exist yet, check reports the literal \"absent\"; pass that string back unchanged." })),
  effectiveDigest: Type.Optional(Type.String({ description: "effectiveDigest returned by check or preview for this exact candidate." })),
  catalogDigest: Type.Optional(Type.String({ description: "catalogDigest returned by check or preview for this exact candidate." })),
  classifierRuntimeDigest: Type.Optional(Type.String({ description: "classifierRuntimeDigest returned by check or preview; apply refuses if runtime classifier state changes." })),
  probe: Type.Optional(Type.Boolean({ description: "Live-check the models this check would route to by sending one tiny prompt to each. Costs a small request per model, so ask the user before enabling it and never enable it on your own. Advisory: probe failures warn and the candidate stays writable." })),
});

/**
 * Provider ids a request's pools name explicitly. Pi removes a provider's
 * models from `getAvailable()` once its credential stops resolving, so the
 * inventory alone cannot tell Bifrost that the candidate points at a provider
 * whose stored sign-in is dead.
 */
/**
 * Providers a set of tier pools names, whether by `provider/model` prefix or by
 * a bare entry matched against the known catalog. A bare entry names no
 * provider, and Pi hides the models of a provider whose sign-in is dead.
 */
function poolProviders(pools: Iterable<string>, catalog: ConfigAgentCatalog): Set<string> {
  const providers = new Set<string>();
  for (const entry of pools) {
    const slash = entry.indexOf("/");
    if (slash > 0) providers.add(entry.slice(0, slash));
    else for (const key of knownPoolMatches(catalog, entry)) providers.add(key.slice(0, key.indexOf("/")));
  }
  return providers;
}

/** Tier entries a request names, before it is merged with the loaded config. */
function requestEntries(request: ConfigAgentRequest): string[] {
  const entries: string[] = [];
  for (const pools of [request.candidate?.models, request.patch?.models]) {
    if (!pools || typeof pools !== "object" || Array.isArray(pools)) continue;
    for (const value of Object.values(pools as Record<string, unknown>)) {
      entries.push(...poolEntries(value as string | string[] | undefined));
    }
  }
  return entries;
}

/**
 * Providers the stored configuration routes to. A patch can leave a tier in
 * place, so checking only what the request mentions would miss a dead sign-in
 * the applied config still depends on.
 */
function configProviders(config: BifrostConfig, catalog: ConfigAgentCatalog): Set<string> {
  const entries: string[] = [];
  for (const pool of Object.values(config.models ?? {})) entries.push(...poolEntries(pool));
  return poolProviders(entries, catalog);
}

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
  readonly classifierRuntimeDigest?: string;
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
    ...(params.classifierRuntimeDigest !== undefined ? { classifierRuntimeDigest: params.classifierRuntimeDigest } : {}),
  };
}

/**
 * The one agent-facing Bifrost configuration tool. Operations share the same
 * layer loading, validation, resolution, and write path as the commands.
 */
export function createBifrostConfigTool(deps: ConfigAgentToolDeps): ToolDefinition<typeof ConfigAgentParameters, ConfigAgentToolResult, unknown> {
  const cwdOf = deps.cwd ?? (() => process.cwd());
  const nowOf = deps.now ?? (() => Date.now());
  const proposals = new WeakMap<object, { sessionId: string; handle: string; request: ConfigAgentRequest }>();
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const operation = params.operation as ConfigAgentOperation;
      let request = readRequest(params);
      const sessionManager = ctx.sessionManager;
      const sessionId = typeof sessionManager?.getSessionId === "function" ? sessionManager.getSessionId() : undefined;
      const saved = sessionId === undefined ? undefined : proposals.get(sessionManager);
      const handleOnly = Object.keys(params).every((key) => key === "operation" || key === "proposalHandle");
      if (operation === "apply" && params.proposalHandle && saved && saved.sessionId === sessionId && saved.handle === params.proposalHandle && handleOnly) {
        request = saved.request;
      }
      const cwd = cwdOf();
      const catalog = catalogFromContext(ctx);
      // Resolve sign-in for every provider the inventory offers, plus every
      // provider the request or the stored configuration routes to, so a dead
      // credential Pi already hid from the inventory is still reported. Pi's
      // status only proves a credential is stored, so a dead OAuth refresh
      // stays invisible until something resolves it; this is that resolution,
      // done once per call and reported as advisory state rather than an error.
      // A candidate replaces one source, not the other layers, and a patch
      // leaves every tier it does not name in place, so the stored config's
      // providers are always in scope. Over-collecting a provider that no
      // surviving tier references costs nothing: the warning is issued per tier
      // of the composed config, and only inspect lists raw sign-in state.
      const resolvedProviders = new Set([
        ...catalog.available.map((model) => model.provider),
        ...poolProviders(requestEntries(request), catalog),
      ]);
      try {
        for (const provider of configProviders(effectiveConfig(cwd, deps.extensionDir).config, catalog)) {
          resolvedProviders.add(provider);
        }
      } catch {
        // The stored config is reported by the operation itself; a probe that
        // cannot read it must not turn into a failed call.
      }
      const providerAuth = await resolveProviderAuth(ctx.modelRegistry, [...resolvedProviders]);
      const classifierRuntime = deps.classifierRuntime
        ? (config: BifrostConfig) => deps.classifierRuntime!(config, ctx)
        : undefined;
      const input: ConfigAgentCheckInput = {
        request, catalog, cwd, extensionDir: deps.extensionDir, providerAuth,
        ...(classifierRuntime ? { classifierRuntime } : {}),
      };
      let result: ConfigAgentToolResult;
      switch (operation) {
        case "inspect":
          result = inspectConfigAgent({
            catalog,
            cwd,
            extensionDir: deps.extensionDir,
            providerAuth,
            ...(params.provider !== undefined ? { provider: params.provider } : {}),
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
            ...(classifierRuntime ? { classifierRuntime } : {}),
          });
          break;
        case "check":
          result = checkConfigCandidate(input);
          if (params.probe === true) result = await applyLiveProbe(result, catalog, deps, ctx, signal);
          break;
        case "preview":
          result = await previewConfigCandidate({ ...input, now: nowOf() });
          break;
        case "apply": {
          if (params.proposalHandle && (!saved || saved.sessionId !== sessionId || saved.handle !== params.proposalHandle || !handleOnly)) {
            result = {
              operation: "apply", status: "usage", source: null, sourcePath: "", applied: false, reloaded: false,
              verified: false, changes: [], effectiveConfig: null, routing: null,
              reason: "unknown proposal handle or extra candidate fields", notes: ["Nothing was written. Run check again, then apply using only its proposalHandle."],
            };
            break;
          }
          if (!ctx.hasUI || ctx.mode !== "tui") {
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
              reason: "configuration approval requires Pi TUI; RPC clients cannot prove complete proposal visibility",
              notes: ["Nothing was written. Show the user the proposal and ask them to apply it in an interactive Pi session."],
            };
            break;
          }
          result = await applyConfigCandidate({
            ...input,
            confirm: (title, summary, details) => approveConfig(ctx, title, summary, details, signal),
            reload: () => deps.reload(ctx),
            liveCatalog: () => catalogFromContext(ctx),
            ...(deps.write ? { write: deps.write } : {}),
          });
          break;
        }
        default:
          result = emptyCheckResult(
            "usage",
            `unknown operation ${String(operation)}; use inspect, check, preview, or apply`,
            "project",
            "",
          );
      }
      if (result.operation === "apply" && result.applied && ctx.mode === "tui") {
        result = {
          ...result,
          notes: [...result.notes, "Pi does not expose an extension API to open saved files in its editor; open the saved path manually if needed."],
        };
      }
      let handleNote = "";
      if (sessionId !== undefined && result.operation === "check" && result.status === "ok" && result.writeEligible && result.proposalDigest && result.guards) {
        const handle = randomBytes(6).toString("hex");
        proposals.set(sessionManager, {
          sessionId, handle,
          request: structuredClone({
            ...request,
            proposalDigest: result.proposalDigest,
            sourceDigest: result.guards.sourceDigest ?? "absent",
            effectiveDigest: result.guards.effectiveDigest,
            catalogDigest: result.guards.catalogDigest,
            ...(result.guards.classifierRuntimeDigest === null ? {} : { classifierRuntimeDigest: result.guards.classifierRuntimeDigest }),
          }),
        });
        handleNote = `\nSession-local proposalHandle: ${handle}. To apply, pass only operation=apply and proposalHandle; do not copy digests.`;
      }
      return {
        content: [{ type: "text", text: deps.render(result) + handleNote }],
        details: result,
        isError: result.status !== "ok",
      };
    },
  };
}
