import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { BifrostConfig } from "./config.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_API_KEY_ENV, TYPE_SAFE_CREDENTIAL_KEY, type ClassifierBackend } from "./classifier-backends.ts";

/**
 * Backend detection (ADR 0020, Decision 5). One pure mapping over one facts
 * object fills an absent classifier.backend: pi-native when the TypeSafe
 * credential is Pi-managed, typesafe when a raw env key is present, prompt
 * otherwise. An explicit classifier.backend always wins.
 */

export interface DetectionFacts {
  readonly piManaged: boolean;
  readonly envPresent: boolean;
}

export interface DetectionDeps {
  readonly readStoredCredential: (providerId: string) => unknown | undefined;
  /** Registry auth view. Absent outside a request context. */
  readonly getProviderAuthStatus?: (providerId: string) => { configured: boolean; source?: string };
  readonly env: Record<string, string | undefined>;
}

/** Sources Pi resolves itself: stored auth, a runtime flag, or models.json entries (fixes 7 and 8). */
const PI_MANAGED_SOURCES = new Set(["stored", "runtime", "models_json_key", "models_json_command", "fallback"]);

/** Pi registry knows runtime and models.json keys that the direct transport cannot read. */
export function piNativeCredentialMissing(
  getProviderAuthStatus: (providerId: string) => { configured: boolean },
  directKeyPresent: boolean,
): boolean {
  return !getProviderAuthStatus(TYPE_SAFE_CREDENTIAL_KEY).configured && !directKeyPresent;
}

export function collectDetectionFacts(deps: DetectionDeps): DetectionFacts {
  const status = deps.getProviderAuthStatus?.(TYPE_SAFE_CREDENTIAL_KEY) ?? { configured: false };
  const envPresent = Boolean(deps.env[TYPE_SAFE_API_KEY_ENV]);
  // Fix 6: never trust the registry snapshot alone; readStoredCredential is a
  // direct auth.json read. A source of "environment" without our env var is a
  // models.json interpolation only Pi resolves (fix 7), so it counts managed.
  const piManaged = deps.readStoredCredential(TYPE_SAFE_CREDENTIAL_KEY) !== undefined
    || (status.source !== undefined && PI_MANAGED_SOURCES.has(status.source))
    || (status.source === "environment" && !envPresent);
  return { piManaged, envPresent };
}

export interface DetectionResult {
  readonly backend: ClassifierBackend;
  readonly reason: string;
}

export function resolveDefaultClassifierBackend(facts: DetectionFacts): DetectionResult {
  if (facts.piManaged) return { backend: CLASSIFIER_BACKEND_IDS.piNative, reason: "Pi-managed TypeSafe credential" };
  if (facts.envPresent) return { backend: CLASSIFIER_BACKEND_IDS.typesafe, reason: "env key detected" };
  return { backend: CLASSIFIER_BACKEND_IDS.prompt, reason: "no credential detected" };
}

export interface EffectiveBackend extends DetectionResult {
  /** True when detection filled an absent classifier.backend. */
  readonly auto: boolean;
}

export function selectEffectiveBackend(configured: ClassifierBackend | undefined, detected: DetectionResult): EffectiveBackend {
  return configured
    ? { backend: configured, reason: "explicit config", auto: false }
    : { backend: detected.backend, reason: detected.reason, auto: true };
}

export interface DetectionEngine {
  /** Sticky read: the first call locks the per-load value (Decision 5). */
  detect(collect: () => DetectionFacts): DetectionResult;
  /** Non-locking read: returns the locked value when present. */
  peek(collect: () => DetectionFacts): DetectionResult;
}

/** One first-use notice per session, even when one extension instance serves several sessions. */
export function createDetectionNoticeGate(): (session: object) => boolean {
  const shown = new WeakSet<object>();
  return (session) => {
    if (shown.has(session)) return false;
    shown.add(session);
    return true;
  };
}

/** Sticky per extension load: /bifrost reload must not flip the backend mid-session (Decision 5). */
export function createDetectionEngine(): DetectionEngine {
  let cached: DetectionResult | undefined;
  return {
    detect(collect: () => DetectionFacts): DetectionResult {
      if (!cached) cached = resolveDefaultClassifierBackend(collect());
      return cached;
    },
    peek(collect: () => DetectionFacts): DetectionResult {
      return cached ?? resolveDefaultClassifierBackend(collect());
    },
  };
}

/** Facts readable without a request context (auth.json + environment). */
export function collectContextFreeFacts(): DetectionFacts {
  return collectDetectionFacts({ readStoredCredential, env: process.env });
}

/** Effective backend from context-free facts. Never locks the per-load value. */
export function effectiveBackendOf(config: BifrostConfig, engine: DetectionEngine): EffectiveBackend {
  return selectEffectiveBackend(config.classifier?.backend, engine.peek(collectContextFreeFacts));
}
