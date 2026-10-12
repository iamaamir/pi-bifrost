/** Metrics for a single model turn. */
export interface CostTurn {
  timestamp: number;
  modelKey?: string;
  provider?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  promptTokens: number;
  missedTokens: number;
  missedCost: number;
  cost?: any;
}

/** Aggregated session-level cost and cache metrics. */
export interface CostMetrics {
  totalInput: number;
  totalRead: number;
  totalWritten: number;
  totalOutput: number;
  missedTokens: number;
  missedCost: number;
  lastPromptTokens?: number;
  lastModelKey?: string;
  lastTimestamp?: number;
  lastReportedCache?: boolean;
}

/** Normalized raw token counts for a turn. */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
