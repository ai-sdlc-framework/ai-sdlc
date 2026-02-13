# Audit

Append-only, hash-chained audit log with pluggable sinks for tamper-evident action recording.

## Import

```typescript
import {
  createAuditLog,
  computeEntryHash,
  createFileSink,
  loadEntriesFromFile,
  verifyFileIntegrity,
  rotateAuditFile,
  createInMemoryAuditSink,
  type AuditEntry,
  type AuditFilter,
  type AuditSink,
  type AuditLog,
  type IntegrityResult,
  type InMemoryAuditSink,
} from '@ai-sdlc/reference';
```

## Types

### `AuditEntry`

Every action produces an immutable audit log entry. All properties are `readonly`.

```typescript
interface AuditEntry {
  readonly id: string;
  readonly timestamp: string;          // ISO-8601
  readonly actor: string;              // agent name, user, or system
  readonly action: string;             // e.g., 'execute', 'promote', 'enforce'
  readonly resource: string;           // e.g., 'pipeline/build-pipeline'
  readonly policy?: string;            // governing policy, if any
  readonly decision: 'allowed' | 'denied' | 'overridden';
  readonly details?: Record<string, unknown>;
  readonly hash?: string;              // SHA-256 hash chain
  readonly previousHash?: string;      // previous entry's hash
}
```

### `AuditLog`

```typescript
interface AuditLog {
  record(entry: Omit<AuditEntry, 'id' | 'timestamp'> & { timestamp?: string }): AuditEntry;
  entries(): readonly AuditEntry[];
  query(filter: AuditFilter): readonly AuditEntry[];
  verifyIntegrity(): IntegrityResult;
}
```

### `AuditSink`

Pluggable storage backend.

```typescript
interface AuditSink {
  write(entry: AuditEntry): void | Promise<void>;
  query?(filter: AuditFilter): Promise<readonly AuditEntry[]>;
  rotate?(): Promise<void>;
  close?(): Promise<void>;
}
```

### `AuditFilter`

```typescript
interface AuditFilter {
  actor?: string;
  action?: string;
  resource?: string;
  decision?: 'allowed' | 'denied' | 'overridden';
  from?: string;     // ISO-8601 timestamp
  to?: string;
}
```

## Functions

### `createAuditLog(sink?)`

Create an audit log instance with an optional external sink.

```typescript
function createAuditLog(sink?: AuditSink): AuditLog;
```

Each recorded entry is frozen (immutable) after creation. Entries form a SHA-256 hash chain: each entry's hash includes the previous entry's hash, providing tamper-evident integrity.

```typescript
import { createAuditLog } from '@ai-sdlc/reference';

const log = createAuditLog();

log.record({
  actor: 'code-agent',
  action: 'execute',
  resource: 'pipeline/feature-delivery',
  decision: 'allowed',
  details: { stage: 'implement', duration: 45000 },
});

log.record({
  actor: 'review-agent',
  action: 'enforce',
  resource: 'gate/test-coverage',
  decision: 'denied',
  details: { coverage: 72, threshold: 80 },
});

// Query entries
const denied = log.query({ decision: 'denied' });
console.log(`${denied.length} denied action(s)`);

// Verify integrity
const integrity = log.verifyIntegrity();
console.log('Integrity:', integrity.valid ? 'OK' : `Broken at entry ${integrity.brokenAt}`);
```

### `computeEntryHash(entry, previousHash?)`

Compute the SHA-256 hash for an audit entry, chaining to the previous hash.

```typescript
function computeEntryHash(
  entry: Omit<AuditEntry, 'hash'>,
  previousHash?: string,
): string;
```

### `createFileSink(path)`

Create a JSONL file-based audit sink. Entries are appended one per line.

### `loadEntriesFromFile(path)`

Load all audit entries from a JSONL file.

### `verifyFileIntegrity(path)`

Verify the hash chain integrity of a JSONL audit file.

### `rotateAuditFile(path)`

Rotate the audit file (rename current, create fresh).

### `createInMemoryAuditSink()`

Create an in-memory sink for testing. Implements `AuditSink` and exposes `getEntries()`.
