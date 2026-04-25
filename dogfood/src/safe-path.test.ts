import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSafeReadPath, UnsafePathError } from './safe-path.js';

describe('UnsafePathError', () => {
  it('inherits from Error and carries the conventional name', () => {
    const err = new UnsafePathError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UnsafePathError');
    expect(err.message).toBe('boom');
  });
});

describe('assertSafeReadPath', () => {
  it('accepts a path that lives under the supplied repo root', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'safe-path-'));
    try {
      const target = join(tmp, 'body.txt');
      writeFileSync(target, 'hello');
      expect(assertSafeReadPath(target, tmp)).toContain('body.txt');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('accepts a path under os.tmpdir()', () => {
    const target = join(tmpdir(), 'safe-path-test-tmpdir.txt');
    writeFileSync(target, 'hello');
    try {
      expect(assertSafeReadPath(target, '/some/other/repo')).toBeTruthy();
    } finally {
      rmSync(target);
    }
  });

  it('rejects a path outside any allowed root', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'safe-path-'));
    try {
      // /etc/hosts lives under / — not under the repo root, not under
      // any tmp dir, and not under RUNNER_TEMP. Must throw.
      expect(() => assertSafeReadPath('/etc/hosts', tmp)).toThrow(UnsafePathError);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('falls back to the resolved form when the file does not exist (yet)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'safe-path-'));
    try {
      const target = join(tmp, 'will-not-exist.txt');
      // No throw — caller's readFileSync will raise ENOENT with a clear message.
      expect(assertSafeReadPath(target, tmp)).toContain('will-not-exist.txt');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('accepts /tmp on macOS even though os.tmpdir() returns a different path', () => {
    // The fix: /tmp is in allowedRoots even when os.tmpdir() is /var/folders/.../T.
    // We assume /tmp exists on the host (it does on macOS, Linux, WSL).
    const target = '/tmp/safe-path-tmp-test.txt';
    writeFileSync(target, 'hello');
    try {
      // Pass an unrelated repo root so the only viable allowed-root is /tmp.
      expect(assertSafeReadPath(target, '/some/other/repo')).toBeTruthy();
    } finally {
      rmSync(target);
    }
  });
});
