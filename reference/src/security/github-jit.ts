/**
 * GitHub Secrets-based JIT credential issuer.
 * Issues short-lived credentials by creating temporary GitHub Actions
 * secrets with expiry tracking, and revokes by deleting them.
 * <!-- Source: PRD Section 15 -->
 */

import { createHash, randomBytes } from 'node:crypto';
import type { JITCredentialIssuer, JITCredential } from './interfaces.js';

/** Minimal Octokit-like interface for Secrets operations. */
export interface SecretsClient {
  actions: {
    getRepoPublicKey(params: {
      owner: string;
      repo: string;
    }): Promise<{ data: { key_id: string; key: string } }>;

    createOrUpdateRepoSecret(params: {
      owner: string;
      repo: string;
      secret_name: string;
      encrypted_value: string;
      key_id: string;
    }): Promise<{ status: number }>;

    deleteRepoSecret(params: {
      owner: string;
      repo: string;
      secret_name: string;
    }): Promise<{ status: number }>;
  };
}

/** Encrypt a secret value for the GitHub API (using the repo's public key). */
export type SecretEncryptor = (value: string, publicKey: string) => Promise<string>;

export interface GitHubJITConfig {
  owner: string;
  repo: string;
  /** Secret name prefix (default: "JIT_CRED_"). */
  secretPrefix?: string;
  /** Encrypt function for GitHub's libsodium sealed box. */
  encryptor?: SecretEncryptor;
}

/**
 * Generate a secret name from an agent ID.
 * GitHub secret names: alphanumeric + underscore, not starting with GITHUB_.
 */
function toSecretName(prefix: string, agentId: string, credId: string): string {
  const sanitized = agentId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return `${prefix}${sanitized}_${credId}`;
}

/**
 * Generate a cryptographically random token.
 */
function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Default encryptor — returns a base64 hash for testing/demo.
 * In production, replace with libsodium sealed box encryption.
 */
async function defaultEncryptor(value: string, _publicKey: string): Promise<string> {
  const hash = createHash('sha256').update(value).digest('base64');
  return hash;
}

/**
 * Create a GitHub Secrets-based JIT credential issuer.
 *
 * Each `issue()` call:
 * 1. Generates a random token
 * 2. Creates a GitHub Actions secret with the token value
 * 3. Tracks the credential with expiry metadata
 *
 * `revoke()` deletes the GitHub secret immediately.
 * `isValid()` checks both revocation and TTL expiry.
 */
export function createGitHubJITCredentialIssuer(
  client: SecretsClient,
  config: GitHubJITConfig,
): JITCredentialIssuer {
  const prefix = config.secretPrefix ?? 'JIT_CRED_';
  const encryptor = config.encryptor ?? defaultEncryptor;
  const credentials = new Map<string, JITCredential & { secretName: string }>();
  const revoked = new Set<string>();
  let nextId = 1;

  return {
    async issue(agentId: string, scope: string[], ttlMs: number): Promise<JITCredential> {
      const id = `ghcred-${nextId++}`;
      const token = generateToken();
      const now = Date.now();
      const secretName = toSecretName(prefix, agentId, id);

      // Get the repo's public key for secret encryption
      const { data: publicKey } = await client.actions.getRepoPublicKey({
        owner: config.owner,
        repo: config.repo,
      });

      // Encrypt and store the secret
      const encrypted = await encryptor(token, publicKey.key);

      await client.actions.createOrUpdateRepoSecret({
        owner: config.owner,
        repo: config.repo,
        secret_name: secretName,
        encrypted_value: encrypted,
        key_id: publicKey.key_id,
      });

      const credential: JITCredential & { secretName: string } = {
        id,
        token,
        scope,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        secretName,
      };

      credentials.set(id, credential);
      return {
        id: credential.id,
        token: credential.token,
        scope: credential.scope,
        issuedAt: credential.issuedAt,
        expiresAt: credential.expiresAt,
      };
    },

    async revoke(credentialId: string): Promise<void> {
      const cred = credentials.get(credentialId);
      if (!cred) {
        throw new Error(`Credential "${credentialId}" not found`);
      }

      // Delete the GitHub secret
      await client.actions.deleteRepoSecret({
        owner: config.owner,
        repo: config.repo,
        secret_name: cred.secretName,
      });

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
