import { describe, it, expect } from 'vitest';
import { matchesRange, probeVersion } from './version-probe.js';

describe('matchesRange', () => {
  it('matches >= constraint', () => {
    expect(matchesRange('2.0.0', '>=2.0.0')).toBe(true);
    expect(matchesRange('2.5.1', '>=2.0.0')).toBe(true);
    expect(matchesRange('1.9.9', '>=2.0.0')).toBe(false);
  });

  it('matches > constraint', () => {
    expect(matchesRange('2.0.1', '>2.0.0')).toBe(true);
    expect(matchesRange('2.0.0', '>2.0.0')).toBe(false);
  });

  it('matches < constraint', () => {
    expect(matchesRange('2.9.9', '<3.0.0')).toBe(true);
    expect(matchesRange('3.0.0', '<3.0.0')).toBe(false);
  });

  it('matches compound range with both lower and upper', () => {
    expect(matchesRange('2.5.0', '>=2.0.0 <3.0.0')).toBe(true);
    expect(matchesRange('1.9.9', '>=2.0.0 <3.0.0')).toBe(false);
    expect(matchesRange('3.0.0', '>=2.0.0 <3.0.0')).toBe(false);
    expect(matchesRange('3.0.1', '>=2.0.0 <3.0.0')).toBe(false);
  });

  it('matches = constraint', () => {
    expect(matchesRange('2.0.0', '=2.0.0')).toBe(true);
    expect(matchesRange('2.0.1', '=2.0.0')).toBe(false);
  });

  it('rejects malformed version strings', () => {
    expect(matchesRange('two-point-oh', '>=2.0.0')).toBe(false);
  });

  it('rejects malformed constraints', () => {
    expect(matchesRange('2.0.0', 'foo bar')).toBe(false);
  });

  it('handles versions with pre-release/build suffix by parsing leading X.Y.Z', () => {
    expect(matchesRange('2.0.0-beta.1', '>=2.0.0')).toBe(true);
    expect(matchesRange('2.0.0+build.42', '>=2.0.0')).toBe(true);
  });
});

describe('probeVersion', () => {
  it('returns binary-missing when the binary is not on PATH', async () => {
    const result = await probeVersion({
      binary: 'this-binary-definitely-does-not-exist-anywhere-12345',
      versionRange: '>=1.0.0',
      versionProbe: { args: ['--version'], parse: () => '1.0.0' },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('binary-missing');
  });

  it('returns version-out-of-range when installed version is too old', async () => {
    // Use 'node' as a real binary that should always be present, with an impossible range.
    const result = await probeVersion({
      binary: 'node',
      versionRange: '>=99.0.0',
      versionProbe: {
        args: ['--version'],
        parse: (stdout) => stdout.replace(/^v/, '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? '',
      },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('version-out-of-range');
    expect(result.installedVersion).toBeDefined();
  });

  it('returns available with installedVersion when binary is in range', async () => {
    const result = await probeVersion({
      binary: 'node',
      versionRange: '>=1.0.0',
      versionProbe: {
        args: ['--version'],
        parse: (stdout) => stdout.replace(/^v/, '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? '',
      },
    });
    expect(result.available).toBe(true);
    expect(result.installedVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('returns available with probe-failed reason when parse returns empty (graceful)', async () => {
    const result = await probeVersion({
      binary: 'node',
      versionRange: '>=1.0.0',
      versionProbe: { args: ['--version'], parse: () => '' },
    });
    expect(result.available).toBe(true);
    expect(result.reason).toBe('probe-failed');
  });
});
