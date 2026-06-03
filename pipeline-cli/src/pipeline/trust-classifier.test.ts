/**
 * Hermetic tests for RFC-0043 Stage 0 — Trust Classifier (AISDLC-497)
 *
 * AC#9: covers positive/negative/drift cases.
 * AC#10: enforces the no-live-GitHub-API-on-critical-path invariant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyTrust,
  extractAllowlistedAuthorsFromYaml,
  loadAllowlistedAuthors,
  shouldEngageUcvg,
} from './trust-classifier.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

const TRUSTED_REVIEWERS_WITH_ALLOWLIST = `
# Trusted signing keys
reviewers:
  - identity: 'test@example.com'
    machine: 'test-machine'
    addedAt: '2026-01-01'
    addedBy: 'admin'
    pubkey: |
      -----BEGIN PUBLIC KEY-----
      MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
      -----END PUBLIC KEY-----

allowlist:
  authors:
    - login: alice
      name: Alice Smith
      addedAt: '2026-06-01'
      addedBy: admin
    - login: bob
      name: Bob Jones
      addedAt: '2026-06-02'
      addedBy: admin
`;

const TRUSTED_REVIEWERS_NO_ALLOWLIST = `
reviewers:
  - identity: 'test@example.com'
    machine: 'test-machine'
    addedAt: '2026-01-01'
    addedBy: 'admin'
    pubkey: |
      -----BEGIN PUBLIC KEY-----
      MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
      -----END PUBLIC KEY-----
`;

const TRUSTED_REVIEWERS_EMPTY_ALLOWLIST = `
reviewers: []

allowlist:
  authors: []
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdlc-trust-test-'));
  mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
  return dir;
}

function writeTrustedReviewers(workDir: string, content: string): void {
  writeFileSync(join(workDir, '.ai-sdlc', 'trusted-reviewers.yaml'), content, 'utf8');
}

// ── extractAllowlistedAuthorsFromYaml ────────────────────────────────────────

describe('extractAllowlistedAuthorsFromYaml', () => {
  it('extracts login values from allowlist.authors', () => {
    const logins = extractAllowlistedAuthorsFromYaml(TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    expect(logins).toContain('alice');
    expect(logins).toContain('bob');
    expect(logins).toHaveLength(2);
  });

  it('returns empty array when no allowlist block', () => {
    const logins = extractAllowlistedAuthorsFromYaml(TRUSTED_REVIEWERS_NO_ALLOWLIST);
    expect(logins).toHaveLength(0);
  });

  it('returns empty array when allowlist.authors is empty', () => {
    const logins = extractAllowlistedAuthorsFromYaml(TRUSTED_REVIEWERS_EMPTY_ALLOWLIST);
    expect(logins).toHaveLength(0);
  });

  it('returns empty array for empty string', () => {
    const logins = extractAllowlistedAuthorsFromYaml('');
    expect(logins).toHaveLength(0);
  });

  it('skips comment lines', () => {
    const yaml = `
# This is a comment
allowlist:
  # Another comment
  authors:
    - login: trusted-user
`;
    const logins = extractAllowlistedAuthorsFromYaml(yaml);
    expect(logins).toContain('trusted-user');
  });
});

// ── loadAllowlistedAuthors ───────────────────────────────────────────────────

describe('loadAllowlistedAuthors', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = makeTempWorkDir();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns empty array when trusted-reviewers.yaml does not exist', () => {
    const logins = loadAllowlistedAuthors(workDir);
    expect(logins).toHaveLength(0);
  });

  it('returns allowlisted logins when file has allowlist block', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    const logins = loadAllowlistedAuthors(workDir);
    expect(logins).toContain('alice');
    expect(logins).toContain('bob');
  });

  it('returns empty array when file has no allowlist block', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_NO_ALLOWLIST);
    const logins = loadAllowlistedAuthors(workDir);
    expect(logins).toHaveLength(0);
  });

  // AC#10: enforce no-live-GitHub-API-on-critical-path invariant
  it('makes NO network calls (uses only static file)', () => {
    // Spy on any global fetch or http to ensure none are made
    const fetchSpy = vi
      .spyOn(global, 'fetch' as never)
      .mockRejectedValue(
        new Error('Network calls are forbidden on the trust-classification critical path'),
      );

    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    const logins = loadAllowlistedAuthors(workDir);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logins).toContain('alice');

    fetchSpy.mockRestore();
  });
});

// ── classifyTrust ────────────────────────────────────────────────────────────

describe('classifyTrust', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = makeTempWorkDir();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // AC#9 positive cases

  it('classifies author-in-allowlist as TRUSTED (allowlist model)', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    const result = classifyTrust({
      author: 'alice',
      isFork: false,
      reviewerAuthorityModel: 'allowlist',
      workDir,
    });
    expect(result.classification).toBe('trusted');
    expect(result.reason).toBe('author-in-allowlist');
    expect(result.allowlistedAuthors).toContain('alice');
  });

  it('classifies allowlisted fork-PR author as TRUSTED (allowlist overrides fork)', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    const result = classifyTrust({
      author: 'alice',
      isFork: true, // fork, but alice is in the allowlist
      reviewerAuthorityModel: 'allowlist',
      workDir,
    });
    expect(result.classification).toBe('trusted');
    expect(result.reason).toBe('author-in-allowlist');
  });

  it('classifies everyone as TRUSTED in open model (UCVG opt-in)', () => {
    const result = classifyTrust({
      author: 'unknown-contributor',
      isFork: true,
      reviewerAuthorityModel: 'open',
      workDir,
    });
    expect(result.classification).toBe('trusted');
    expect(result.reason).toBe('reviewerAuthorityModel-open');
    expect(result.allowlistedAuthors).toHaveLength(0); // no file read needed
  });

  // AC#9 negative cases

  it('classifies fork-PR non-allowlisted author as UNTRUSTED', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    const result = classifyTrust({
      author: 'unknown-contributor',
      isFork: true,
      reviewerAuthorityModel: 'allowlist',
      workDir,
    });
    expect(result.classification).toBe('untrusted');
    expect(result.reason).toBe('fork-pr-always-untrusted');
  });

  it('classifies non-fork non-allowlisted author as UNTRUSTED (allowlist model)', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    const result = classifyTrust({
      author: 'unknown-contributor',
      isFork: false,
      reviewerAuthorityModel: 'allowlist',
      workDir,
    });
    expect(result.classification).toBe('untrusted');
    expect(result.reason).toBe('author-not-in-allowlist');
  });

  it('classifies non-fork non-allowlisted author as UNTRUSTED (allowlist+role model)', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    const result = classifyTrust({
      author: 'unknown-contributor',
      isFork: false,
      reviewerAuthorityModel: 'allowlist+role',
      workDir,
    });
    expect(result.classification).toBe('untrusted');
    expect(result.reason).toBe('author-not-in-allowlist');
  });

  it('classifies fork-PR as UNTRUSTED when no allowlist file exists', () => {
    // No file written — empty allowlist
    const result = classifyTrust({
      author: 'some-author',
      isFork: true,
      reviewerAuthorityModel: 'allowlist',
      workDir,
    });
    expect(result.classification).toBe('untrusted');
    expect(result.reason).toBe('fork-pr-always-untrusted');
    expect(result.allowlistedAuthors).toHaveLength(0);
  });

  // AC#9 drift test: drift between file and GitHub state does NOT affect classification
  it('drift: classification uses ONLY static file (not live GitHub state)', () => {
    // Simulate drift: alice has GitHub write+ but is also in file = trusted
    // carol has GitHub write+ but is NOT in file = untrusted (drift, but static file wins)
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);

    // carol is not in the file — trust classifier says untrusted
    const carolResult = classifyTrust({
      author: 'carol',
      isFork: false,
      reviewerAuthorityModel: 'allowlist',
      workDir,
    });
    expect(carolResult.classification).toBe('untrusted');
    expect(carolResult.reason).toBe('author-not-in-allowlist');
    // carol's GitHub permissions are irrelevant — only the file matters
  });

  // AC#10 invariant tests

  it('makes NO network calls (AC#10 — no-live-GitHub-API invariant)', async () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);

    const fetchSpy = vi
      .spyOn(global, 'fetch' as never)
      .mockRejectedValue(
        new Error('No network calls allowed on the trust-classification critical path'),
      );

    classifyTrust({
      author: 'alice',
      isFork: false,
      reviewerAuthorityModel: 'allowlist',
      workDir,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // RFC-0022 composition (AC#3)

  it('open model → trusted regardless of fork/allowlist (AC#3)', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    const result = classifyTrust({
      author: 'external-contributor',
      isFork: true, // fork PR, but open model
      reviewerAuthorityModel: 'open',
      workDir,
    });
    expect(result.classification).toBe('trusted');
    expect(result.reason).toBe('reviewerAuthorityModel-open');
  });

  it('defaults to open model when no reviewerAuthorityModel specified', () => {
    const result = classifyTrust({
      author: 'external-contributor',
      isFork: true,
      // no reviewerAuthorityModel — defaults to 'open'
      workDir,
    });
    expect(result.classification).toBe('trusted');
    expect(result.reason).toBe('reviewerAuthorityModel-open');
    expect(result.reviewerAuthorityModel).toBe('open');
  });

  it('returns audit-friendly allowlistedAuthors list in result', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    const result = classifyTrust({
      author: 'unknown',
      isFork: false,
      reviewerAuthorityModel: 'allowlist',
      workDir,
    });
    expect(result.allowlistedAuthors).toContain('alice');
    expect(result.allowlistedAuthors).toContain('bob');
    expect(result.classification).toBe('untrusted');
  });

  // Finding #8: case-insensitive GitHub login comparison
  it('classifies author as TRUSTED case-insensitively (Alice == alice)', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    // File has `alice` (lowercase), but GitHub may send `Alice` (capitalized)
    const result = classifyTrust({
      author: 'Alice', // different casing than allowlist entry `alice`
      isFork: false,
      reviewerAuthorityModel: 'allowlist',
      workDir,
    });
    expect(result.classification).toBe('trusted');
    expect(result.reason).toBe('author-in-allowlist');
    // Original case is preserved in audit output
    expect(result.author).toBe('Alice');
  });

  it('classifies author as TRUSTED case-insensitively (ALICE == alice)', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    const result = classifyTrust({
      author: 'ALICE',
      isFork: false,
      reviewerAuthorityModel: 'allowlist',
      workDir,
    });
    expect(result.classification).toBe('trusted');
    expect(result.reason).toBe('author-in-allowlist');
    // Original case preserved for audit
    expect(result.author).toBe('ALICE');
  });

  it('preserves original-case allowlistedAuthors in audit output when case-folded match used', () => {
    writeTrustedReviewers(workDir, TRUSTED_REVIEWERS_WITH_ALLOWLIST);
    const result = classifyTrust({
      author: 'ALICE',
      isFork: false,
      reviewerAuthorityModel: 'allowlist',
      workDir,
    });
    // The allowlistedAuthors field should contain the original-case entries from the file
    expect(result.allowlistedAuthors).toContain('alice'); // as stored in file
    expect(result.allowlistedAuthors).toContain('bob');
  });
});

// ── shouldEngageUcvg ─────────────────────────────────────────────────────────

describe('shouldEngageUcvg', () => {
  it('returns false for open model (UCVG opt-in only)', () => {
    const result = classifyTrust({
      author: 'anyone',
      isFork: true,
      reviewerAuthorityModel: 'open',
      workDir: tmpdir(),
    });
    expect(shouldEngageUcvg(result)).toBe(false);
  });

  it('returns true for untrusted author in allowlist model', () => {
    const result: Parameters<typeof shouldEngageUcvg>[0] = {
      classification: 'untrusted',
      reason: 'fork-pr-always-untrusted',
      author: 'external',
      reviewerAuthorityModel: 'allowlist',
      allowlistedAuthors: ['alice'],
    };
    expect(shouldEngageUcvg(result)).toBe(true);
  });

  it('returns false for trusted author in allowlist model', () => {
    const result: Parameters<typeof shouldEngageUcvg>[0] = {
      classification: 'trusted',
      reason: 'author-in-allowlist',
      author: 'alice',
      reviewerAuthorityModel: 'allowlist',
      allowlistedAuthors: ['alice'],
    };
    expect(shouldEngageUcvg(result)).toBe(false);
  });
});
