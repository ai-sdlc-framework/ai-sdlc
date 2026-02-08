import { describe, it, expect } from 'vitest';
import {
  createStubSandbox,
  createStubJITCredentialIssuer,
  createStubKillSwitch,
  createStubApprovalWorkflow,
} from './stubs.js';

describe('createStubSandbox', () => {
  it('isolates a task and returns a sandbox ID', async () => {
    const sandbox = createStubSandbox();
    const id = await sandbox.isolate('task-1', {
      maxMemoryMb: 512,
      maxCpuPercent: 50,
      networkPolicy: 'none',
      timeoutMs: 30000,
      allowedPaths: ['/tmp'],
    });
    expect(id).toMatch(/^sandbox-/);
    expect(await sandbox.getStatus(id)).toBe('running');
  });

  it('destroys a sandbox', async () => {
    const sandbox = createStubSandbox();
    const id = await sandbox.isolate('task-1', {
      maxMemoryMb: 256,
      maxCpuPercent: 25,
      networkPolicy: 'egress-only',
      timeoutMs: 5000,
      allowedPaths: [],
    });
    await sandbox.destroy(id);
    expect(await sandbox.getStatus(id)).toBe('terminated');
  });

  it('throws when destroying unknown sandbox', async () => {
    const sandbox = createStubSandbox();
    await expect(sandbox.destroy('unknown')).rejects.toThrow('not found');
  });
});

describe('createStubJITCredentialIssuer', () => {
  it('issues a credential with scope and TTL', async () => {
    const issuer = createStubJITCredentialIssuer();
    const cred = await issuer.issue('agent-1', ['repo:read'], 60_000);
    expect(cred.id).toMatch(/^cred-/);
    expect(cred.scope).toEqual(['repo:read']);
    expect(await issuer.isValid(cred.id)).toBe(true);
  });

  it('revokes a credential', async () => {
    const issuer = createStubJITCredentialIssuer();
    const cred = await issuer.issue('agent-1', ['repo:write'], 60_000);
    await issuer.revoke(cred.id);
    expect(await issuer.isValid(cred.id)).toBe(false);
  });

  it('reports expired credentials as invalid', async () => {
    const issuer = createStubJITCredentialIssuer();
    // Issue with 0ms TTL — already expired
    const cred = await issuer.issue('agent-1', ['repo:read'], 0);
    // Small delay to ensure expiry
    await new Promise((r) => setTimeout(r, 5));
    expect(await issuer.isValid(cred.id)).toBe(false);
  });

  it('returns false for unknown credential', async () => {
    const issuer = createStubJITCredentialIssuer();
    expect(await issuer.isValid('unknown')).toBe(false);
  });
});

describe('createStubKillSwitch', () => {
  it('starts inactive', async () => {
    const ks = createStubKillSwitch();
    expect(await ks.isActive()).toBe(false);
    expect(await ks.getReason()).toBeUndefined();
  });

  it('activates with a reason', async () => {
    const ks = createStubKillSwitch();
    await ks.activate('security incident');
    expect(await ks.isActive()).toBe(true);
    expect(await ks.getReason()).toBe('security incident');
  });

  it('deactivates and clears reason', async () => {
    const ks = createStubKillSwitch();
    await ks.activate('test');
    await ks.deactivate();
    expect(await ks.isActive()).toBe(false);
    expect(await ks.getReason()).toBeUndefined();
  });
});

describe('createStubApprovalWorkflow', () => {
  it('auto-approves auto tier', async () => {
    const wf = createStubApprovalWorkflow();
    const req = await wf.submit('auto', 'agent-1', 'minor change');
    expect(req.status).toBe('approved');
    expect(req.decidedBy).toBe('system');
  });

  it('creates pending request for higher tiers', async () => {
    const wf = createStubApprovalWorkflow();
    const req = await wf.submit('peer-review', 'agent-1', 'medium change');
    expect(req.status).toBe('pending');
  });

  it('approves a pending request', async () => {
    const wf = createStubApprovalWorkflow();
    const req = await wf.submit('team-lead', 'agent-1', 'infra change');
    const approved = await wf.approve(req.id, 'lead-1');
    expect(approved.status).toBe('approved');
    expect(approved.decidedBy).toBe('lead-1');
  });

  it('rejects a pending request', async () => {
    const wf = createStubApprovalWorkflow();
    const req = await wf.submit('security-review', 'agent-1', 'sensitive change');
    const rejected = await wf.reject(req.id, 'sec-team', 'too risky');
    expect(rejected.status).toBe('rejected');
  });

  it('throws when approving non-pending request', async () => {
    const wf = createStubApprovalWorkflow();
    const req = await wf.submit('auto', 'agent-1', 'already approved');
    await expect(wf.approve(req.id, 'someone')).rejects.toThrow('not pending');
  });
});
