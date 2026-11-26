import { CLASSIFIER_BACKEND_IDS } from "../classifier-backends.ts";
import { isDeepStrictEqual } from "node:util";

export function initSaveSummary(
  configBytes: Uint8Array | null,
  nextConfigBytes: Uint8Array,
  probeVerified: Set<string>,
) {
  const before = configBytes === null ? {} : JSON.parse(Buffer.from(configBytes).toString("utf8")) as Record<string, unknown>;
  const after = JSON.parse(Buffer.from(nextConfigBytes).toString("utf8")) as Record<string, unknown>;
  const fieldsAdded = Object.keys(after).filter((key) => !Object.hasOwn(before, key));
  const fieldsChanged = Object.keys(before).filter((key) => !isDeepStrictEqual(before[key], after[key]));
  const memberships = (config: Record<string, unknown>) => {
    const pools = (config.models ?? {}) as Record<string, unknown>;
    return Object.entries(pools).flatMap(([tier, pool]) =>
      (typeof pool === "string" ? [pool] : Array.isArray(pool) ? pool.filter((key): key is string => typeof key === "string") : [])
        .map((modelKey) => JSON.stringify([tier, modelKey])),
    );
  };
  const previousMemberships = new Set(memberships(before));
  const nextMemberships = new Set(memberships(after));
  const changes = [
    ...[...nextMemberships].filter((key) => !previousMemberships.has(key)).map((key) => ({ kind: "add" as const, tier: (JSON.parse(key) as string[])[0]! })),
    ...[...previousMemberships].filter((key) => !nextMemberships.has(key)).map((key) => ({ kind: "remove" as const, tier: (JSON.parse(key) as string[])[0]! })),
  ];
  const savedPools = (after.models ?? {}) as Record<string, unknown>;
  const savedModelKeys = Object.values(savedPools).flatMap((pool) =>
    typeof pool === "string"
      ? [pool]
      : Array.isArray(pool)
        ? pool.filter((key): key is string => typeof key === "string")
        : [],
  );
  const unverifiedSavedCount = savedModelKeys.filter((key) => !probeVerified.has(key)).length;
  const added = changes.filter((change) => change.kind === "add");
  const removed = changes.filter((change) => change.kind === "remove");
  const modelTiers = Object.keys(savedPools).length || removed.length ? `Model tiers  ${[...new Set([...Object.keys(savedPools), ...removed.map((change) => change.tier)])].map((tier) => {
        const pool = savedPools[tier];
        const count = typeof pool === "string" ? 1 : Array.isArray(pool) ? pool.length : 0;
        const plus = added.filter((change) => change.tier === tier).length;
        const minus = removed.filter((change) => change.tier === tier).length;
        const delta = [plus ? `+${plus}` : "", minus ? `-${minus}` : ""].filter(Boolean).join(", ");
        return `${tier} ${count}${delta ? ` (${delta})` : ""}`;
      }).join(" · ")}` : "";
  return { modelTiers, fieldsAdded, fieldsChanged, unverifiedSavedCount };
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
