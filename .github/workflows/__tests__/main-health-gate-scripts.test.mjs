/**
 * AISDLC-797: main-health-monitor runs the PR gate scripts against main and
 * pages through the existing [main-health] issue when one fails.
 *
 * Run with: node --test .github/workflows/__tests__/main-health-gate-scripts.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'main-health-monitor.yml'),
  'utf8',
);

/** Text of one top-level job, up to the next top-level job or end of file. */
function job(name) {
  const start = SRC.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} missing`);
  const rest = SRC.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[\w-]+:\n/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('main-health-monitor gate-scripts job (AISDLC-797)', () => {
  const gate = job('gate-scripts');

  it('runs every gate step PRs run', () => {
    assert.match(gate, /backlog-drift@0\.1\.3 check --json > "\$report"/);
    assert.match(gate, /scripts\/is-docs-only-changeset\.mjs/);
    assert.match(gate, /dor-pr-has-violations/);
    assert.match(gate, /node scripts\/check-dark-code\.mjs/);
    assert.match(gate, /scripts\/check-attestation-sign\.test\.mjs/);
  });

  it('never captures tool JSON through a command substitution', () => {
    assert.doesNotMatch(gate, /=\$\(\s*(npx|node|pnpm)[^)]*--json/);
  });

  it('records each gate outcome without fail-fast and fails the job when any failed', () => {
    for (const id of [
      'gate-drift',
      'gate-docs-only',
      'gate-dor',
      'gate-dark-code',
      'gate-patch-id',
    ]) {
      assert.match(gate, new RegExp(`id: ${id}\\n\\s+continue-on-error: true`));
      assert.match(gate, new RegExp(`steps\\.${id}\\.outcome`));
    }
    assert.match(gate, /Determine gate outcome[\s\S]*exit 1/);
  });

  it('feeds the [main-health] alert job', () => {
    const alert = job('alert');
    assert.match(SRC, /needs: \[health-check, gate-scripts\]/);
    assert.match(alert, /if: failure\(\)/);
    assert.match(SRC, /\[main-health\] main is RED/);
  });

  it('fires on every push to main', () => {
    assert.match(SRC, /push:\n\s+branches: \[main\]/);
  });
});
