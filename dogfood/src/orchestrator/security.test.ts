import { describe, it, expect } from 'vitest';
import {
  createPipelineSecurity,
  checkKillSwitch,
  issueAgentCredentials,
  revokeAgentCredentials,
  classifyAndSubmitApproval,
  classifyApprovalTier,
  compareTiers,
  createGitHubSandbox,
  createGitHubJITCredentialIssuer,
  createGitHubSandboxProvider,
  createGitHubJITProvider,
} from './security.js';

describe('Security subsystem', () => {
  describe('createPipelineSecurity()', () => {
    it('creates all four security components', () => {
      const sec = createPipelineSecurity();
      expect(sec.sandbox).toBeDefined();
      expect(sec.jitCredentials).toBeDefined();
      expect(sec.killSwitch).toBeDefined();
      expect(sec.approvalWorkflow).toBeDefined();
    });
  });

  describe('checkKillSwitch()', () => {
    it('passes when kill switch is inactive', async () => {
      const sec = createPipelineSecurity();
      await expect(checkKillSwitch(sec)).resolves.toBeUndefined();
    });

    it('throws when kill switch is active', async () => {
      const sec = createPipelineSecurity();
      await sec.killSwitch.activate('security incident');
      await expect(checkKillSwitch(sec)).rejects.toThrow('kill switch active');
    });

    it('includes kill switch reason in error', async () => {
      const sec = createPipelineSecurity();
      await sec.killSwitch.activate('credential leak detected');
      await expect(checkKillSwitch(sec)).rejects.toThrow('credential leak detected');
    });
  });

  describe('JIT credential lifecycle', () => {
    it('issues credentials with scoped TTL', async () => {
      const sec = createPipelineSecurity();
      const cred = await issueAgentCredentials(sec, 'agent-1', ['repo:read'], 60_000);
      expect(cred.id).toBeDefined();
      expect(cred.token).toContain('agent-1');
      expect(cred.scope).toEqual(['repo:read']);
    });

    it('revokes credentials', async () => {
      const sec = createPipelineSecurity();
      const cred = await issueAgentCredentials(sec, 'agent-1');
      await revokeAgentCredentials(sec, cred.id);
      const valid = await sec.jitCredentials.isValid(cred.id);
      expect(valid).toBe(false);
    });

    it('credentials are valid before revocation', async () => {
      const sec = createPipelineSecurity();
      const cred = await issueAgentCredentials(sec, 'agent-1');
      const valid = await sec.jitCredentials.isValid(cred.id);
      expect(valid).toBe(true);
    });
  });

  describe('classifyApprovalTier()', () => {
    it('classifies low complexity as auto', () => {
      expect(classifyApprovalTier({ complexityScore: 2 })).toBe('auto');
    });

    it('classifies medium complexity as peer-review', () => {
      expect(classifyApprovalTier({ complexityScore: 5 })).toBe('peer-review');
    });

    it('classifies high complexity as team-lead', () => {
      expect(classifyApprovalTier({ complexityScore: 7 })).toBe('team-lead');
    });

    it('classifies critical complexity as security-review', () => {
      expect(classifyApprovalTier({ complexityScore: 9 })).toBe('security-review');
    });

    it('escalates to team-lead for infra changes', () => {
      expect(classifyApprovalTier({ complexityScore: 2, isInfraChange: true })).toBe('team-lead');
    });

    it('escalates to security-review for security-sensitive changes', () => {
      expect(classifyApprovalTier({ complexityScore: 2, securitySensitive: true })).toBe(
        'security-review',
      );
    });
  });

  describe('compareTiers()', () => {
    it('auto < peer-review', () => {
      expect(compareTiers('auto', 'peer-review')).toBeLessThan(0);
    });

    it('security-review > team-lead', () => {
      expect(compareTiers('security-review', 'team-lead')).toBeGreaterThan(0);
    });

    it('same tier returns 0', () => {
      expect(compareTiers('peer-review', 'peer-review')).toBe(0);
    });
  });

  describe('GitHub infrastructure backends', () => {
    it('re-exports createGitHubSandbox', () => {
      expect(typeof createGitHubSandbox).toBe('function');
    });

    it('re-exports createGitHubJITCredentialIssuer', () => {
      expect(typeof createGitHubJITCredentialIssuer).toBe('function');
    });

    it('createGitHubSandboxProvider wraps createGitHubSandbox', () => {
      const mockClient = {
        codespaces: {
          createWithRepoForAuthenticatedUser: async () => ({
            data: { id: 1, name: 'test', state: 'Available' },
          }),
          getForAuthenticatedUser: async () => ({
            data: { id: 1, name: 'test', state: 'Available' },
          }),
          deleteForAuthenticatedUser: async () => ({ status: 202 }),
          stopForAuthenticatedUser: async () => ({
            data: { id: 1, name: 'test', state: 'Shutdown' },
          }),
        },
      };
      const sandbox = createGitHubSandboxProvider(mockClient, {
        owner: 'test',
        repo: 'test',
        devcontainerPath: '.devcontainer/devcontainer.json',
      });
      expect(sandbox).toBeDefined();
      expect(typeof sandbox.isolate).toBe('function');
      expect(typeof sandbox.destroy).toBe('function');
    });

    it('createGitHubJITProvider wraps createGitHubJITCredentialIssuer', () => {
      const mockClient = {
        actions: {
          getRepoPublicKey: async () => ({ data: { key_id: '1', key: 'abc' } }),
          createOrUpdateRepoSecret: async () => ({ status: 201 }),
          deleteRepoSecret: async () => ({ status: 204 }),
        },
      };
      const issuer = createGitHubJITProvider(mockClient, {
        owner: 'test',
        repo: 'test',
      });
      expect(issuer).toBeDefined();
      expect(typeof issuer.issue).toBe('function');
      expect(typeof issuer.revoke).toBe('function');
    });
  });

  describe('classifyAndSubmitApproval()', () => {
    it('auto-approves low-complexity requests', async () => {
      const sec = createPipelineSecurity();
      const req = await classifyAndSubmitApproval(sec, 2, 'agent-1', 'fix typo');
      expect(req.status).toBe('approved');
      expect(req.tier).toBe('auto');
    });

    it('leaves high-complexity requests pending', async () => {
      const sec = createPipelineSecurity();
      const req = await classifyAndSubmitApproval(sec, 7, 'agent-1', 'refactor auth system');
      expect(req.status).toBe('pending');
      expect(req.tier).toBe('team-lead');
    });
  });
});
