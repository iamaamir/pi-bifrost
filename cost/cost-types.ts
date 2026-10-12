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

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
