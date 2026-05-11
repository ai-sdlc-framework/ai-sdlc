// AISDLC-245 follow-up: keep ai-sdlc-plugin/scripts/check-orchestrator-state.sh
// byte-identical with scripts/check-orchestrator-state.sh.
//
// The script lives in TWO places by design:
//   - scripts/check-orchestrator-state.sh       — repo-root copy (tested at
//     scripts/check-orchestrator-state.test.mjs; what dogfood Step 0 invokes)
//   - ai-sdlc-plugin/scripts/check-orchestrator-state.sh — plugin-bundled
//     copy (what adopters get via /ai-sdlc execute Step 0 — references
//     `$PLUGIN_SCRIPTS_DIR/check-orchestrator-state.sh`)
//
// Without this parity check, a future edit to the repo-root copy would
// silently leave adopters running stale logic until someone ran a manual
// diff. The check is cheap (single readFile + ===) so it runs on every test
// pass.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_COPY = join(here, 'check-orchestrator-state.sh');
const REPO_ROOT_COPY = join(here, '..', '..', 'scripts', 'check-orchestrator-state.sh');

describe('check-orchestrator-state.sh — plugin/repo-root parity', () => {
  it('plugin and repo-root copies are byte-identical', () => {
    const plugin = readFileSync(PLUGIN_COPY, 'utf8');
    const repoRoot = readFileSync(REPO_ROOT_COPY, 'utf8');
    assert.equal(
      plugin,
      repoRoot,
      'check-orchestrator-state.sh diverged. Update both copies in lockstep:\n' +
        `  ${PLUGIN_COPY}\n` +
        `  ${REPO_ROOT_COPY}\n` +
        '(or convert one to a build-time copy of the other if drift continues to bite.)',
    );
  });

  it('plugin copy has the executable bit set (Step 0 invokes via bash but adopters may also call ./)', () => {
    const mode = statSync(PLUGIN_COPY).mode;
    // Owner execute bit. Bitmask 0o100 (S_IXUSR). On Windows checkouts mode
    // bits are stubbed; this assertion is cosmetic there but informative on
    // Linux/macOS CI runners.
    assert.equal(
      (mode & 0o100) !== 0,
      true,
      `${PLUGIN_COPY} is not executable (mode=${(mode & 0o777).toString(8)}). ` +
        'Run: chmod +x "ai-sdlc-plugin/scripts/check-orchestrator-state.sh"',
    );
  });
});
