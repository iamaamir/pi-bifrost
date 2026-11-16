import type { SessionEntry } from "@earendil-works/pi-coding-agent";

type Counts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costValid: boolean;
  usageValid: boolean;
  count: number;
  incomplete: number;
  unknownCost: number;
};
export type CostTotals = Readonly<Counts>;
export type CostResponse = { model: string; usage: CostTotals };
export type CostRequestGroup = { responses: CostResponse[]; totals: CostTotals };
export type CostReportData = {
  activeBranch: {
    groups: CostRequestGroup[];
    responses: CostResponse[];
    auxiliary: { label: string; usage: CostTotals }[];
    totals: CostTotals;
    malformed: number;
  };
  allRetained: { responses: CostResponse[]; totals: CostTotals };
  auxiliary: { label: string; usage: CostTotals }[];
  unassigned: CostTotals;
  unknownCost: {
    activeBranch: number;
    allRetained: number;
    auxiliary: number;
    unassigned: number;
    knownSubtotal: { activeBranch: number; allRetained: number; auxiliary: number; unassigned: number };
  };
};
const empty = (): Counts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  costValid: true,
  usageValid: true,
  count: 0,
  incomplete: 0,
  unknownCost: 0,
});
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function add(target: Counts, usage: unknown): void {
  target.count++;
  if (!usage || typeof usage !== "object") {
    target.costValid = false;
    target.usageValid = false;
    target.unknownCost++;
    target.incomplete++;
    return;
  }
  const value = usage as Record<string, unknown>;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!number(value[key])) {
      target.costValid = false;
      target.usageValid = false;
      target.incomplete++;
      continue;
    }
    target[key] += value[key];
  }
  const cost = value.cost;
  if (!cost || typeof cost !== "object" || !number((cost as Record<string, unknown>).total)) {
    target.costValid = false;
    target.unknownCost++;
  } else {
    target.cost += (cost as Record<string, number>).total;
  }
}

function safeLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "unknown";
  return /^[A-Za-z0-9._:+@/-]{1,160}$/.test(value) ? value : "untrusted-id";
}
function modelFor(message: Record<string, any>): string {
  return `${safeLabel(message.provider)}/${safeLabel(message.responseModel || message.model)}`;
}
function clone(item: Counts): Counts { return { ...item }; }
function merge(target: Counts, item: Counts): void {
  target.input += item.input;
  target.output += item.output;
  target.cacheRead += item.cacheRead;
  target.cacheWrite += item.cacheWrite;
  target.cost += item.cost;
  target.unknownCost += item.unknownCost;
  target.costValid &&= item.costValid;
  target.usageValid &&= item.usageValid;
  target.count += item.count;
  target.incomplete += item.incomplete;
}
function freezeCounts(item: Counts): CostTotals { return Object.freeze(clone(item)); }
function frozenResponses(map: Map<string, Counts>): CostResponse[] {
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([model, usage]) => ({ model, usage: freezeCounts(usage) }));
}

function account(entries: readonly SessionEntry[], assignGroups: boolean) {
  const responses = new Map<string, Counts>();
  const auxiliary = new Map<string, Counts>();
  const groups: { responses: Map<string, Counts>; totals: Counts }[] = [];
  let active: { responses: Map<string, Counts>; totals: Counts } | undefined;
  let unassigned = empty();
  let malformed = 0;
  const bucket = (map: Map<string, Counts>, key: string) => {
    const value = map.get(key) ?? empty();
    map.set(key, value);
    return value;
  };
  for (const raw of entries as readonly unknown[]) {
    if (!raw || typeof raw !== "object") {
      malformed++;
      continue;
    }
    const entry = raw as Record<string, any>;
    if (entry.type === "message" && entry.message?.role === "user" && assignGroups) {
      active = { responses: new Map(), totals: empty() };
      groups.push(active);
      continue;
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const message = entry.message;
      const response = bucket(responses, modelFor(message));
      add(response, message.usage);
      if (!assignGroups) continue;
      if (!active) {
        add(unassigned, message.usage);
        continue;
      }
      add(bucket(active.responses, modelFor(message)), message.usage);
      add(active.totals, message.usage);
      continue;
    }
    if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage !== undefined) {
      add(bucket(auxiliary, "tool result"), entry.message.usage);
    } else if (entry.type === "compaction" && entry.usage !== undefined) add(bucket(auxiliary, "compaction (model unspecified)"), entry.usage);
    else if (entry.type === "branch_summary" && entry.usage !== undefined) add(bucket(auxiliary, "branch summary (model unspecified)"), entry.usage);
    else if (entry.type === "usage") add(bucket(auxiliary, "auxiliary usage entry"), entry.usage);
  }
  return { responses, auxiliary, groups, unassigned, malformed };
}

function totalOf(items: Iterable<Counts>, malformed = 0): Counts {
  const total = empty();
  for (const item of items) merge(total, item);
  if (malformed) {
    total.usageValid = false;
    total.costValid = false;
    total.incomplete += malformed;
  }
  if (!total.count) total.costValid = false;
  return total;
}

/** Returns accounting data only; request text and entry identifiers are never copied into the result. */
export function getCostReportData(activeBranchEntries: readonly SessionEntry[], allRetainedEntries: readonly SessionEntry[]): CostReportData {
  const active = account(activeBranchEntries, true);
  const retained = account(allRetainedEntries, false);
  const activeTotals = totalOf([...active.responses.values(), ...active.auxiliary.values()], active.malformed);
  const retainedTotals = totalOf([...retained.responses.values(), ...retained.auxiliary.values()], retained.malformed);
  const auxiliaryTotals = [...retained.auxiliary.values()];
  const knownSubtotal = (items: Counts[]) => items.reduce((n, item) => n + item.cost, 0);
  return {
    activeBranch: {
      groups: active.groups.map((group) => ({ responses: frozenResponses(group.responses), totals: freezeCounts(group.totals) })),
      responses: frozenResponses(active.responses),
      auxiliary: [...active.auxiliary].map(([label, usage]) => ({ label, usage: freezeCounts(usage) })),
      totals: freezeCounts(activeTotals),
      malformed: active.malformed,
    },
    allRetained: { responses: frozenResponses(retained.responses), totals: freezeCounts(retainedTotals) },
    auxiliary: [...retained.auxiliary].map(([label, usage]) => ({ label, usage: freezeCounts(usage) })),
    unassigned: freezeCounts(active.unassigned),
    unknownCost: {
      activeBranch: activeTotals.unknownCost,
      allRetained: retainedTotals.unknownCost,
      auxiliary: auxiliaryTotals.reduce((n, item) => n + item.unknownCost, 0),
      unassigned: active.unassigned.unknownCost,
      knownSubtotal: {
        activeBranch: knownSubtotal([...active.responses.values(), ...active.auxiliary.values()]),
        allRetained: knownSubtotal([...retained.responses.values(), ...retained.auxiliary.values()]),
        auxiliary: knownSubtotal(auxiliaryTotals),
        unassigned: active.unassigned.cost,
      },
    },
  };
}
