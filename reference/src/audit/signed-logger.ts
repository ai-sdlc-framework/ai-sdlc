/**
 * Signed audit logger — adds HMAC-SHA256 signatures to audit entries
 * layered on top of the existing hash chain.
 *
 * Supports key rotation: each entry stores the key ID used for signing.
 */

import { createHmac } from 'node:crypto';
import type { AuditEntry, AuditLog, AuditSink, IntegrityResult } from './types.js';
import { createAuditLog, computeEntryHash } from './logger.js';

export interface SigningKey {
  /** Unique key identifier. */
  id: string;
  /** HMAC secret (hex or utf-8). */
  secret: string;
  /** Algorithm (defaults to 'sha256'). */
  algorithm?: string;
}

export interface SignedAuditEntry extends AuditEntry {
  /** HMAC signature of the entry. */
  readonly signature: string;
  /** Key ID used for signing. */
  readonly keyId: string;
}

export interface SignedAuditLog {
  /** Record and sign an audit entry. */
  record(entry: Omit<AuditEntry, 'id' | 'timestamp'> & { timestamp?: string }): SignedAuditEntry;
  /** Get all entries. */
  entries(): readonly SignedAuditEntry[];
  /** Verify both hash chain integrity and signatures. */
  verifyIntegrity(): SignedIntegrityResult;
  /** Rotate to a new signing key. */
  rotateKey(newKey: SigningKey): void;
}

export interface SignedIntegrityResult extends IntegrityResult {
  /** Whether all signatures are valid. */
  signaturesValid: boolean;
  /** Index of first invalid signature, if any. */
  invalidSignatureAt?: number;
}

/**
 * Compute HMAC signature for an audit entry.
 */
export function signEntry(entry: AuditEntry, key: SigningKey): string {
  const algo = key.algorithm ?? 'sha256';
  const payload = JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    hash: entry.hash,
    previousHash: entry.previousHash,
  });
  return createHmac(algo, key.secret).update(payload).digest('hex');
}

/**
 * Verify an HMAC signature against an audit entry.
 */
export function verifySignature(entry: SignedAuditEntry, key: SigningKey): boolean {
  const expected = signEntry(entry, key);
  return expected === entry.signature;
}

/**
 * Create a signed audit log that adds HMAC signatures to every entry.
 */
export function createSignedAuditLog(
  initialKey: SigningKey,
  sink?: AuditSink,
): SignedAuditLog {
  const inner = createAuditLog(sink);
  let currentKey = initialKey;
  const signedEntries: SignedAuditEntry[] = [];
  const keyHistory = new Map<string, SigningKey>([[initialKey.id, initialKey]]);

  return {
    record(partial): SignedAuditEntry {
      const entry = inner.record(partial);
      const signature = signEntry(entry, currentKey);

      const signed: SignedAuditEntry = Object.freeze({
        ...entry,
        signature,
        keyId: currentKey.id,
      });
      signedEntries.push(signed);
      return signed;
    },

    entries(): readonly SignedAuditEntry[] {
      return signedEntries;
    },

    verifyIntegrity(): SignedIntegrityResult {
      // First verify the hash chain
      const chainResult = inner.verifyIntegrity();

      // Then verify all signatures
      let signaturesValid = true;
      let invalidSignatureAt: number | undefined;

      for (let i = 0; i < signedEntries.length; i++) {
        const entry = signedEntries[i];
        const key = keyHistory.get(entry.keyId);
        if (!key || !verifySignature(entry, key)) {
          signaturesValid = false;
          invalidSignatureAt = i;
          break;
        }
      }

      return {
        ...chainResult,
        signaturesValid,
        invalidSignatureAt,
      };
    },

    rotateKey(newKey: SigningKey): void {
      currentKey = newKey;
      keyHistory.set(newKey.id, newKey);
    },
  };
}
