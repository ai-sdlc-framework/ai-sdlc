import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGitHubJITCredentialIssuer, type SecretsClient } from './github-jit.js';

function createMockClient(): SecretsClient {
  return {
    actions: {
      getRepoPublicKey: vi.fn().mockResolvedValue({
        data: { key_id: 'key-123', key: 'base64publickey' },
      }),
      createOrUpdateRepoSecret: vi.fn().mockResolvedValue({ status: 201 }),
      deleteRepoSecret: vi.fn().mockResolvedValue({ status: 204 }),
    },
  };
}

const config = { owner: 'acme', repo: 'my-app' };

describe('createGitHubJITCredentialIssuer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a credential and creates a GitHub secret', async () => {
    const client = createMockClient();
    const issuer = createGitHubJITCredentialIssuer(client, config);

    const cred = await issuer.issue('agent-1', ['repo:read', 'issues:write'], 3600_000);

    expect(cred.id).toBe('ghcred-1');
    expect(cred.token).toBeTruthy();
    expect(cred.token.length).toBe(64); // 32 random bytes → 64 hex chars
    expect(cred.scope).toEqual(['repo:read', 'issues:write']);
    expect(cred.issuedAt).toBeTruthy();
    expect(cred.expiresAt).toBeTruthy();

    // Should have called GitHub API to fetch public key and create secret
    expect(client.actions.getRepoPublicKey).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'my-app',
    });
    expect(client.actions.createOrUpdateRepoSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'my-app',
        key_id: 'key-123',
      }),
    );
  });

  it('generates unique IDs for each credential', async () => {
    const client = createMockClient();
    const issuer = createGitHubJITCredentialIssuer(client, config);

    const c1 = await issuer.issue('agent-1', ['read'], 3600_000);
    const c2 = await issuer.issue('agent-1', ['read'], 3600_000);

    expect(c1.id).not.toBe(c2.id);
    expect(c1.token).not.toBe(c2.token);
  });

  it('uses custom secret prefix', async () => {
    const client = createMockClient();
    const issuer = createGitHubJITCredentialIssuer(client, {
      ...config,
      secretPrefix: 'MY_PREFIX_',
    });

    await issuer.issue('agent-1', ['read'], 3600_000);

    expect(client.actions.createOrUpdateRepoSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        secret_name: expect.stringContaining('MY_PREFIX_'),
      }),
    );
  });

  it('isValid returns true for fresh credential', async () => {
    const client = createMockClient();
    const issuer = createGitHubJITCredentialIssuer(client, config);

    const cred = await issuer.issue('agent-1', ['read'], 3600_000);
    const valid = await issuer.isValid(cred.id);
    expect(valid).toBe(true);
  });

  it('isValid returns false for unknown credential', async () => {
    const client = createMockClient();
    const issuer = createGitHubJITCredentialIssuer(client, config);

    expect(await issuer.isValid('unknown-id')).toBe(false);
  });

  it('isValid returns false for expired credential', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

    const client = createMockClient();
    const issuer = createGitHubJITCredentialIssuer(client, config);

    const cred = await issuer.issue('agent-1', ['read'], 60_000); // 1 minute TTL

    // Advance 2 minutes
    vi.setSystemTime(new Date('2025-01-01T00:02:00Z'));

    expect(await issuer.isValid(cred.id)).toBe(false);
  });

  it('revoke deletes the GitHub secret', async () => {
    const client = createMockClient();
    const issuer = createGitHubJITCredentialIssuer(client, config);

    const cred = await issuer.issue('agent-1', ['read'], 3600_000);
    await issuer.revoke(cred.id);

    expect(client.actions.deleteRepoSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'my-app',
      }),
    );
  });

  it('isValid returns false after revocation', async () => {
    const client = createMockClient();
    const issuer = createGitHubJITCredentialIssuer(client, config);

    const cred = await issuer.issue('agent-1', ['read'], 3600_000);
    await issuer.revoke(cred.id);

    expect(await issuer.isValid(cred.id)).toBe(false);
  });

  it('revoke throws for unknown credential', async () => {
    const client = createMockClient();
    const issuer = createGitHubJITCredentialIssuer(client, config);

    await expect(issuer.revoke('unknown-id')).rejects.toThrow('not found');
  });

  it('uses custom encryptor', async () => {
    const client = createMockClient();
    const customEncryptor = vi.fn().mockResolvedValue('custom-encrypted-value');
    const issuer = createGitHubJITCredentialIssuer(client, {
      ...config,
      encryptor: customEncryptor,
    });

    await issuer.issue('agent-1', ['read'], 3600_000);

    expect(customEncryptor).toHaveBeenCalledWith(expect.any(String), 'base64publickey');
    expect(client.actions.createOrUpdateRepoSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        encrypted_value: 'custom-encrypted-value',
      }),
    );
  });
});
