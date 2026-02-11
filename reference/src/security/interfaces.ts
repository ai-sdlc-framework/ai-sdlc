/**
 * Enterprise security interfaces for AI-SDLC Framework.
 * Defines contracts for sandbox isolation, JIT credentials,
 * kill switches, and approval workflows.
 */

// ── Sandbox Isolation ────────────────────────────────────────────────

export type NetworkPolicy = 'none' | 'egress-only' | 'full';

export interface SandboxConstraints {
  maxMemoryMb: number;
  maxCpuPercent: number;
  networkPolicy: NetworkPolicy;
  timeoutMs: number;
  allowedPaths: string[];
}

export type SandboxStatus = 'idle' | 'running' | 'terminated' | 'error';

export interface Sandbox {
  /** Isolate an agent task with the given constraints. Returns a sandbox ID. */
  isolate(taskId: string, constraints: SandboxConstraints): Promise<string>;
  /** Destroy a running sandbox. */
  destroy(sandboxId: string): Promise<void>;
  /** Get the current status of a sandbox. */
  getStatus(sandboxId: string): Promise<SandboxStatus>;
}

// ── Secret Store ─────────────────────────────────────────────────────

export interface SecretStore {
  /** Resolve a secret by name. Returns undefined if not found. */
  get(name: string): string | undefined;
  /** Resolve a secret by name. Throws if not found. */
  getRequired(name: string): string;
  /** Store a secret (optional — read-only stores may omit). */
  set?(name: string, value: string, ttl?: number): Promise<void>;
  /** Delete a secret (optional — read-only stores may omit). */
  delete?(name: string): Promise<void>;
}

// ── JIT Credential Issuing ───────────────────────────────────────────

export interface JITCredential {
  id: string;
  token: string;
  scope: string[];
  issuedAt: string;
  expiresAt: string;
}

export interface JITCredentialIssuer {
  /** Issue a short-lived credential with the given scope and TTL. */
  issue(agentId: string, scope: string[], ttlMs: number): Promise<JITCredential>;
  /** Revoke an issued credential. */
  revoke(credentialId: string): Promise<void>;
  /** Check if a credential is still valid. */
  isValid(credentialId: string): Promise<boolean>;
}

// ── Kill Switch ──────────────────────────────────────────────────────

export interface KillSwitch {
  /** Activate the kill switch, halting all agent operations. */
  activate(reason: string): Promise<void>;
  /** Deactivate the kill switch, resuming operations. */
  deactivate(): Promise<void>;
  /** Check if the kill switch is currently active. */
  isActive(): Promise<boolean>;
  /** Get the reason the kill switch was activated, if active. */
  getReason(): Promise<string | undefined>;
}

// ── Approval Workflows ───────────────────────────────────────────────

export type ApprovalTier = 'auto' | 'peer-review' | 'team-lead' | 'security-review';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRequest {
  id: string;
  tier: ApprovalTier;
  requester: string;
  description: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface ApprovalWorkflow {
  /** Submit an action for approval. */
  submit(tier: ApprovalTier, requester: string, description: string): Promise<ApprovalRequest>;
  /** Approve a pending request. */
  approve(requestId: string, approver: string): Promise<ApprovalRequest>;
  /** Reject a pending request. */
  reject(requestId: string, rejector: string, reason: string): Promise<ApprovalRequest>;
  /** Get the status of an approval request. */
  getStatus(requestId: string): Promise<ApprovalRequest>;
}
