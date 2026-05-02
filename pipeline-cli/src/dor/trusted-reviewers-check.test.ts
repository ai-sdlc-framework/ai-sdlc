/**
 * Trusted-reviewer membership check tests (RFC-0009 + RFC-0011 §7.4).
 *
 * Phase 6 (AISDLC-115.7) — only contributors named in
 * `.ai-sdlc/trusted-reviewers.yaml` may apply the `dor-bypass` label.
 * The check itself is a thin lookup; the load path needs careful
 * coverage because the file format is hand-rolled YAML (see header in
 * the canonical file for the load-bearing constraints).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkActorAllowed,
  loadTrustedReviewers,
  parseTrustedReviewersYaml,
  resolveTrustedReviewersPath,
} from './trusted-reviewers-check.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-trust-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('resolveTrustedReviewersPath', () => {
  it('honors explicit filePath', () => {
    expect(resolveTrustedReviewersPath({ filePath: '/abs/x.yaml' })).toBe('/abs/x.yaml');
  });

  it('resolves <workDir>/.ai-sdlc/trusted-reviewers.yaml', () => {
    expect(resolveTrustedReviewersPath({ workDir: '/proj' })).toBe(
      '/proj/.ai-sdlc/trusted-reviewers.yaml',
    );
  });
});

describe('parseTrustedReviewersYaml', () => {
  it('returns [] for an empty file', () => {
    expect(parseTrustedReviewersYaml('')).toEqual([]);
  });

  it('returns [] when no reviewers: key is present', () => {
    expect(parseTrustedReviewersYaml('# just comments\n')).toEqual([]);
  });

  it('parses a single reviewer entry', () => {
    const yaml = `reviewers:
  - identity: 'a@b.com'
    machine: 'doms-macbook'
    addedAt: '2026-04-28'
    addedBy: 'deefactorial'
`;
    const out = parseTrustedReviewersYaml(yaml);
    expect(out).toHaveLength(1);
    expect(out[0]!.identity).toBe('a@b.com');
    expect(out[0]!.machine).toBe('doms-macbook');
    expect(out[0]!.addedBy).toBe('deefactorial');
  });

  it('parses multiple reviewer entries', () => {
    const yaml = `reviewers:
  - identity: 'a@b.com'
    machine: 'm1'
  - identity: 'ci-attestor'
    machine: 'github-actions'
`;
    const out = parseTrustedReviewersYaml(yaml);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.identity)).toEqual(['a@b.com', 'ci-attestor']);
  });

  it('skips pubkey block scalars without parsing them as identities', () => {
    const yaml = `reviewers:
  - identity: 'a@b.com'
    machine: 'm1'
    pubkey: |
      -----BEGIN PUBLIC KEY-----
      identity: 'ATTACK-INJECTED'
      MCowBQYDK2VwAyEA7RfNqQjnRnt7dG0gjIWIkqyfvn+/aMycmbaEbq7lS7E=
      -----END PUBLIC KEY-----
  - identity: 'c@d.com'
    machine: 'm2'
`;
    const out = parseTrustedReviewersYaml(yaml);
    expect(out).toHaveLength(2);
    // The injected identity inside the pubkey block must NOT leak through.
    expect(out.map((r) => r.identity)).toEqual(['a@b.com', 'c@d.com']);
  });

  it('handles double-quoted strings', () => {
    const yaml = `reviewers:
  - identity: "a@b.com"
`;
    const out = parseTrustedReviewersYaml(yaml);
    expect(out[0]!.identity).toBe('a@b.com');
  });

  it('ignores trailing top-level keys', () => {
    const yaml = `reviewers:
  - identity: 'a@b.com'
otherTopLevel:
  something: 1
`;
    const out = parseTrustedReviewersYaml(yaml);
    expect(out).toHaveLength(1);
  });

  it('ignores unknown per-entry fields', () => {
    const yaml = `reviewers:
  - identity: 'a@b.com'
    futureField: 'whatever'
`;
    const out = parseTrustedReviewersYaml(yaml);
    expect(out).toHaveLength(1);
    expect(out[0]!.identity).toBe('a@b.com');
  });

  it('handles entries with no quotes', () => {
    const yaml = `reviewers:
  - identity: bare-identity
`;
    const out = parseTrustedReviewersYaml(yaml);
    expect(out[0]!.identity).toBe('bare-identity');
  });
});

describe('loadTrustedReviewers', () => {
  it('returns [] when the file does not exist', () => {
    expect(loadTrustedReviewers({ workDir: tmp })).toEqual([]);
  });

  it('reads from the canonical .ai-sdlc/trusted-reviewers.yaml path', () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'trusted-reviewers.yaml'),
      `reviewers:\n  - identity: 'a@b.com'\n`,
    );
    const out = loadTrustedReviewers({ workDir: tmp });
    expect(out).toHaveLength(1);
    expect(out[0]!.identity).toBe('a@b.com');
  });

  it('reads from explicit filePath when provided', () => {
    const path = join(tmp, 'custom-reviewers.yaml');
    writeFileSync(path, `reviewers:\n  - identity: 'override@example.com'\n`);
    const out = loadTrustedReviewers({ filePath: path });
    expect(out[0]!.identity).toBe('override@example.com');
  });
});

describe('checkActorAllowed', () => {
  it('denies an empty actor', () => {
    const r = checkActorAllowed('', { reviewers: [{ identity: 'a@b.com' }] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('empty actor');
  });

  it('denies when no reviewers are configured', () => {
    const r = checkActorAllowed('a@b.com', { reviewers: [] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('no trusted reviewers');
  });

  it('denies when the actor is not in the reviewers list', () => {
    const r = checkActorAllowed('stranger@example.com', {
      reviewers: [{ identity: 'a@b.com' }],
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('not in .ai-sdlc/trusted-reviewers.yaml');
  });

  it('allows when the actor is in the reviewers list', () => {
    const r = checkActorAllowed('a@b.com', {
      reviewers: [{ identity: 'a@b.com', machine: 'm1' }],
    });
    expect(r.allowed).toBe(true);
    expect(r.matched?.identity).toBe('a@b.com');
    expect(r.matched?.machine).toBe('m1');
    expect(r.reason).toContain('trusted reviewer');
  });

  it('falls through to the on-disk file when no reviewers list is provided', () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'trusted-reviewers.yaml'),
      `reviewers:\n  - identity: 'disk@example.com'\n`,
    );
    const allow = checkActorAllowed('disk@example.com', { workDir: tmp });
    expect(allow.allowed).toBe(true);
    const deny = checkActorAllowed('other@example.com', { workDir: tmp });
    expect(deny.allowed).toBe(false);
  });

  it('surfaces the requiredRole label in the allow reason', () => {
    const r = checkActorAllowed('a@b.com', {
      reviewers: [{ identity: 'a@b.com' }],
      requiredRole: 'release-manager',
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain('release-manager');
  });
});
