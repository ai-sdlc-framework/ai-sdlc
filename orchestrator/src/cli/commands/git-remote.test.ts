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
  it('returns the parsed remote when execSync succeeds', () => {
    const remote = detectGitRemote({
      cwd: '/fake',
      execImpl: () => 'https://github.com/acme/widgets.git\n',
    });
    expect(remote).toEqual({ org: 'acme', repo: 'widgets', detected: true });
  });

  it('falls back when execSync throws (no git, no remote)', () => {
    const remote = detectGitRemote({
      cwd: '/fake',
      execImpl: () => {
        throw new Error('not a git repository');
      },
    });
    expect(remote).toEqual({ org: 'your-org', repo: 'your-repo', detected: false });
  });

  it('falls back when remote URL is unparseable', () => {
    const remote = detectGitRemote({
      cwd: '/fake',
      execImpl: () => 'garbage',
    });
    expect(remote.detected).toBe(false);
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
