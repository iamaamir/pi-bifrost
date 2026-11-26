import type { FailureObservation } from "./failure-observations.ts";
import type { ReliabilityConfig } from "./reliability.ts";

export type AutoRecoveryCategory = "allowance_exhausted" | "billing_denied" | "request_budget_exceeded";

/** A model-bound text hint, not authoritative HTTP status or account scope. */
export function requestBudgetRejectionHint(errorText: unknown, modelKey: string): boolean {
  if (typeof errorText !== "string" || errorText.length > 4096) return false;
  let message = errorText.trim().replace(/^429(?:\s*:\s*|\s+)/, "");
  if (message.startsWith("{")) {
    try {
      const parsed = JSON.parse(message);
      const detail = parsed?.error ?? parsed;
      if (typeof detail?.message !== "string" || (detail.code != null && detail.code !== "rate_limit_exceeded")) return false;
      message = detail.message;
    } catch { return false; }
  }
  const match = /^Request too large for (\S+)(?: in organization \S+)? on tokens per min \(TPM\): Limit (\d{1,15}), Requested (\d{1,15})\. The input or output tokens must be reduced in order to run successfully\.(?:\s|$)/.exec(message);
  if (!match || match[1] !== modelKey.slice(modelKey.indexOf("/") + 1)) return false;
  return Number(match[2]) > 0 && Number(match[3]) > Number(match[2]);
}

export function autoRecoveryCategory(observation: FailureObservation | undefined, budgetHint: boolean): AutoRecoveryCategory | undefined {
  if (observation?.source !== "runtime") return undefined;
  const category = observation.category;
  if (category === "allowance_exhausted" || category === "billing_denied") return category;
  if (budgetHint && (category === "unknown" || category === "rate_limit")
    && observation.categoryEvidence !== "structured" && observation.categoryEvidence !== "http_status") return "request_budget_exceeded";
  return undefined;
}

export function autoRecoveryOptedIn(config: ReliabilityConfig | undefined, category: AutoRecoveryCategory): boolean {
  return category === "request_budget_exceeded" ? config?.retryOnRequestBudgetExceeded === true : config?.retryOnAllowanceExhausted === true;
}

export function autoRecoveryEnabled(config: ReliabilityConfig | undefined, category: AutoRecoveryCategory): boolean {
  return config?.enabled !== false && autoRecoveryOptedIn(config, category)
    && (category === "request_budget_exceeded" || config?.cooldownOnAllowanceExhausted !== false);
}

const descriptions: Record<AutoRecoveryCategory, { label: string; noun: string; route: string }> = {
  allowance_exhausted: { label: "usage limit reached", noun: "a usage limit", route: "allowance recovery" },
  billing_denied: { label: "billing was denied", noun: "a billing denial", route: "allowance recovery" },
  request_budget_exceeded: { label: "request budget exceeded", noun: "a request budget rejection", route: "request-budget recovery" },
};

export function recoveryDescription(category: AutoRecoveryCategory) {
  return descriptions[category];
}
