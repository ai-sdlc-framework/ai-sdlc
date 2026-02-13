# Telemetry

OpenTelemetry instrumentation for distributed tracing, metrics, and structured logging. Uses `@opentelemetry/api` which is a no-op when no SDK is configured.

## Import

```typescript
import {
  // Semantic conventions
  SPAN_NAMES,
  METRIC_NAMES,
  ATTRIBUTE_KEYS,
  AI_SDLC_PREFIX,

  // Instrumentation
  getTracer,
  getMeter,
  withSpan,
  withSpanSync,

  // Logging
  createNoOpLogger,
  createBufferLogger,
  createConsoleLogger,
  type StructuredLogger,
  type BufferLogger,
  type LogEntry,
  type LogLevel,
} from '@ai-sdlc/reference';
```

## Tracing

### `getTracer()`

Get the AI-SDLC OpenTelemetry tracer instance.

```typescript
function getTracer(): Tracer;
```

### `getMeter()`

Get the AI-SDLC OpenTelemetry meter instance.

```typescript
function getMeter(): Meter;
```

### `withSpan(name, attributes, fn)`

Execute an async function within an OpenTelemetry span. Automatically records errors and sets span status.

```typescript
async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T>;
```

```typescript
import { withSpan } from '@ai-sdlc/reference';

const result = await withSpan(
  'enforce-gates',
  { 'ai-sdlc.gate': 'test-coverage', 'ai-sdlc.agent': 'code-agent' },
  async (span) => {
    span.setAttribute('ai-sdlc.metrics.coverage', 87.5);
    return enforce(qualityGate, context);
  },
);
```

### `withSpanSync(name, attributes, fn)`

Synchronous version of `withSpan`.

```typescript
function withSpanSync<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => T,
): T;
```

## Semantic Conventions

### `SPAN_NAMES`

Standard span names for AI-SDLC operations (e.g., `ai-sdlc.enforce`, `ai-sdlc.reconcile`).

### `METRIC_NAMES`

Standard OTel metric names.

### `ATTRIBUTE_KEYS`

Standard span attribute keys.

### `AI_SDLC_PREFIX`

The prefix for all AI-SDLC telemetry names: `'ai-sdlc'`.

## Structured Logging

### `StructuredLogger`

```typescript
interface StructuredLogger {
  debug(msg: string, attrs?: Record<string, unknown>): void;
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>, err?: Error): void;
}
```

### `LogEntry`

```typescript
interface LogEntry {
  level: LogLevel;      // 'debug' | 'info' | 'warn' | 'error'
  message: string;
  timestamp: string;    // ISO-8601
  logger?: string;
  attributes?: Record<string, unknown>;
  error?: string;
}
```

### `createNoOpLogger()`

Create a logger that silently discards all messages. Useful as a default when no logging is needed.

### `createBufferLogger(name?)`

Create a logger that stores entries in memory. Useful for testing.

```typescript
function createBufferLogger(name?: string): BufferLogger;
```

```typescript
interface BufferLogger extends StructuredLogger {
  getEntries(): readonly LogEntry[];
  clear(): void;
}
```

```typescript
import { createBufferLogger } from '@ai-sdlc/reference';

const logger = createBufferLogger('test');
logger.info('Pipeline started', { pipeline: 'feature-delivery' });
logger.warn('Gate advisory failure', { gate: 'doc-check', coverage: 60 });

const entries = logger.getEntries();
console.log(entries.length); // 2
logger.clear();
```

### `createConsoleLogger(name?)`

Create a logger that writes JSON-formatted structured logs to the console.

```typescript
function createConsoleLogger(name?: string): StructuredLogger;
```

Output format (one JSON object per line):
```json
{"level":"info","message":"Pipeline started","timestamp":"2025-...","logger":"my-app","attributes":{"pipeline":"feature-delivery"}}
```
