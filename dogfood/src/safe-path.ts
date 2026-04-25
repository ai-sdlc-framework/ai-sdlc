/**
 * Path-traversal guard for CLI file-flags.
 *
 * Resolves a user-supplied path and asserts it lives under an allowed
 * trust root (the repo root, the OS tmp dir, or GitHub Actions'
 * RUNNER_TEMP). Refuses symlinks that escape these roots.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

function allowedRoots(repoRoot: string): string[] {
  const roots = [repoRoot, tmpdir()];
  if (process.env.RUNNER_TEMP) roots.push(process.env.RUNNER_TEMP);
  // macOS workflows and shell scripts commonly write to /tmp explicitly,
  // but `os.tmpdir()` returns `/var/folders/.../T` there. Allow `/tmp`
  // (and its realpath, which resolves to /private/tmp on macOS) so the
  // documented `/tmp/issue-body.txt` UX works across Linux + macOS.
  if (existsSync('/tmp')) roots.push('/tmp');
  // Canonicalize once; include trailing separator so "/repoX" does not
  // prefix-match "/repo".
  return roots.map((r) => {
    try {
      const real = realpathSync(resolve(r));
      return real.endsWith(sep) ? real : real + sep;
    } catch {
      const fallback = resolve(r);
      return fallback.endsWith(sep) ? fallback : fallback + sep;
    }
  });
}

/**
 * Resolves `userPath` and returns its real (symlink-resolved) absolute
 * form. Throws {@link UnsafePathError} if the resolved path is not
 * under the repo root, the OS tmp dir, or `RUNNER_TEMP`.
 */
export function assertSafeReadPath(userPath: string, repoRoot: string): string {
  const resolved = resolve(userPath);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    // File doesn't exist (yet) — fall back to the resolved form. The
    // subsequent readFileSync will raise ENOENT with a clear message.
    real = resolved;
  }
  const realWithSep = real.endsWith(sep) ? real : real + sep;
  for (const root of allowedRoots(repoRoot)) {
    if (realWithSep.startsWith(root) || real + sep === root) {
      return real;
    }
  }
  throw new UnsafePathError(`refusing to read path outside repo root / tmp dir: ${userPath}`);
}
