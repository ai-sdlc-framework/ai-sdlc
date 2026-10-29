/**
 * AISDLC-1088: the shared vitest preset sets a 30 s per-test and hook timeout,
 * and the root test script keeps running packages after a failure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedTestConfig } from '../vitest.shared.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('vitest shared config (AISDLC-1088)', () => {
  it('sets 30 s test and hook timeouts', () => {
    assert.equal(sharedTestConfig.testTimeout, 30000);
    assert.equal(sharedTestConfig.hookTimeout, 30000);
  });

  it('root test script does not bail at the first failing package', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.test, /^pnpm -r --no-bail test /);
  });
});
