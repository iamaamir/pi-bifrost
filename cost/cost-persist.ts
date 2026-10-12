import { readFileSync, existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { writeTextFileAsync } from "../storage.ts";
import { join, isAbsolute } from "node:path";
import type { CostMetrics, CostTurn } from "./cost-types.ts";

export interface PersistedCostData {
  version: number;
  sessionId: string;
  timestamp: number;
  metrics: CostMetrics;
  history: CostTurn[];
}

const DEFAULT_COST_DIR = ".bifrost/cache-costs";
const VERSION = 1;

function getCostDir(cwd: string, configuredPath?: string): string {
  if (!configuredPath) return join(cwd, DEFAULT_COST_DIR);
  return isAbsolute(configuredPath) ? configuredPath : join(cwd, configuredPath);
}

export async function saveCostData(
  cwd: string,
  configuredPath: string | undefined,
  sessionId: string,
  metrics: CostMetrics,
  history: CostTurn[],
  retentionDays?: number,
): Promise<void> {
  try {
    const dir = getCostDir(cwd, configuredPath);
    const data: PersistedCostData = {
      version: VERSION,
      sessionId,
      timestamp: Date.now(),
      metrics,
      history,
    };
    const path = join(dir, `${sessionId}.json`);
    await mkdir(dir, { recursive: true });
    await writeTextFileAsync(path, JSON.stringify(data, null, 2));
    await pruneCostHistory(dir, sessionId, retentionDays);
  } catch {
    // Persistence must never impact routing or the main process.
  }
}

async function pruneCostHistory(dir: string, currentSessionId: string, retentionDays?: number): Promise<void> {
  if (!retentionDays || retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = await readdir(dir);
  await Promise.all(files
    .filter((file) => file.endsWith(".json") && file !== `${currentSessionId}.json`)
    .map(async (file) => {
      const path = join(dir, file);
      const info = await stat(path).catch(() => undefined);
      if (info && info.mtimeMs < cutoff) await unlink(path).catch(() => {});
    }));
}

export function loadCostData(cwd: string, configuredPath: string | undefined, sessionId: string): PersistedCostData | undefined {
  try {
    const path = join(getCostDir(cwd, configuredPath), `${sessionId}.json`);
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as PersistedCostData;
  } catch {
    return undefined;
  }
}

export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
