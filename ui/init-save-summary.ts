import { CLASSIFIER_BACKEND_IDS } from "../classifier-backends.ts";
import { isDeepStrictEqual } from "node:util";

type Config = Record<string, unknown>;

function poolModels(pool: unknown): string[] {
  if (typeof pool === "string") return [pool];
  return Array.isArray(pool) ? pool.filter((key): key is string => typeof key === "string") : [];
}

function memberships(config: Config): Set<string> {
  const pools = (config.models ?? {}) as Config;
  return new Set(Object.entries(pools).flatMap(([tier, pool]) =>
    poolModels(pool).map((model) => JSON.stringify([tier, model])),
  ));
}

function membershipChanges(from: Set<string>, to: Set<string>): string[] {
  return [...to].filter((key) => !from.has(key)).map((key) => (JSON.parse(key) as string[])[0]!);
}

function tierSummary(pools: Config, added: string[], removed: string[]): string {
  const tiers = [...new Set([...Object.keys(pools), ...removed])];
  if (!tiers.length) return "";
  return `Model tiers  ${tiers.map((tier) => {
    const pool = pools[tier];
    const count = typeof pool === "string" ? 1 : Array.isArray(pool) ? pool.length : 0;
    const plus = added.filter((name) => name === tier).length;
    const minus = removed.filter((name) => name === tier).length;
    const delta = [plus ? `+${plus}` : "", minus ? `-${minus}` : ""].filter(Boolean).join(", ");
    return `${tier} ${count}${delta ? ` (${delta})` : ""}`;
  }).join(" · ")}`;
}

export function initSaveSummary(
  configBytes: Uint8Array | null,
  nextConfigBytes: Uint8Array,
  probeVerified: Set<string>,
) {
  const before = configBytes === null ? {} : JSON.parse(Buffer.from(configBytes).toString("utf8")) as Config;
  const after = JSON.parse(Buffer.from(nextConfigBytes).toString("utf8")) as Config;
  const fieldsAdded = Object.keys(after).filter((key) => !Object.hasOwn(before, key));
  const fieldsChanged = Object.keys(before).filter((key) => !isDeepStrictEqual(before[key], after[key]));
  const previous = memberships(before);
  const next = memberships(after);
  const savedPools = (after.models ?? {}) as Config;
  const unverifiedSavedCount = Object.values(savedPools).flatMap(poolModels)
    .filter((key) => !probeVerified.has(key)).length;
  return {
    modelTiers: tierSummary(savedPools, membershipChanges(previous, next), membershipChanges(next, previous)),
    fieldsAdded, fieldsChanged, unverifiedSavedCount,
  };
}

export function initSavePreviewLines(input: {
  sourceLabel: string; workingCount: number; ranProbe: boolean; probeAge: string;
  summary: ReturnType<typeof initSaveSummary>; receiptOnly: boolean; classifier: string;
  inheritedLines: string[]; uncategorizedCount: number;
}): string[] {
  const { sourceLabel, workingCount, ranProbe, probeAge, summary, receiptOnly, classifier, inheritedLines, uncategorizedCount } = input;
  const { modelTiers, fieldsAdded, fieldsChanged, unverifiedSavedCount } = summary;
  return [
    "Bifrost · ready to save",
    `Save to      ${sourceLabel}`,
    `Models       ${workingCount} working model${workingCount === 1 ? "" : "s"} found${ranProbe ? "" : ` · cached ${probeAge} ago`}`,
    modelTiers,
    receiptOnly ? "Setup        model-management information will be saved" : "",
    fieldsAdded.length ? `Fields added   ${fieldsAdded.join(", ")}` : "",
    fieldsChanged.length ? `Fields changed   ${fieldsChanged.join(", ")}` : "",
    `Classifier  ${classifier}`,
    ...inheritedLines,
    uncategorizedCount ? `Uncategorized  ${uncategorizedCount}` : "",
    uncategorizedCount ? "Uncategorized models stay out of generated pools." : "",
    unverifiedSavedCount ? `${unverifiedSavedCount} saved model tier entries were not verified by this check; handwritten entries are preserved.` : "",
  ].filter(Boolean);
}

export function initClassifierSummary(
  enabled: boolean,
  detected: { backend: string; auto: boolean },
  configuredModel: string | string[] | undefined,
  detectedModel: string | undefined,
): string {
  return !enabled
    ? "off"
    : detected.backend !== CLASSIFIER_BACKEND_IDS.prompt
      ? `${detected.backend} (${detected.auto ? "detected default" : "configured"})`
      : configuredModel
        ? `prompt (${configuredModel}, configured)`
        : detectedModel
          ? `prompt (${detectedModel}, detected default)`
          : "prompt (no eligible model; regex fallback)";
}
