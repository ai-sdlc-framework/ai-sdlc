/**
 * Dashboard API response types.
 */

export interface RunSummary {
  runId: string;
  issueNumber?: number;
  prNumber?: number;
  pipelineType: string;
  status: string;
  agentName?: string;
  costUsd?: number;
  tokensUsed?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface AgentSummary {
  agentName: string;
  currentLevel: number;
  totalTasks: number;
  successRate: number;
  lastTaskAt?: string;
}

export interface CostSummaryResponse {
  totalCostUsd: number;
  totalTokens: number;
  runCount: number;
  byAgent: Array<{ agentName: string; costUsd: number; runs: number }>;
  timeSeries: Array<{ date: string; costUsd: number; runs: number }>;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  runsTotal: number;
  runsLast24h: number;
  failureRate24h: number;
  activeAgents: number;
}
