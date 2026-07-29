import { resolveStoragePath, readJsonFile, writeJsonFile } from "./storage.ts";

/**
 * Runtime mode state that must survive extension reload and Pi restart.
 * Persisted separately from bifrost.json (config) so user runtime toggles
 * (`/bifrost on|off`, `/bifrost pin|unpin`, `/bifrost classifier on|off`)
 * are not clobbered by config reloads.
 */
export interface RuntimeModeState {
  enabled: boolean;
  pinned: boolean;
  classifierEnabled: boolean;
}

export const DEFAULT_RUNTIME_STATE: RuntimeModeState = {
  enabled: true,
  pinned: false,
  classifierEnabled: true,
};

export function runtimeStatePath(cwd: string): string {
  return resolveStoragePath(cwd, undefined, ".pi/bifrost-state.json");
}

export function loadRuntimeState(path: string, fallback: RuntimeModeState = DEFAULT_RUNTIME_STATE): RuntimeModeState {
  try {
    const parsed = readJsonFile<Partial<RuntimeModeState>>(path);
    if (!parsed) return { ...fallback };
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : fallback.enabled,
      pinned: typeof parsed.pinned === "boolean" ? parsed.pinned : fallback.pinned,
      classifierEnabled:
        typeof parsed.classifierEnabled === "boolean"
          ? parsed.classifierEnabled
          : fallback.classifierEnabled,
    };
  } catch (err) {
    console.error(`[bifrost] failed to load runtime state: ${err}`);
    return { ...fallback };
  }
}

export function saveRuntimeState(path: string, state: RuntimeModeState): void {
  try {
    writeJsonFile(path, state);
  } catch (err) {
    console.error(`[bifrost] failed to save runtime state: ${err}`);
  }
}
