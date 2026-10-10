/** Failure facts for advisory inspection. This module does not alter circuit policy. */

export type FailureCategory =
  | "rate_limit"
  | "allowance_exhausted"
  | "authentication"
  | "billing_denied"
  | "overload"
  | "transport"
  | "model_unavailable"
  | "invalid_request"
  | "capability_mismatch"
  | "context_limit"
  | "tool_protocol"
  | "activation_failed"
  | "unknown";

export type FailureSource = "runtime" | "activation" | "probe";
export type CategoryEvidence = "structured" | "http_status" | "text_heuristic" | "unknown";

export interface FailureObservation {
  outcomeId: string;
  modelKey: string;
  category: FailureCategory;
  categoryEvidence: CategoryEvidence;
  scope: { kind: "model"; modelKey: string };
  scopeEvidence: "model-only";
  observedAt: number;
  retryAt?: number;
  source: FailureSource;
}

export interface FailureObservationClock {
  now?: number;
}

const CATEGORIES = new Set<FailureCategory>([
  "rate_limit",
  "allowance_exhausted",
  "authentication",
  "billing_denied",
  "overload",
  "transport",
  "model_unavailable",
  "invalid_request",
  "capability_mismatch",
  "context_limit",
  "tool_protocol",
  "activation_failed",
  "unknown",
]);

const SOURCES = new Set<FailureSource>(["runtime", "activation", "probe"]);
const MAX_TIMESTAMP = 8.64e15;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 4096;

type DataRecord = Record<string, unknown>;

function asDataRecord(value: unknown): DataRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? value as DataRecord
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read only own data properties, so getters cannot run during normalization. */
function ownValue(record: DataRecord, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_TIMESTAMP;
}

function validOutcomeId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function validModelKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  const separator = value.indexOf("/");
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  return separator > 0
    && /^[A-Za-z0-9][A-Za-z0-9._:+@-]*$/.test(provider)
    && /^[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/.test(model);
}

function categoryValue(value: unknown): FailureCategory | undefined {
  return typeof value === "string" && CATEGORIES.has(value as FailureCategory)
    ? value as FailureCategory
    : undefined;
}

function sourceValue(value: unknown): FailureSource | undefined {
  return typeof value === "string" && SOURCES.has(value as FailureSource)
    ? value as FailureSource
    : undefined;
}

/** Validate the exact allowlisted DTO returned by normalizeFailureObservation. */
export function isNormalizedFailureObservation(
  value: unknown,
  clock: FailureObservationClock = {},
): value is FailureObservation {
  const observation = asDataRecord(value);
  const clockRecord = asDataRecord(clock);
  const suppliedNow = clockRecord ? ownValue(clockRecord, "now") : undefined;
  const now = suppliedNow === undefined ? Date.now() : suppliedNow;
  if (!observation || !validTimestamp(now)) return false;

  const required = ["outcomeId", "modelKey", "category", "categoryEvidence", "scope", "scopeEvidence", "observedAt", "source"];
  const optional = ["retryAt"];
  try {
    const keys = Reflect.ownKeys(observation);
    if (keys.some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
      || required.some((key) => !keys.includes(key))) return false;
    for (const key of keys) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(observation, key);
      if (!descriptor || !("value" in descriptor)) return false;
    }
  } catch {
    return false;
  }

  const outcomeId = ownValue(observation, "outcomeId");
  const modelKey = ownValue(observation, "modelKey");
  const category = categoryValue(ownValue(observation, "category"));
  const evidence = ownValue(observation, "categoryEvidence");
  const scope = asDataRecord(ownValue(observation, "scope"));
  const scopeKind = scope ? ownValue(scope, "kind") : undefined;
  const scopeModel = scope ? ownValue(scope, "modelKey") : undefined;
  const scopeEvidence = ownValue(observation, "scopeEvidence");
  let scopeKeys: PropertyKey[] = [];
  try {
    scopeKeys = scope ? Reflect.ownKeys(scope) : [];
    if (scope && scopeKeys.some((key) => typeof key !== "string"
      || (key !== "kind" && key !== "modelKey")
      || !Object.getOwnPropertyDescriptor(scope, key)
      || !("value" in Object.getOwnPropertyDescriptor(scope, key)!))) return false;
  } catch {
    return false;
  }
  const observedAt = ownValue(observation, "observedAt");
  const retryAt = ownValue(observation, "retryAt");
  const source = sourceValue(ownValue(observation, "source"));
  if (!validOutcomeId(outcomeId) || !validModelKey(modelKey) || !category || !source
    || !validTimestamp(observedAt) || observedAt > now
    || (evidence !== "structured" && evidence !== "http_status" && evidence !== "text_heuristic" && evidence !== "unknown")
    || !scope || scopeKeys.length !== 2 || scopeKind !== "model" || scopeModel !== modelKey || scopeEvidence !== "model-only"
    || scopeKeys.some((key) => key !== "kind" && key !== "modelKey")) return false;

  if (evidence === "http_status" && category !== "rate_limit" && category !== "overload" && category !== "billing_denied") return false;
  if (evidence === "text_heuristic" && (category === "unknown" || category === "activation_failed")) return false;
  if (evidence === "unknown" && category !== "unknown") return false;
  if (!Reflect.ownKeys(observation).includes("retryAt")) return true;
  if (!validTimestamp(retryAt) || retryAt < observedAt) return false;
  const transient = category === "rate_limit" || category === "overload"
    || category === "transport" || category === "model_unavailable";
  return !transient || retryAt - observedAt <= MAX_RETRY_DELAY_MS;
}

