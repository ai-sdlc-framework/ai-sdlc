# Reconciler

Reconciliation loop primitives implementing the controller pattern: desired state -> observe -> diff -> act -> loop. The reconciliation engine is level-triggered, idempotent, eventually consistent, and rate-limited with backoff.

## Import

```typescript
import {
  // Loop
  ReconcilerLoop,

  // Primitives
  reconcileOnce,
  calculateBackoff,

  // Resource reconcilers
  createPipelineReconciler,
  createGateReconciler,
  createAutonomyReconciler,
  type PipelineReconcilerDeps,
  type GateReconcilerDeps,
  type AutonomyReconcilerDeps,

  // Diff utilities
  resourceFingerprint,
  hasSpecChanged,
  createResourceCache,
  type ResourceCache,

  // Types
  type ReconcileResult,
  type ReconcilerFn,
  type ReconcilerConfig,
  DEFAULT_RECONCILER_CONFIG,
} from '@ai-sdlc/reference';
```

## Types

### `ReconcileResult`

Result of a single reconciliation cycle. Maps to the four outcomes defined in the spec:

```typescript
type ReconcileResult =
  | { type: 'success' }
  | { type: 'error'; error: Error; retryAfterMs?: number }
  | { type: 'requeue' }
  | { type: 'requeue-after'; delayMs: number };
```

### `ReconcilerFn<R>`

A function that processes a single resource. Implementations MUST be idempotent.

```typescript
type ReconcilerFn<R extends AnyResource = AnyResource> = (
  resource: R,
) => Promise<ReconcileResult>;
```

### `ReconcilerConfig`

```typescript
interface ReconcilerConfig {
  periodicIntervalMs: number;   // Default: 30_000 (30s)
  maxBackoffMs: number;         // Default: 300_000 (5min)
  initialBackoffMs: number;     // Default: 1_000 (1s)
  maxConcurrency: number;       // Default: 10
}
```

## `ReconcilerLoop`

Continuous reconciliation loop with enqueue, periodic re-reconciliation, exponential backoff on errors, and concurrency control.

```typescript
class ReconcilerLoop {
  constructor(reconciler: ReconcilerFn, config?: Partial<ReconcilerConfig>);
  enqueue(resource: AnyResource): void;
  start(): void;
  stop(): void;
  get queueSize(): number;
  get activeCount(): number;
}
```

**Example:**

```typescript
import { ReconcilerLoop } from '@ai-sdlc/reference';

const loop = new ReconcilerLoop(
  async (resource) => {
    console.log(`Reconciling ${resource.metadata.name}`);
    // Compare desired vs actual state, take corrective action
    return { type: 'success' };
  },
  { periodicIntervalMs: 60_000, maxConcurrency: 5 },
);

loop.enqueue(myPipeline);
loop.start();

// Later...
loop.stop();
```

**Behavior:**
- `enqueue()` deduplicates by `metadata.name`. If already active or queued, it's a no-op.
- `start()` begins processing the queue and starts a periodic timer that re-enqueues all known resources.
- On `error` results, retries with exponential backoff (with 10% jitter).
- On `requeue`, immediately re-enqueues. On `requeue-after`, delays by the specified milliseconds.

## Functions

### `reconcileOnce(resource, reconciler)`

Run a single reconciliation cycle with error handling.

```typescript
async function reconcileOnce<R extends AnyResource>(
  resource: R,
  reconciler: ReconcilerFn<R>,
): Promise<ReconcileResult>;
```

### `calculateBackoff(attempt, config?)`

Calculate exponential backoff with 10% jitter.

```typescript
function calculateBackoff(
  attempt: number,
  config?: ReconcilerConfig,
): number;
```

## Resource Reconcilers

Pre-built reconciler functions for the three most common resource types.

### `createPipelineReconciler(deps)`

Create a reconciler for `Pipeline` resources.

```typescript
function createPipelineReconciler(deps: PipelineReconcilerDeps): ReconcilerFn<Pipeline>;
```

### `createGateReconciler(deps)`

Create a reconciler for `QualityGate` resources.

### `createAutonomyReconciler(deps)`

Create a reconciler for `AutonomyPolicy` resources.

## Diff Utilities

### `resourceFingerprint(resource)`

Compute a stable fingerprint (hash) of a resource's spec for change detection.

```typescript
function resourceFingerprint(resource: AnyResource): string;
```

### `hasSpecChanged(resource, cache)`

Check if a resource's spec has changed compared to the cached fingerprint.

### `createResourceCache()`

Create an in-memory cache for tracking resource fingerprints.

```typescript
function createResourceCache(): ResourceCache;
```

```typescript
interface ResourceCache {
  get(name: string): string | undefined;
  set(name: string, fingerprint: string): void;
  delete(name: string): boolean;
  clear(): void;
}
```

```typescript
import { resourceFingerprint, createResourceCache } from '@ai-sdlc/reference';

const cache = createResourceCache();
const fp = resourceFingerprint(myPipeline);

if (cache.get('my-pipeline') !== fp) {
  // Spec changed — reconcile
  cache.set('my-pipeline', fp);
}
```
