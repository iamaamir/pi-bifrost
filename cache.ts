import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CacheEntry {
  normalized: string;
  category: string;
  lastUsed: number;
  hits: number;
  /** Monotonic sequence number for stable eviction ordering. */
  seq?: number;
}

export interface CacheOptions {
  enabled?: boolean;
  maxEntries?: number;
  threshold?: number;
  path?: string;
}

export const DEFAULT_MAX_ENTRIES = 500;
export const DEFAULT_THRESHOLD = 0.85;

let nextSeq = 0;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");
}

function tokenSet(text: string): Set<string> {
  return new Set(normalize(text).split(" "));
}

export function loadCache(path: string): CacheEntry[] {
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf-8");
    const entries = text
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        try {
          return JSON.parse(line) as CacheEntry;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is CacheEntry => e !== undefined);

    // Seed seq counter from loaded entries to avoid collision on restart.
    const maxSeq = entries.reduce((max: number, e: CacheEntry) => Math.max(max, e.seq ?? 0), 0);
    if (maxSeq >= nextSeq) nextSeq = maxSeq + 1;

    return entries;
  } catch (err) {
    console.error(`[bifrost] failed to load cache: ${err}`);
    return [];
  }
}

export function saveCache(path: string, entries: CacheEntry[]) {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const lines = entries.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(path, lines ? lines + "\n" : "", "utf-8");
  } catch (err) {
    console.error(`[bifrost] failed to save cache: ${err}`);
  }
}

function evictIfNeeded(entries: CacheEntry[], maxEntries: number): CacheEntry[] {
  if (entries.length <= maxEntries) return entries;
  // Sort by lastUsed descending; tie-break by seq (newer entries have higher seq).
  return [...entries]
    .sort((a, b) => b.lastUsed - a.lastUsed || (b.seq ?? 0) - (a.seq ?? 0))
    .slice(0, maxEntries);
}

/** Pure query — finds matching cache entry without mutation. */
export function lookupCache(
  entries: CacheEntry[],
  prompt: string,
  threshold: number,
): CacheEntry | undefined {
  const normalized = normalize(prompt);
  const promptTokens = tokenSet(normalized);
  let best: { entry: CacheEntry; score: number } | undefined;

  for (const entry of entries) {
    if (entry.normalized === normalized) return entry;

    const entryTokens = tokenSet(entry.normalized);
    if (promptTokens.size === 0 || entryTokens.size === 0) continue;

    let intersection = 0;
    for (const token of promptTokens) {
      if (entryTokens.has(token)) intersection++;
    }
    const union = promptTokens.size + entryTokens.size - intersection;
    const score = union === 0 ? 0 : intersection / union;
    if (score >= threshold && (!best || score > best.score)) {
      best = { entry, score };
    }
  }

  return best?.entry;
}

/** Explicit mutation — updates LRU timestamp and hit count. */
export function touchCacheEntry(entry: CacheEntry): void {
  entry.lastUsed = Date.now();
  entry.hits++;
}

/** Convenience: pure lookup composed with LRU touch.
 * @deprecated Prefer explicit `lookupCache` + `touchCacheEntry` at call sites. */
export function findCachedCategory(
  entries: CacheEntry[],
  prompt: string,
  threshold: number,
): string | undefined {
  const entry = lookupCache(entries, prompt, threshold);
  if (entry) {
    touchCacheEntry(entry);
    return entry.category;
  }
  return undefined;
}

export function updateCache(
  entries: CacheEntry[],
  prompt: string,
  category: string,
  maxEntries: number,
): CacheEntry[] {
  const normalized = normalize(prompt);
  const idx = entries.findIndex((e) => e.normalized === normalized);

  if (idx !== -1) {
    const updated = [...entries];
    updated[idx] = {
      ...updated[idx],
      category,
      lastUsed: Date.now(),
      hits: updated[idx].hits + 1,
    };
    return evictIfNeeded(updated, maxEntries);
  }

  return evictIfNeeded(
    [...entries, { normalized, category, lastUsed: Date.now(), hits: 1, seq: nextSeq++ }],
    maxEntries,
  );
}

export function cachePath(cwd: string, configuredPath?: string): string {
  if (configuredPath) {
    if (configuredPath.startsWith("/")) return configuredPath;
    if (configuredPath.startsWith("~")) {
      return (process.env.HOME ?? "/tmp") + configuredPath.slice(1);
    }
    return join(cwd, configuredPath);
  }
  return join(cwd, ".pi", "bifrost-cache.jsonl");
}