function statusCategory(value: unknown): FailureCategory | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) return undefined;
  if (value === 429) return "rate_limit";
  if (value === 402) return "billing_denied";
  if (value === 503) return "overload";
  return undefined;
}

function anchoredHttpStatus(text: string): number | undefined {
  const match = /^\s*(?:(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status\s*[:=]\s*)(402|429)\b|(402|429)(?:\s|$))/i.exec(text);
  return match ? Number(match[1] ?? match[2]) : undefined;
}

function semanticErrorCodeCategory(input: DataRecord): FailureCategory | undefined {
  const error = asDataRecord(ownValue(input, "error"));
  const code = error ? ownValue(error, "code") : undefined;
  if (code === "usage_limit_reached" || code === "usage_not_included" || code === "insufficient_quota") return "allowance_exhausted";
  if (code === "rate_limit_exceeded") return "rate_limit";
  return undefined;
}

function textFromRawFields(input: DataRecord): string {
  const chunks: string[] = [];
  let length = 0;
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const remaining = MAX_TEXT_LENGTH - length;
    if (remaining <= 0) return;
    const bounded = value.slice(0, remaining);
    chunks.push(bounded);
    length += bounded.length;
  };
  const errorText = ownValue(input, "errorText");
  add(errorText);

  const error = ownValue(input, "error");
  if (typeof error === "string") {
    add(error);
  } else {
    const errorRecord = asDataRecord(error);
    if (errorRecord) {
      const message = ownValue(errorRecord, "message");
      const code = ownValue(errorRecord, "code");
      add(message);
      add(code);
    }
  }
  return chunks.join(" ").toLowerCase();
}

function textCategory(text: string): FailureCategory | undefined {
  if (/insufficient[_\s-]+quota|usage[_\s-]+(?:limit[_\s-]+reached|not[_\s-]+included)|quota\s+(?:is\s+)?exhaust|allowance\s+(?:is\s+)?exhaust|usage\s+limit\s+(?:has\s+been\s+)?reached|no\s+remaining\s+credits|credits?\s+(?:are\s+)?exhaust/.test(text)) return "allowance_exhausted";
  if (/authentication|unauthori[sz]ed|invalid\s+api\s+key|credential/.test(text)) return "authentication";
  if (/\b(?:active\s+)?(?:[a-z0-9_-]+\s+){0,3}subscription\s+(?:(?:is|has)\s+)?(?:required|expired)\b|\bexpired\s+subscription\b/.test(text)) return "billing_denied";
  if (/billing\s+(?:denied|issue|failure)|payment\s+required/.test(text)) return "billing_denied";
  if (/context\s+(?:length|window|limit)|too\s+many\s+tokens/.test(text)) return "context_limit";
  if (/tool\s+(?:call|protocol)|invalid\s+tool\s+result/.test(text)) return "tool_protocol";
  if (/capability\s+mismatch|unsupported\s+(?:parameter|feature|capability)/.test(text)) return "capability_mismatch";
  if (/invalid\s+request|bad\s+request|malformed\s+request/.test(text)) return "invalid_request";
  if (/rate\s*limit|too\s+many\s+requests|http\s*429/.test(text)) return "rate_limit";
  if (/overload|overloaded|temporarily\s+unavailable|http\s*503/.test(text)) return "overload";
  if (/timeout|timed\s+out|connection\s+(?:reset|refused)|network\s+error|transport/.test(text)) return "transport";
  if (/model\s+(?:not\s+found|unavailable|does\s+not\s+exist)/.test(text)) return "model_unavailable";
  return undefined;
}

