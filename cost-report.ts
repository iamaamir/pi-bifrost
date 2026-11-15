import type { SessionEntry } from "@earendil-works/pi-coding-agent";

type Counts = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; costValid: boolean; usageValid: boolean; count: number; incomplete: number };
const empty = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costValid: true, usageValid: true, count: 0, incomplete: 0 });
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function add(target: Counts, usage: unknown): void {
  target.count++;
  if (!usage || typeof usage !== "object") { target.costValid = false; target.usageValid = false; target.incomplete++; return; }
  const value = usage as Record<string, unknown>;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!number(value[key])) { target.costValid = false; target.usageValid = false; target.incomplete++; continue; }
    target[key] += value[key];
  }
  const cost = value.cost;
  if (!cost || typeof cost !== "object" || !number((cost as Record<string, unknown>).total)) target.costValid = false;
  else target.cost += (cost as Record<string, number>).total;
}

function safeLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "unknown";
  return /^[A-Za-z0-9._:+@/-]{1,160}$/.test(value) ? value : "untrusted-id";
}

function totals(entries: readonly SessionEntry[]) {
  const responses = new Map<string, Counts>();
  const auxiliary = new Map<string, Counts>();
  const auxiliaryBucket = (name: string) => {
    const bucket = auxiliary.get(name) ?? empty();
    auxiliary.set(name, bucket);
    return bucket;
  };
  let malformed = 0;
  for (const raw of entries as readonly unknown[]) {
    if (!raw || typeof raw !== "object") { malformed++; continue; }
    const entry = raw as Record<string, any>;
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const message = entry.message;
      const model = `${safeLabel(message.provider)}/${safeLabel(message.responseModel || message.model)}`;
      const bucket = responses.get(model) ?? empty();
      add(bucket, message.usage);
      responses.set(model, bucket);
    } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage !== undefined) {
      add(auxiliaryBucket("tool result"), entry.message.usage);
    } else if (entry.type === "compaction" && entry.usage !== undefined) add(auxiliaryBucket("compaction (model unspecified)"), entry.usage);
    else if (entry.type === "branch_summary" && entry.usage !== undefined) add(auxiliaryBucket("branch summary (model unspecified)"), entry.usage);
    else if (entry.type === "usage") add(auxiliaryBucket("auxiliary usage entry"), entry.usage);
  }
  return { responses, auxiliary, malformed };
}

function line(label: string, item: Counts): string {
  const cost = item.count && item.costValid ? `$${item.cost.toFixed(6)} reported` : "cost unavailable";
  const usage = item.usageValid ? "recorded" : "partial; malformed/missing usage";
  return `${label}: ${usage} input ${item.input}, output ${item.output}, cache read ${item.cacheRead}, cache write ${item.cacheWrite}; ${cost} (${item.count} entries${item.incomplete ? `, ${item.incomplete} incomplete fields/records` : ""})`;
}

export function formatCostReport(entries: readonly SessionEntry[]): string[] {
  const { responses, auxiliary, malformed } = totals(entries);
  const all = empty();
  for (const item of responses.values()) {
    all.input += item.input; all.output += item.output; all.cacheRead += item.cacheRead; all.cacheWrite += item.cacheWrite;
    all.cost += item.cost; all.costValid &&= item.costValid; all.count += item.count; all.incomplete += item.incomplete;
    all.usageValid &&= item.usageValid;
  }
  for (const item of auxiliary.values()) {
    all.input += item.input; all.output += item.output; all.cacheRead += item.cacheRead; all.cacheWrite += item.cacheWrite;
    all.cost += item.cost; all.costValid &&= item.costValid; all.count += item.count; all.incomplete += item.incomplete;
    all.usageValid &&= item.usageValid;
  }
  if (malformed) {
    all.usageValid = false;
    all.costValid = false;
    all.incomplete += malformed;
  }
  if (!all.count) all.costValid = false;
  return [
    "--- session usage (Pi recorded; estimate, not billing) ---",
    line("whole session", all),
    ...[...responses].sort(([a], [b]) => a.localeCompare(b)).map(([model, item]) => line(`assistant ${model}`, item)),
    ...[...auxiliary].map(([label, item]) => line(label, item)),
    ...(malformed ? [`unreadable session entries: ${malformed}`] : []),
    "Pi entries may include copied fork history and alternate branches; counts are recorded entries, not unique user turns.",
    "Optional auxiliary usage is included only when Pi recorded it; absent usage is not counted as zero.",
    "Zero reported cost is not proof of free usage. Bifrost classifier/probe overhead may be outside this session or unknown; no baseline or net-savings conclusion is available.",
  ];
}
