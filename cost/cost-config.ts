// ── Cost tracking configuration ──────────────────────────
// Configure: { "cost": { "persist": true, "path": ".bifrost/cache-costs" } }
//
// persist: write per-session cost/cache metrics to disk so they
// survive restarts and can be analyzed later. Default false.
// widget: show the live TUI cost widget. Default false.

export interface CostConfig {
  /** Persist per-session metrics to disk. Default false. */
  persist?: boolean;
  /** Show the live cost widget in Pi's TUI. Default false. */
  widget?: boolean;
  /** Directory (relative to cwd or absolute) for persisted data. Default ".bifrost/cache-costs". */
  path?: string;
  /** Max turns kept in memory and persisted. Default 100. */
  maxHistory?: number;
  /** Delete persisted session files older than this many days. Disabled when omitted. */
  retentionDays?: number;
  /** Checkpoint metrics to disk every N turns. Default 25. */
  checkpointTurns?: number;
  /** Minimum interval between automatic checkpoints in milliseconds. Default 60000. */
  checkpointIntervalMs?: number;
}

let costConfig: CostConfig = {};

export function setupCost(cfg: CostConfig): void {
  costConfig = { ...cfg };
}

export function isCostPersistenceEnabled(): boolean {
  return costConfig.persist === true;
}

export function isCostWidgetEnabled(): boolean {
  return costConfig.widget === true;
}

export function isCostCollectionEnabled(): boolean {
  return isCostWidgetEnabled() || isCostPersistenceEnabled();
}

export function getCostConfig(): CostConfig {
  return costConfig;
}
