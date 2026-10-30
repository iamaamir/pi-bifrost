import type { ModelSelectSource } from "@earendil-works/pi-coding-agent";
import { resolveStoragePath, readJsonFile, writeJsonFile } from "./storage.ts";

/**
 * Global Bifrost mode survives reload and restart. Classifier enablement now
 * comes from config or an explicit session override; classifierEnabled in old
 * runtime files is read only to detect and explain a privacy-sensitive conflict.
 */
export type ClassifierEnablementSource = "configuration" | "session" | "legacy-conflict";

export interface ClassifierEnablement {
  readonly enabled: boolean;
  readonly source: ClassifierEnablementSource;
  readonly legacyConflict?: { readonly saved: boolean; readonly configured: boolean };
}

export interface RuntimeModeState {
  enabled: boolean;
  pinned: boolean;
  classifierEnabled: boolean;
  classifierSource: ClassifierEnablementSource;
  legacyClassifierEnabled?: boolean;
  classifierConflict?: { readonly saved: boolean; readonly configured: boolean };
}

/** Only Bifrost's global on/off mode remains durable. */
export interface PersistedModeState {
  /** Omit to remove the runtime override and return to the config default. */
  enabled?: boolean;
}

export const DEFAULT_RUNTIME_STATE: RuntimeModeState = {
  enabled: true,
  pinned: false,
  classifierEnabled: true,
  classifierSource: "configuration",
};

/** Explicit session choice wins; an ambiguous legacy conflict pauses classification. */
export function resolveClassifierEnablement(
  configured: boolean,
  legacySaved?: boolean,
  sessionOverride?: boolean,
): ClassifierEnablement {
  const legacyConflict = legacySaved !== undefined && legacySaved !== configured
    ? { saved: legacySaved, configured }
    : undefined;
  if (sessionOverride !== undefined) {
    return { enabled: sessionOverride, source: "session", ...(legacyConflict ? { legacyConflict } : {}) };
  }
  if (legacyConflict) return { enabled: false, source: "legacy-conflict", legacyConflict };
  return { enabled: configured, source: "configuration" };
}

/** Session restore replays a recorded selection — it is not a user action. */
export function isPassiveModelSelection(source: ModelSelectSource): boolean {
  return source === "restore";
}

/**
 * Programmatic activation keys ("we set this model ourselves"), scoped per
 * session. A global slot let concurrent sessions swallow each other's
 * model_select events, which spuriously pinned the loser (issue #17 P1).
 */
export function createSelfSelectTracker() {
  const keys = new WeakMap<object, string>();
  return {
    claim(session: object, modelKey: string): void {
      keys.set(session, modelKey);
    },
    /** True when the event is this session's own programmatic activation. */
    consume(session: object, source: ModelSelectSource, modelKey: string): boolean {
      const key = keys.get(session);
      if (key && source === "set" && modelKey === key) {
        keys.delete(session);
        return true;
      }
      return false;
    },
    release(session: object): void {
      keys.delete(session);
    },
  };
}

export function runtimeStatePath(cwd: string): string {
  return resolveStoragePath(cwd, undefined, ".pi/bifrost-state.json");
}

export function loadRuntimeState(path: string, fallback: RuntimeModeState = DEFAULT_RUNTIME_STATE): RuntimeModeState {
  try {
    const parsed = readJsonFile<Record<string, unknown>>(path);
    if (!parsed) return { ...fallback };
    const legacyClassifierEnabled = typeof parsed.classifierEnabled === "boolean"
      ? parsed.classifierEnabled : undefined;
    const classifier = resolveClassifierEnablement(fallback.classifierEnabled, legacyClassifierEnabled);
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : fallback.enabled,
      pinned: false, // pinned is ephemeral — session-local, never inherit from file
      classifierEnabled: classifier.enabled,
      classifierSource: classifier.source,
      ...(legacyClassifierEnabled !== undefined ? { legacyClassifierEnabled } : {}),
      ...(classifier.legacyConflict ? { classifierConflict: classifier.legacyConflict } : {}),
    };
  } catch (err) {
    console.error(`[bifrost] failed to load runtime state: ${err}`);
    return { ...fallback };
  }
}

export function saveRuntimeState(path: string, state: PersistedModeState): boolean {
  try {
    const current = readJsonFile<unknown>(path);
    if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) {
      throw new Error("runtime state must be an object");
    }
    const existing = current as Record<string, unknown> | undefined;
    const next = state.enabled === undefined
      ? Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => key !== "enabled"))
      : { ...existing, enabled: state.enabled };
    if (current === undefined && Object.keys(next).length === 0) return true;
    // Preserve legacy classifier state and unknown fields. Atomic replacement is not cross-process CAS.
    writeJsonFile(path, next);
    return true;
  } catch (err) {
    console.error(`[bifrost] failed to save runtime state: ${err}`);
    return false;
  }
}
