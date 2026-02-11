/**
 * Audit logging types from PRD Section 15.4.
 *
 * Every action MUST produce an immutable audit log entry including:
 * actor, action, resource, policy, decision, timestamp.
 */

export interface AuditEntry {
  /** Unique identifier for the entry. */
  readonly id: string;
  /** ISO-8601 timestamp of when the action occurred. */
  readonly timestamp: string;
  /** The actor (agent name, user, or system) that performed the action. */
  readonly actor: string;
  /** The action that was performed (e.g., 'execute', 'promote', 'enforce'). */
  readonly action: string;
  /** The resource the action was performed on (e.g., 'pipeline/build-pipeline'). */
  readonly resource: string;
  /** The policy that governed the action, if any. */
  readonly policy?: string;
  /** The decision outcome (e.g., 'allowed', 'denied', 'overridden'). */
  readonly decision: 'allowed' | 'denied' | 'overridden';
  /** Additional details about the action. */
  readonly details?: Record<string, unknown>;
  /** SHA-256 hash of this entry's content + previousHash for tamper detection. */
  readonly hash?: string;
  /** Hash of the preceding entry in the chain. */
  readonly previousHash?: string;
}

export interface AuditFilter {
  actor?: string;
  action?: string;
  resource?: string;
  decision?: AuditEntry['decision'];
  from?: string;
  to?: string;
}

export interface AuditSink {
  write(entry: AuditEntry): void | Promise<void>;
  query?(filter: AuditFilter): Promise<readonly AuditEntry[]>;
  rotate?(): Promise<void>;
  close?(): Promise<void>;
}

export interface IntegrityResult {
  valid: boolean;
  brokenAt?: number;
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, 'id' | 'timestamp'> & { timestamp?: string }): AuditEntry;
  entries(): readonly AuditEntry[];
  query(filter: AuditFilter): readonly AuditEntry[];
  verifyIntegrity(): IntegrityResult;
}
