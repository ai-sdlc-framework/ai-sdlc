# Metrics

Metric collection, storage, querying, and instrumentation wrappers for AI-SDLC operations.

## Import

```typescript
import {
  // Store
  createMetricStore,
  STANDARD_METRICS,
  type MetricStore,
  type MetricDefinition,
  type MetricDataPoint,
  type MetricQuery,
  type MetricSummary,
  type MetricCategory,

  // Instrumentation
  instrumentEnforcement,
  instrumentExecutor,
  instrumentReconciler,
  instrumentAutonomy,
  type InstrumentationConfig,
} from '@ai-sdlc/reference';
```

## Types

### `MetricCategory`

```typescript
type MetricCategory =
  | 'task-effectiveness'
  | 'human-in-loop'
  | 'code-quality'
  | 'economic-efficiency'
  | 'autonomy-trajectory';
```

### `MetricDefinition`

```typescript
interface MetricDefinition {
  name: string;
  category: MetricCategory;
  description: string;
  unit: string;
}
```

### `MetricDataPoint`

```typescript
interface MetricDataPoint {
  metric: string;
  value: number;
  timestamp: string;          // ISO-8601
  labels?: Record<string, string>;
}
```

### `MetricStore`

```typescript
interface MetricStore {
  register(definition: MetricDefinition): void;
  record(point: Omit<MetricDataPoint, 'timestamp'> & { timestamp?: string }): MetricDataPoint;
  current(metric: string, labels?: Record<string, string>): number | undefined;
  query(query: MetricQuery): readonly MetricDataPoint[];
  summarize(metric: string, labels?: Record<string, string>): MetricSummary | undefined;
  snapshot(labels?: Record<string, string>): Record<string, number>;
  definitions(): readonly MetricDefinition[];
}
```

## Functions

### `createMetricStore()`

Create an in-memory metric store with per-label tracking.

```typescript
function createMetricStore(): MetricStore;
```

```typescript
import { createMetricStore, STANDARD_METRICS } from '@ai-sdlc/reference';

const store = createMetricStore();

// Register standard metrics
for (const def of STANDARD_METRICS) {
  store.register(def);
}

// Record data points
store.record({ metric: 'test-coverage', value: 87.5, labels: { agent: 'code-agent' } });
store.record({ metric: 'approval-rate', value: 0.95, labels: { agent: 'code-agent' } });
store.record({ metric: 'cost-per-task', value: 0.42 });

// Query current values
const coverage = store.current('test-coverage', { agent: 'code-agent' });
console.log(`Coverage: ${coverage}%`);

// Get a summary
const summary = store.summarize('test-coverage');
// { metric: 'test-coverage', count: 1, min: 87.5, max: 87.5, avg: 87.5, latest: 87.5 }

// Snapshot all latest values
const snapshot = store.snapshot();
// { 'test-coverage': 87.5, 'approval-rate': 0.95, 'cost-per-task': 0.42 }
```

## Constants

### `STANDARD_METRICS`

Pre-defined metric definitions from the PRD covering all five categories:

| Metric | Category | Unit |
|---|---|---|
| `task-completion-rate` | task-effectiveness | percent |
| `first-pass-success-rate` | task-effectiveness | percent |
| `mean-time-to-completion` | task-effectiveness | seconds |
| `handoff-count` | task-effectiveness | count |
| `handoff-failure-rate` | task-effectiveness | percent |
| `adapter-health-rate` | task-effectiveness | percent |
| `agent-discovery-count` | task-effectiveness | count |
| `approval-rate` | human-in-loop | percent |
| `revision-count` | human-in-loop | count |
| `human-intervention-rate` | human-in-loop | percent |
| `approval-wait-time` | human-in-loop | milliseconds |
| `test-coverage` | code-quality | percent |
| `lint-pass-rate` | code-quality | percent |
| `security-finding-rate` | code-quality | per-kloc |
| `sandbox-violation-count` | code-quality | count |
| `compliance-coverage` | code-quality | percent |
| `cost-per-task` | economic-efficiency | usd |
| `time-saved-ratio` | economic-efficiency | ratio |
| `autonomy-level` | autonomy-trajectory | level |
| `promotion-velocity` | autonomy-trajectory | levels-per-month |
| `demotion-frequency` | autonomy-trajectory | per-month |
| `kill-switch-activation-count` | autonomy-trajectory | count |

## Instrumentation

Wrappers that automatically record metrics when operations occur.

### `instrumentEnforcement(store)`

Wrap enforcement operations to record gate pass/fail metrics.

### `instrumentExecutor(store)`

Wrap orchestration execution to record step durations and outcomes.

### `instrumentReconciler(store)`

Wrap reconciliation cycles to record timing and error rates.

### `instrumentAutonomy(store)`

Wrap autonomy evaluation to record promotion/demotion events.
