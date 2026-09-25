import { resolveStoragePath, readTextFile, writeTextFile } from "./storage.ts";
import { CONFIG_DIR_NAME } from "./host.ts";

export interface CacheEntry {
  normalized: string;
  category: string;
  lastUsed: number;
  hits: number;
  /** Classifier semantics fingerprint. Legacy entries omit this and are ignored for keyed lookups. */
  semanticKey?: string;
  /** Monotonic sequence number for stable eviction ordering. */
  seq?: number;
}

export interface CacheOptions {
  enabled?: boolean;
  maxEntries?: number;
  threshold?: number;
  /** Retain entries for this many hours. Default 720 (30 days). */
  ttlHours?: number;
  path?: string;
}

export const DEFAULT_TTL_HOURS = 24 * 30;
export const DEFAULT_CACHE_TTL_MS = DEFAULT_TTL_HOURS * 60 * 60 * 1000;

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

/** Memoized token set per entry object — entries are immutable in their
 * normalized field (touch/update replace objects), so a WeakMap is safe
 * and dies with the entry. Avoids split+Set per entry per lookup. */
const entryTokenCache = new WeakMap<CacheEntry, Set<string>>();

function entryTokenSet(entry: CacheEntry): Set<string> {
  let tokens = entryTokenCache.get(entry);
  if (!tokens) {
    tokens = new Set(entry.normalized.split(" "));
    entryTokenCache.set(entry, tokens);
  }
  return tokens;
}

/** Token -> entry-index posting lists for one entries array.
 * Cached per array identity; updateCache/loadCache produce fresh arrays,
 * so staleness is impossible. */
interface LookupIndex {
  byToken: Map<string, number[]>;
  /** normalized string -> earliest entry index holding it. */
  byNormalized: Map<string, number>;
}

const indexCache = new WeakMap<CacheEntry[], LookupIndex>();

function lookupIndex(entries: CacheEntry[]): LookupIndex {
  let index = indexCache.get(entries);
  if (!index) {
    const byToken = new Map<string, number[]>();
    const byNormalized = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const normalized = entries[i]!.normalized;
      if (!byNormalized.has(normalized)) byNormalized.set(normalized, i);
      for (const token of entryTokenSet(entries[i]!)) {
        const list = byToken.get(token);
        if (list) list.push(i);
        else byToken.set(token, [i]);
      }
    }
    index = { byToken, byNormalized };
    indexCache.set(entries, index);
  }
  return index;
}

export function loadCache(path: string, maxAgeMs = Number.POSITIVE_INFINITY): CacheEntry[] {
  try {
    const text = readTextFile(path);
    if (text === undefined) return [];
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

    const cutoff = Date.now() - maxAgeMs;
    const freshEntries = entries.filter((entry) => Number.isFinite(entry.lastUsed) && entry.lastUsed >= cutoff);

    // Seed seq counter from loaded entries to avoid collision on restart.
    const maxSeq = freshEntries.reduce((max: number, e: CacheEntry) => Math.max(max, e.seq ?? 0), 0);
    if (maxSeq >= nextSeq) nextSeq = maxSeq + 1;

    return freshEntries;
  } catch (err) {
    console.error(`[bifrost] failed to load cache: ${err}`);
    return [];
  }
}

export function saveCache(path: string, entries: CacheEntry[]): boolean {
  try {
    const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
    writeTextFile(path, lines ? lines + "\n" : "");
    return true;
  } catch (err) {
    console.error(`[bifrost] failed to save cache: ${err}`);
    return false;
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
  semanticKey?: string,
  maxAgeMs = Number.POSITIVE_INFINITY,
): CacheEntry | undefined {
  const normalized = normalize(prompt);
  const cutoff = Date.now() - maxAgeMs;
  const usable = (entry: CacheEntry): boolean => entry.lastUsed >= cutoff && (semanticKey === undefined || entry.semanticKey === semanticKey);

  // Fast path: build the index (also serves exact lookup), then check the
  // normalized->index map — O(1) instead of a full string-compare scan.
  const { byNormalized } = lookupIndex(entries);
  const exactIdx = byNormalized.get(normalized);
  if (exactIdx !== undefined && usable(entries[exactIdx]!)) return entries[exactIdx]!;
  if (semanticKey !== undefined) {
    const exact = entries.find((entry) => entry.normalized === normalized && usable(entry));
    if (exact) return exact;
  }

  const promptTokens = tokenSet(normalized);
  const promptSize = promptTokens.size;
  if (promptSize === 0 || entries.length === 0) return undefined;

  // Accumulate intersections via posting lists: touch only entries that
  // share at least one token with the prompt. Jaccard >= threshold requires
  // min/max sizes >= threshold; skip the rest without scoring.
  const { byToken } = lookupIndex(entries);
  const counters = new Map<number, number>();
  for (const token of promptTokens) {
    const list = byToken.get(token);
    if (!list) continue;
    for (const i of list) counters.set(i, (counters.get(i) ?? 0) + 1);
  }

  let best: { entry: CacheEntry; score: number; index: number } | undefined;
  for (const [i, intersection] of counters) {
    const entry = entries[i]!;
    if (!usable(entry)) continue;
    const entrySize = entryTokenSet(entry).size;
    if (entrySize === 0) continue;
    if (Math.min(promptSize, entrySize) / Math.max(promptSize, entrySize) < threshold) continue;
    const union = promptSize + entrySize - intersection;
    const score = union === 0 ? 0 : intersection / union;
    if (score < threshold) continue;
    // Strictly greater keeps the earliest entry on ties (array order).
    if (!best || score > best.score || (score === best.score && i < best.index)) {
      best = { entry, score, index: i };
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
  semanticKey?: string,
): CacheEntry[] {
  const normalized = normalize(prompt);
  const idx = entries.findIndex((e) => e.normalized === normalized && (semanticKey === undefined || e.semanticKey === semanticKey));

  if (idx !== -1) {
    const updated = [...entries];
    updated[idx] = {
      ...updated[idx],
      category,
      semanticKey,
      lastUsed: Date.now(),
      hits: updated[idx].hits + 1,
    };
    return evictIfNeeded(updated, maxEntries);
  }

  return evictIfNeeded(
    [...entries, { normalized, category, semanticKey, lastUsed: Date.now(), hits: 1, seq: nextSeq++ }],
    maxEntries,
  );
}

export function cachePath(cwd: string, configuredPath?: string): string {
  return resolveStoragePath(cwd, configuredPath, `${CONFIG_DIR_NAME}/bifrost-cache.jsonl`);
}
