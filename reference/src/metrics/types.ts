/**
 * Metrics collection types from PRD Section 14.1.
 *
 * Five metric categories:
 * - task-effectiveness
 * - human-in-loop
 * - code-quality
 * - economic-efficiency
 * - autonomy-trajectory
 */

export type MetricCategory =
  | 'task-effectiveness'
  | 'human-in-loop'
  | 'code-quality'
  | 'economic-efficiency'
  | 'autonomy-trajectory';

export interface MetricDefinition {
  name: string;
  category: MetricCategory;
  description: string;
  unit: string;
}

export interface MetricDataPoint {
  metric: string;
  value: number;
  timestamp: string;
  labels?: Record<string, string>;
}

export interface MetricQuery {
  metric: string;
  labels?: Record<string, string>;
  from?: string;
  to?: string;
}

export interface MetricSummary {
  metric: string;
  count: number;
  min: number;
  max: number;
  avg: number;
  latest: number;
}

export interface MetricStore {
  register(definition: MetricDefinition): void;
  record(point: Omit<MetricDataPoint, 'timestamp'> & { timestamp?: string }): MetricDataPoint;
  current(metric: string, labels?: Record<string, string>): number | undefined;
  query(query: MetricQuery): readonly MetricDataPoint[];
  summarize(metric: string, labels?: Record<string, string>): MetricSummary | undefined;
  snapshot(labels?: Record<string, string>): Record<string, number>;
  definitions(): readonly MetricDefinition[];
}

/**
 * Standard metrics defined by PRD Section 14.1.
 */
export const STANDARD_METRICS: readonly MetricDefinition[] = [
  // Task Effectiveness
  {
    name: 'task-completion-rate',
    category: 'task-effectiveness',
    description: 'Percentage of tasks completed successfully',
    unit: 'percent',
  },
  {
    name: 'first-pass-success-rate',
    category: 'task-effectiveness',
    description: 'Percentage of tasks passing on first attempt',
    unit: 'percent',
  },
  {
    name: 'mean-time-to-completion',
    category: 'task-effectiveness',
    description: 'Average time from task start to completion',
    unit: 'seconds',
  },

  // Human-in-the-Loop
  {
    name: 'approval-rate',
    category: 'human-in-loop',
    description: 'Percentage of AI outputs approved without changes',
    unit: 'percent',
  },
  {
    name: 'revision-count',
    category: 'human-in-loop',
    description: 'Average number of revisions per task',
    unit: 'count',
  },
  {
    name: 'human-intervention-rate',
    category: 'human-in-loop',
    description: 'Percentage of tasks requiring human intervention',
    unit: 'percent',
  },

  // Code Quality
  {
    name: 'test-coverage',
    category: 'code-quality',
    description: 'Test coverage of generated code',
    unit: 'percent',
  },
  {
    name: 'lint-pass-rate',
    category: 'code-quality',
    description: 'Percentage of changes passing lint checks',
    unit: 'percent',
  },
  {
    name: 'security-finding-rate',
    category: 'code-quality',
    description: 'Security findings per 1000 lines of code',
    unit: 'per-kloc',
  },

  // Economic Efficiency
  {
    name: 'cost-per-task',
    category: 'economic-efficiency',
    description: 'Average cost per completed task',
    unit: 'usd',
  },
  {
    name: 'time-saved-ratio',
    category: 'economic-efficiency',
    description: 'Ratio of time saved vs manual execution',
    unit: 'ratio',
  },

  // Autonomy Trajectory
  {
    name: 'autonomy-level',
    category: 'autonomy-trajectory',
    description: 'Current autonomy level of agent',
    unit: 'level',
  },
  {
    name: 'promotion-velocity',
    category: 'autonomy-trajectory',
    description: 'Rate of autonomy level advancement',
    unit: 'levels-per-month',
  },
  {
    name: 'demotion-frequency',
    category: 'autonomy-trajectory',
    description: 'Number of demotions per time period',
    unit: 'per-month',
  },

  // Additional operational metrics (PRD Section 14.1)
  {
    name: 'handoff-count',
    category: 'task-effectiveness',
    description: 'Total number of agent-to-agent handoffs',
    unit: 'count',
  },
  {
    name: 'handoff-failure-rate',
    category: 'task-effectiveness',
    description: 'Percentage of handoffs that failed validation',
    unit: 'percent',
  },
  {
    name: 'approval-wait-time',
    category: 'human-in-loop',
    description: 'Average time waiting for human approval',
    unit: 'milliseconds',
  },
  {
    name: 'sandbox-violation-count',
    category: 'code-quality',
    description: 'Number of sandbox constraint violations',
    unit: 'count',
  },
  {
    name: 'kill-switch-activation-count',
    category: 'autonomy-trajectory',
    description: 'Number of kill switch activations',
    unit: 'count',
  },
  {
    name: 'compliance-coverage',
    category: 'code-quality',
    description: 'Percentage of applicable compliance controls covered',
    unit: 'percent',
  },
  {
    name: 'adapter-health-rate',
    category: 'task-effectiveness',
    description: 'Percentage of adapters reporting healthy status',
    unit: 'percent',
  },
  {
    name: 'agent-discovery-count',
    category: 'task-effectiveness',
    description: 'Number of agents discovered via A2A protocol',
    unit: 'count',
  },
] as const;
