/**
 * Stub (in-memory) implementations of enterprise security interfaces.
 * Intended for testing and development; not for production use.
 */

import type {
  Sandbox,
  SandboxConstraints,
  SandboxStatus,
  JITCredentialIssuer,
  JITCredential,
  KillSwitch,
  ApprovalWorkflow,
  ApprovalRequest,
  ApprovalTier,
} from './interfaces.js';

// ── Stub Sandbox ─────────────────────────────────────────────────────

export function createStubSandbox(): Sandbox {
  const sandboxes = new Map<string, SandboxStatus>();
  let nextId = 1;

  return {
    async isolate(_taskId: string, _constraints: SandboxConstraints): Promise<string> {
      const id = `sandbox-${nextId++}`;
      sandboxes.set(id, 'running');
      return id;
    },

    async destroy(sandboxId: string): Promise<void> {
      if (!sandboxes.has(sandboxId)) {
        throw new Error(`Sandbox "${sandboxId}" not found`);
      }
      sandboxes.set(sandboxId, 'terminated');
    },

    async getStatus(sandboxId: string): Promise<SandboxStatus> {
      const status = sandboxes.get(sandboxId);
      if (!status) {
        throw new Error(`Sandbox "${sandboxId}" not found`);
      }
      return status;
    },
  };
}

// ── Stub JIT Credential Issuer ───────────────────────────────────────

export function createStubJITCredentialIssuer(): JITCredentialIssuer {
  const credentials = new Map<string, JITCredential>();
  const revoked = new Set<string>();
  let nextId = 1;

  return {
    async issue(agentId: string, scope: string[], ttlMs: number): Promise<JITCredential> {
      const id = `cred-${nextId++}`;
      const now = Date.now();
      const credential: JITCredential = {
        id,
        token: `tok-${agentId}-${id}`,
        scope,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      };
      credentials.set(id, credential);
      return credential;
    },

    async revoke(credentialId: string): Promise<void> {
      if (!credentials.has(credentialId)) {
        throw new Error(`Credential "${credentialId}" not found`);
      }
      revoked.add(credentialId);
    },

    async isValid(credentialId: string): Promise<boolean> {
      const cred = credentials.get(credentialId);
      if (!cred) return false;
      if (revoked.has(credentialId)) return false;
      return new Date(cred.expiresAt).getTime() > Date.now();
    },
  };
}

// ── Stub Kill Switch ─────────────────────────────────────────────────

export function createStubKillSwitch(): KillSwitch {
  let active = false;
  let reason: string | undefined;

  return {
    async activate(r: string): Promise<void> {
      active = true;
      reason = r;
    },

    async deactivate(): Promise<void> {
      active = false;
      reason = undefined;
    },

    async isActive(): Promise<boolean> {
      return active;
    },

    async getReason(): Promise<string | undefined> {
      return active ? reason : undefined;
    },
  };
}

// ── Stub Approval Workflow ───────────────────────────────────────────

export function createStubApprovalWorkflow(): ApprovalWorkflow {
  const requests = new Map<string, ApprovalRequest>();
  let nextId = 1;

  return {
    async submit(
      tier: ApprovalTier,
      requester: string,
      description: string,
    ): Promise<ApprovalRequest> {
      const id = `approval-${nextId++}`;
      const request: ApprovalRequest = {
        id,
        tier,
        requester,
        description,
        status: tier === 'auto' ? 'approved' : 'pending',
        createdAt: new Date().toISOString(),
        ...(tier === 'auto' ? { decidedAt: new Date().toISOString(), decidedBy: 'system' } : {}),
      };
      requests.set(id, request);
      return request;
    },

    async approve(requestId: string, approver: string): Promise<ApprovalRequest> {
      const request = requests.get(requestId);
      if (!request) throw new Error(`Approval request "${requestId}" not found`);
      if (request.status !== 'pending') throw new Error(`Request "${requestId}" is not pending`);
      const updated = {
        ...request,
        status: 'approved' as const,
        decidedAt: new Date().toISOString(),
        decidedBy: approver,
      };
      requests.set(requestId, updated);
      return updated;
    },

    async reject(requestId: string, rejector: string, _reason: string): Promise<ApprovalRequest> {
      const request = requests.get(requestId);
      if (!request) throw new Error(`Approval request "${requestId}" not found`);
      if (request.status !== 'pending') throw new Error(`Request "${requestId}" is not pending`);
      const updated = {
        ...request,
        status: 'rejected' as const,
        decidedAt: new Date().toISOString(),
        decidedBy: rejector,
      };
      requests.set(requestId, updated);
      return updated;
    },

    async getStatus(requestId: string): Promise<ApprovalRequest> {
      const request = requests.get(requestId);
      if (!request) throw new Error(`Approval request "${requestId}" not found`);
      return request;
    },
  };
}
