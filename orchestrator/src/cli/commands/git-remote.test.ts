/**
 * Tests for git remote URL parsing and pipeline.yaml substitution
 * (AISDLC-78 AC #2, #6).
 */

import { describe, it, expect } from 'vitest';
import { parseRemoteUrl, detectGitRemote, applyRemoteToPipelineYaml } from './git-remote.js';

describe('parseRemoteUrl', () => {
  it('parses HTTPS GitHub URL with .git suffix', () => {
    expect(parseRemoteUrl('https://github.com/foo/bar.git')).toEqual({
      org: 'foo',
      repo: 'bar',
      detected: true,
    });
  });

  it('parses HTTPS GitHub URL without .git suffix', () => {
    expect(parseRemoteUrl('https://github.com/foo/bar')).toEqual({
      org: 'foo',
      repo: 'bar',
      detected: true,
    });
  });

  it('parses SSH shorthand URL (git@host:org/repo.git)', () => {
    expect(parseRemoteUrl('git@github.com:foo/bar.git')).toEqual({
      org: 'foo',
      repo: 'bar',
      detected: true,
    });
  });

  it('parses SSH shorthand URL without .git', () => {
    expect(parseRemoteUrl('git@github.com:foo/bar')).toEqual({
      org: 'foo',
      repo: 'bar',
      detected: true,
    });
  });

  it('parses ssh://git@host/org/repo.git', () => {
    expect(parseRemoteUrl('ssh://git@github.com/foo/bar.git')).toEqual({
      org: 'foo',
      repo: 'bar',
      detected: true,
    });
  });

  it('handles GitLab nested groups (uses last two segments)', () => {
    expect(parseRemoteUrl('git@gitlab.com:group/subgroup/repo.git')).toEqual({
      org: 'subgroup',
      repo: 'repo',
      detected: true,
    });
  });

  it('returns null for an empty/garbage URL', () => {
    expect(parseRemoteUrl('')).toBeNull();
    expect(parseRemoteUrl('not a url')).toBeNull();
  });

  it('strips trailing whitespace from the URL', () => {
    expect(parseRemoteUrl('  https://github.com/foo/bar.git\n')).toEqual({
      org: 'foo',
      repo: 'bar',
      detected: true,
    });
  });
});

describe('detectGitRemote', () => {
  /**
   * Build an execImpl that routes the two commands detectGitRemote runs.
   * Step 1: `git -C <cwd> rev-parse --show-toplevel` — must equal cwd
   *         (after realpath) for detection to proceed.
   * Step 2: `git -C <cwd> remote get-url origin` — the actual URL fetch.
   *
   * The default toplevel is the cwd itself (i.e. cwd IS a real git
   * repo root) so individual tests only need to define the URL handler
   * unless they want to exercise the "ancestor bleed" path.
   */
  function makeExec(opts: {
    toplevel?: string | (() => never);
    url?: string | (() => never);
  }): NonNullable<Parameters<typeof detectGitRemote>[0]>['execImpl'] {
    return (cmd): string => {
      if (cmd.includes('rev-parse --show-toplevel')) {
        if (typeof opts.toplevel === 'function') opts.toplevel();
        const top = typeof opts.toplevel === 'string' ? opts.toplevel : '/fake';
        return top + '\n';
      }
      if (cmd.includes('remote get-url origin')) {
        if (typeof opts.url === 'function') opts.url();
        return typeof opts.url === 'string' ? opts.url : '';
      }
      throw new Error(`unexpected command: ${cmd}`);
    };
  }

  it('returns the parsed remote when execSync succeeds', () => {
    const remote = detectGitRemote({
      cwd: '/fake',
      execImpl: makeExec({ url: 'https://github.com/acme/widgets.git\n' }),
    });
    expect(remote).toEqual({ org: 'acme', repo: 'widgets', detected: true });
  });

  it('falls back when execSync throws (no git, no remote)', () => {
    const remote = detectGitRemote({
      cwd: '/fake',
      execImpl: makeExec({
        toplevel: () => {
          throw new Error('not a git repository');
        },
      }),
    });
    expect(remote).toEqual({ org: 'your-org', repo: 'your-repo', detected: false });
  });

  it('falls back when remote URL is unparseable', () => {
    const remote = detectGitRemote({
      cwd: '/fake',
      execImpl: makeExec({ url: 'garbage' }),
    });
    expect(remote.detected).toBe(false);
  });

  it('falls back when git toplevel is an ancestor (host-repo bleed, AISDLC-104)', () => {
    // Simulate the failure mode the AISDLC-104 fix exists to prevent:
    // git walked up from cwd and reported the ancestor's toplevel,
    // which would otherwise have us read the ancestor's `origin` URL.
    const remote = detectGitRemote({
      cwd: '/fake/proj',
      execImpl: makeExec({
        toplevel: '/fake', // ancestor, NOT /fake/proj
        url: 'git@github.com:host-org/host-repo.git\n',
      }),
    });
    expect(remote).toEqual({ org: 'your-org', repo: 'your-repo', detected: false });
  });
});

describe('applyRemoteToPipelineYaml', () => {
  const TEMPLATE = `apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
spec:
  providers:
    sourceControl:
      type: github
      config:
        org: your-org
`;

  it('substitutes the org placeholder when detected', () => {
    const out = applyRemoteToPipelineYaml(TEMPLATE, {
      org: 'acme',
      repo: 'widgets',
      detected: true,
    });
    expect(out).toContain('org: acme');
    expect(out).not.toContain('your-org');
  });

  it('preserves the placeholder when fallback', () => {
    const out = applyRemoteToPipelineYaml(TEMPLATE, {
      org: 'your-org',
      repo: 'your-repo',
      detected: false,
    });
    expect(out).toContain('org: your-org');
  });

  it('does not over-replace tokens that look like the placeholder', () => {
    const tricky = `apiVersion: ai-sdlc.io/v1alpha1
metadata:
  notes: |
    This pipeline used to belong to your-org-legacy. Now owned by your-org.
spec:
  providers:
    sourceControl:
      config:
        org: your-org
`;
    const out = applyRemoteToPipelineYaml(tricky, {
      org: 'acme',
      repo: 'widgets',
      detected: true,
    });
    // The annotation comment should retain its literal text.
    expect(out).toContain('your-org-legacy');
    // The annotation also still contains the bare phrase "your-org" — we
    // only substitute the structured `org:` key.
    expect(out).toMatch(/owned by your-org/);
    // The actual config key was rewritten.
    expect(out).toContain('org: acme');
  });
});
