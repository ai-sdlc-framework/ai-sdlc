/**
 * AISDLC-693 — a worktree installed with scripts disabled has no husky hooks
 * directory, so git runs no gate at all. No file that carries a WORKTREE install
 * command or instruction may contain `--ignore-scripts`.
 *
 * Deliberately NOT scanned: `ai-sdlc-plugin/scripts/install-runtime-deps.sh` and
 * `ai-sdlc-plugin/mcp-server/scripts/regen-shrinkwrap.mjs`. They install the
 * plugin's own runtime dependencies with --ignore-scripts for a documented
 * supply-chain reason (AISDLC-385); they are not worktree installs.
 *
 * Run with: node --test ai-sdlc-plugin/commands/no-ignore-scripts.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const WORKTREE_INSTALL_FILES = [
  'pipeline-cli/src/steps/03-setup-worktree.ts',
  'pipeline-cli/src/steps/hooks-check.ts',
  'ai-sdlc-plugin/commands/execute.md',
  'ai-sdlc-plugin/commands/executor.md',
  'ai-sdlc-plugin/commands/dispatch-worker.md',
  'ai-sdlc-plugin/agents/developer.md',
];

describe('worktree install never disables scripts', () => {
  for (const rel of WORKTREE_INSTALL_FILES) {
    it(`${rel} does not contain --ignore-scripts`, () => {
      const text = readFileSync(join(repoRoot, rel), 'utf-8');
      assert.equal(text.includes('--ignore-scripts'), false);
    });
  }
});

describe('node version pin (AISDLC-693)', () => {
  it('.nvmrc satisfies root engines.node', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
    const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines.node);
    assert.ok(floor, `engines.node must be a >=x.y.z floor, got ${pkg.engines.node}`);
    const pin = /^v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(readFileSync(join(repoRoot, '.nvmrc'), 'utf-8'));
    assert.ok(pin, '.nvmrc must pin an exact x.y.z version');
    const a = pin.slice(1).map(Number);
    const b = floor.slice(1).map(Number);
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    assert.ok(cmp >= 0, `.nvmrc ${a.join('.')} is below engines floor ${b.join('.')}`);
  });
});
