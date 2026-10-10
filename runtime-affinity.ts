/** Ephemeral, branch-local proof of a successful physical dispatch. */

export interface RuntimeAffinityAnchor {
  readonly modelKey: string;
  readonly provider: string;
  readonly branchEntryId: string;
  readonly dispatchId: string;
  readonly observedAt: number;
}

/** Values in this proof must come from the runtime adapter, not model-name inference. */
export interface RuntimeAffinitySuccessProof {
  readonly outcome: "success";
  readonly modelKey: string;
  readonly branchEntryId: string;
  readonly dispatchId: string;
  readonly dispatchUnambiguous: true;
  readonly physicalDispatch: true;
  readonly observedAt: number;
}

export interface RuntimeAffinityStore {
  promote(session: object, proof: RuntimeAffinitySuccessProof, branch: readonly unknown[]): boolean;
  read(session: object, branch: readonly unknown[]): RuntimeAffinityAnchor | undefined;
  reset(session: object): void;
}

const MAX_KEY_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const MAX_BRANCH_ENTRIES = 100_000;
const MAX_EPOCH = 8.64e15;
const SUCCESS_STOP_REASONS = new Set(["stop", "length", "toolUse"]);

interface BranchEntryView {
  readonly id: string;
  readonly modelKey: string;
}

function dataValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/[\u0000-\u0020\u007f]/u.test(value);
}

function parseModelKey(value: unknown): { key: string; provider: string } | undefined {
  if (!safeIdentifier(value, MAX_KEY_LENGTH)) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const provider = value.slice(0, separator);
  if (provider.includes("/") || provider.length > 128) return undefined;
  return { key: value, provider };
}

function validEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_EPOCH;
}

function branchEntries(branch: readonly unknown[]): readonly unknown[] | undefined {
  if (!Array.isArray(branch) || branch.length > MAX_BRANCH_ENTRIES) return undefined;
  return branch;
}

function branchEntryView(entry: unknown): BranchEntryView | undefined {
  if (dataValue(entry, "type") !== "message") return undefined;
  const id = dataValue(entry, "id");
  const message = dataValue(entry, "message");
  if (!safeIdentifier(id, MAX_ID_LENGTH) || dataValue(message, "role") !== "assistant") return undefined;
  const stopReason = dataValue(message, "stopReason");
  if (typeof stopReason !== "string" || !SUCCESS_STOP_REASONS.has(stopReason)) return undefined;
  if (dataValue(message, "api") === "pi-virtual") return undefined;

  const provider = dataValue(message, "provider");
  const model = dataValue(message, "model");
  if (!safeIdentifier(provider, 128) || provider.includes("/") || !safeIdentifier(model, MAX_KEY_LENGTH)) return undefined;
  const modelKey = `${provider}/${model}`;
  if (!parseModelKey(modelKey)) return undefined;
  return { id, modelKey };
}

function uniqueEntryIndex(branch: readonly unknown[], entryId: string, modelKey: string): number | undefined {
  let found: number | undefined;
  for (let index = 0; index < branch.length; index++) {
    if (dataValue(branch[index], "id") !== entryId) continue;
    if (found !== undefined) return undefined;
    const view = branchEntryView(branch[index]);
    if (!view || view.modelKey !== modelKey) return undefined;
    found = index;
  }
  return found;
}

function validProof(proof: RuntimeAffinitySuccessProof): { key: string; provider: string } | undefined {
  if (dataValue(proof, "outcome") !== "success"
    || dataValue(proof, "dispatchUnambiguous") !== true
    || dataValue(proof, "physicalDispatch") !== true
    || !safeIdentifier(dataValue(proof, "branchEntryId"), MAX_ID_LENGTH)
    || !safeIdentifier(dataValue(proof, "dispatchId"), MAX_ID_LENGTH)
    || !validEpoch(dataValue(proof, "observedAt"))) {
    return undefined;
  }
  return parseModelKey(dataValue(proof, "modelKey"));
}

/** Keeps only projected evidence in a WeakMap; it never persists host messages or payloads. */
export function createRuntimeAffinityStore(): RuntimeAffinityStore {
  const anchors = new WeakMap<object, RuntimeAffinityAnchor>();

  return {
    promote(session, proof, rawBranch) {
      try {
        if (!session || typeof session !== "object") return false;
        const branch = branchEntries(rawBranch);
        const parsed = validProof(proof);
        if (!branch || !parsed) return false;
        const branchEntryId = dataValue(proof, "branchEntryId");
        const dispatchId = dataValue(proof, "dispatchId");
        const observedAt = dataValue(proof, "observedAt");
        if (!safeIdentifier(branchEntryId, MAX_ID_LENGTH)
          || !safeIdentifier(dispatchId, MAX_ID_LENGTH)
          || !validEpoch(observedAt)) return false;

        const entryIndex = uniqueEntryIndex(branch, branchEntryId, parsed.key);
        if (entryIndex === undefined) return false;
        const previous = anchors.get(session);
        if (previous) {
          if (previous.branchEntryId === branchEntryId || observedAt < previous.observedAt) return false;
          const previousIndex = uniqueEntryIndex(branch, previous.branchEntryId, previous.modelKey);
          if (previousIndex === undefined || entryIndex <= previousIndex) return false;
        }

        anchors.set(session, Object.freeze({
          modelKey: parsed.key,
          provider: parsed.provider,
          branchEntryId,
          dispatchId,
          observedAt,
        }));
        return true;
      } catch {
        return false;
      }
    },

    read(session, rawBranch) {
      try {
        if (!session || typeof session !== "object") return undefined;
        const anchor = anchors.get(session);
        const branch = branchEntries(rawBranch);
        if (!anchor || !branch) return undefined;
        return uniqueEntryIndex(branch, anchor.branchEntryId, anchor.modelKey) === undefined
          ? undefined
          : anchor;
      } catch {
        return undefined;
      }
    },

    reset(session) {
      if (session && typeof session === "object") anchors.delete(session);
    },
  };
}