function normalizeRetryAt(value: unknown, observedAt: number, category: FailureCategory): number | undefined {
  if (value === undefined) return undefined;
  if (!validTimestamp(value)) return undefined;
  const retryAt = Math.max(value, observedAt);
  const isTransient = category === "rate_limit"
    || category === "overload"
    || category === "transport"
    || category === "model_unavailable";
  if (isTransient && retryAt - observedAt > MAX_RETRY_DELAY_MS) return undefined;
  return retryAt;
}

/**
 * Normalize an untrusted dispatch failure to privacy-safe, model-only evidence.
 * Structured category wins over HTTP status, which wins over advisory text hints.
 * Unknown shapes or invalid identity/clock fields produce no observation.
 */
export function normalizeFailureObservation(
  value: unknown,
  clock: FailureObservationClock = {},
): FailureObservation | undefined {
  const input = asDataRecord(value);
  if (!input) return undefined;

  // Treat the clock as an explicit injectable port, but read its data property
  // safely so an accessor or hostile proxy cannot run during normalization.
  const clockRecord = asDataRecord(clock);
  const suppliedNow = clockRecord ? ownValue(clockRecord, "now") : undefined;
  const now = suppliedNow === undefined ? Date.now() : suppliedNow;
  if (!validTimestamp(now)) return undefined;

  const outcomeId = ownValue(input, "outcomeId");
  const modelKey = ownValue(input, "modelKey");
  const source = sourceValue(ownValue(input, "source"));
  if (!validOutcomeId(outcomeId) || !validModelKey(modelKey) || !source) return undefined;

  const rawObservedAt = ownValue(input, "observedAt");
  if (rawObservedAt !== undefined && !validTimestamp(rawObservedAt)) return undefined;
  const observedAt = rawObservedAt ?? now;
  if (observedAt > now) return undefined;

  const structured = asDataRecord(ownValue(input, "structured"));
  const structuredCategory = (structured ? categoryValue(ownValue(structured, "category")) : undefined)
    ?? semanticErrorCodeCategory(input);
  const failureText = textFromRawFields(input);
  const structuredStatus = structured ? statusCategory(ownValue(structured, "httpStatus")) : undefined;
  const status = structuredStatus ?? statusCategory(anchoredHttpStatus(failureText));
  const categoryFromText = textCategory(failureText);
  const quotaTextOverrides429 = status === "rate_limit" && categoryFromText === "allowance_exhausted";
  const category = structuredCategory ?? (quotaTextOverrides429 ? categoryFromText : status ?? categoryFromText) ?? "unknown";
  const categoryEvidence: CategoryEvidence = structuredCategory
    ? "structured"
    : quotaTextOverrides429
      ? "text_heuristic"
    : status
      ? "http_status"
      : categoryFromText
        ? "text_heuristic"
        : "unknown";
  const retryAt = normalizeRetryAt(
    structured ? ownValue(structured, "retryAt") : undefined,
    observedAt,
    category,
  );

  return {
    outcomeId,
    modelKey,
    category,
    categoryEvidence,
    scope: { kind: "model", modelKey },
    scopeEvidence: "model-only",
    observedAt,
    ...(retryAt === undefined ? {} : { retryAt }),
    source,
  };
}
