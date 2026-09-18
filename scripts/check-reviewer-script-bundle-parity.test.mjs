/**
 * Tests for the reviewer script bundle-parity gate (AISDLC-626).
 *
 * Root cause this gate closes: AISDLC-562/#970 added
 * `scripts/resolve-transcript-task-id.sh` and wired every Bash-capable
 * reviewer `.md` to resolve it via the `${CLAUDE_PLUGIN_ROOT}/scripts/...}`
 * candidate-list idiom, but never copied the script into
 * `ai-sdlc-plugin/scripts/` — the directory that actually ships to
 * adopters. Adopters got `exit 127` and reviewers hard-refused. AISDLC-623
 * fixed that one script with a hand-written parity test; this gate
 * generalizes the assertion so the NEXT new reviewer script (or `.md`
 * reference) is covered automatically, with no per-script hand-wiring.
 *
 * Two halves:
 *   1. Fixture-driven unit tests of the scan+assert logic (hermetic, via
 *      mkdtemp — never a shared /tmp marker path).
 *   2. A live run of the gate against THIS repo's actual
 *      `ai-sdlc-plugin/agents/*.md` + `ai-sdlc-plugin/scripts/`, proving the
 *      gate currently passes (post-AISDLC-623 the resolver IS bundled) and
 *      would have caught the pre-AISDLC-623 state had it existed then.
 *
 * Run with: node --test scripts/check-reviewer-script-bundle-parity.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPluginRootScriptRefs,
  scanReviewerScriptReferences,
  checkReviewerScriptBundleParity,
} from './check-reviewer-script-bundle-parity.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REAL_REPO_ROOT = join(__dirname, '..');

/** Build a throwaway repo skeleton. `files` maps repo-relative path -> content. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-script-bundle-parity-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

describe('extractPluginRootScriptRefs', () => {
  it('extracts a script name referenced via ${CLAUDE_PLUGIN_ROOT}/scripts/...', () => {
    const names = extractPluginRootScriptRefs(
      '[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && CANDIDATES+=("${CLAUDE_PLUGIN_ROOT}/scripts/resolve-transcript-task-id.sh")',
    );
    assert.deepEqual([...names], ['resolve-transcript-task-id.sh']);
  });

  it('extracts a script name referenced via ${CLAUDE_PLUGIN_DIR}/scripts/...', () => {
    const names = extractPluginRootScriptRefs('${CLAUDE_PLUGIN_DIR}/scripts/some-new-script.sh');
    assert.deepEqual([...names], ['some-new-script.sh']);
  });

  it('handles a bash-default-value suffix inside the braces (${VAR:-default})', () => {
    const names = extractPluginRootScriptRefs('${CLAUDE_PLUGIN_ROOT:-/fallback}/scripts/foo.sh');
    assert.deepEqual([...names], ['foo.sh']);
  });

  it('does NOT match a plain scripts/<name>.sh reference with no plugin-root prefix', () => {
    // e.g. developer.md's `scripts/check-backlog-drift-on-push.sh` and
    // rebase-resolver.md's `scripts/check-skip-ci-marker.sh` — dogfood
    // monorepo-only references, deliberately out of scope.
    const names = extractPluginRootScriptRefs('./scripts/check-backlog-drift-on-push.sh');
    assert.deepEqual([...names], []);
  });

  it('deduplicates repeated references to the same script within one file', () => {
    const names = extractPluginRootScriptRefs(
      '${CLAUDE_PLUGIN_ROOT}/scripts/foo.sh\n${CLAUDE_PLUGIN_DIR}/scripts/foo.sh\nscripts/foo.sh',
    );
    assert.deepEqual([...names], ['foo.sh']);
  });

  it('extracts multiple distinct script names from the same source', () => {
    const names = extractPluginRootScriptRefs(
      '${CLAUDE_PLUGIN_ROOT}/scripts/a.sh and ${CLAUDE_PLUGIN_ROOT}/scripts/b.sh',
    );
    assert.deepEqual([...names].sort(), ['a.sh', 'b.sh']);
  });
});

describe('scanReviewerScriptReferences', () => {
  it('maps a script name to every agent .md that references it', () => {
    const root = fixture({
      'ai-sdlc-plugin/agents/code-reviewer.md': '${CLAUDE_PLUGIN_ROOT}/scripts/shared.sh',
      'ai-sdlc-plugin/agents/test-reviewer.md': '${CLAUDE_PLUGIN_DIR}/scripts/shared.sh',
      'ai-sdlc-plugin/agents/developer.md': './scripts/not-plugin-scoped.sh',
    });
    try {
      const refs = scanReviewerScriptReferences(root);
      assert.deepEqual([...refs.keys()], ['shared.sh']);
      assert.deepEqual([...refs.get('shared.sh')].sort(), [
        'ai-sdlc-plugin/agents/code-reviewer.md',
        'ai-sdlc-plugin/agents/test-reviewer.md',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty map when the agents directory does not exist', () => {
    const root = fixture({ 'README.md': 'no agents dir here' });
    try {
      const refs = scanReviewerScriptReferences(root);
      assert.equal(refs.size, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores non-.md files under agents/', () => {
    const root = fixture({
      'ai-sdlc-plugin/agents/code-reviewer.md': 'no script refs here',
      'ai-sdlc-plugin/agents/agents.test.mjs': '${CLAUDE_PLUGIN_ROOT}/scripts/ignored.sh',
    });
    try {
      const refs = scanReviewerScriptReferences(root);
      assert.equal(refs.size, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkReviewerScriptBundleParity — fixture-driven', () => {
  it('passes when the referenced script exists in ai-sdlc-plugin/scripts/', () => {
    const root = fixture({
      'ai-sdlc-plugin/agents/code-reviewer.md': '${CLAUDE_PLUGIN_ROOT}/scripts/present.sh',
      'ai-sdlc-plugin/scripts/present.sh': '#!/usr/bin/env bash\necho hi\n',
    });
    try {
      const result = checkReviewerScriptBundleParity(root);
      assert.equal(result.ok, true);
      assert.deepEqual(result.problems, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('FAILS, naming the missing script and the referencing .md, when the referenced script is not bundled', () => {
    // Reproduces the exact AISDLC-562/#970 root cause: a reviewer .md
    // references a script via the plugin-root idiom, but no copy exists
    // under ai-sdlc-plugin/scripts/.
    const root = fixture({
      'ai-sdlc-plugin/agents/code-reviewer.md':
        '${CLAUDE_PLUGIN_ROOT}/scripts/resolve-transcript-task-id.sh',
    });
    try {
      const result = checkReviewerScriptBundleParity(root);
      assert.equal(result.ok, false);
      assert.equal(result.problems.length, 1);
      assert.match(result.problems[0], /resolve-transcript-task-id\.sh/);
      assert.match(result.problems[0], /ai-sdlc-plugin\/agents\/code-reviewer\.md/);
      assert.match(result.problems[0], /not exist at ai-sdlc-plugin\/scripts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes when both copies exist and are byte-identical', () => {
    const root = fixture({
      'ai-sdlc-plugin/agents/code-reviewer.md': '${CLAUDE_PLUGIN_ROOT}/scripts/dup.sh',
      'scripts/dup.sh': '#!/usr/bin/env bash\necho same\n',
      'ai-sdlc-plugin/scripts/dup.sh': '#!/usr/bin/env bash\necho same\n',
    });
    try {
      const result = checkReviewerScriptBundleParity(root);
      assert.equal(result.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('FAILS when both copies exist but have drifted apart (byte-parity)', () => {
    const root = fixture({
      'ai-sdlc-plugin/agents/code-reviewer.md': '${CLAUDE_PLUGIN_ROOT}/scripts/dup.sh',
      'scripts/dup.sh': '#!/usr/bin/env bash\necho ROOT-VERSION\n',
      'ai-sdlc-plugin/scripts/dup.sh': '#!/usr/bin/env bash\necho PLUGIN-VERSION\n',
    });
    try {
      const result = checkReviewerScriptBundleParity(root);
      assert.equal(result.ok, false);
      assert.equal(result.problems.length, 1);
      assert.match(result.problems[0], /parity drift/);
      assert.match(result.problems[0], /dup\.sh/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not require a root scripts/ copy to exist — bundle-only scripts are fine', () => {
    const root = fixture({
      'ai-sdlc-plugin/agents/code-reviewer.md': '${CLAUDE_PLUGIN_ROOT}/scripts/bundle-only.sh',
      'ai-sdlc-plugin/scripts/bundle-only.sh': '#!/usr/bin/env bash\necho ok\n',
    });
    try {
      const result = checkReviewerScriptBundleParity(root);
      assert.equal(result.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not flag plain scripts/<name>.sh references with no plugin-root prefix (dogfood-only scope)', () => {
    const root = fixture({
      'ai-sdlc-plugin/agents/developer.md': './scripts/check-backlog-drift-on-push.sh',
      // Deliberately no ai-sdlc-plugin/scripts/check-backlog-drift-on-push.sh —
      // this must NOT fail, since developer.md never resolves it via
      // CLAUDE_PLUGIN_ROOT/CLAUDE_PLUGIN_DIR.
    });
    try {
      const result = checkReviewerScriptBundleParity(root);
      assert.equal(result.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names ALL referencing .md files when multiple agents share one missing script', () => {
    const root = fixture({
      'ai-sdlc-plugin/agents/code-reviewer.md': '${CLAUDE_PLUGIN_ROOT}/scripts/shared.sh',
      'ai-sdlc-plugin/agents/test-reviewer.md': '${CLAUDE_PLUGIN_DIR}/scripts/shared.sh',
    });
    try {
      const result = checkReviewerScriptBundleParity(root);
      assert.equal(result.ok, false);
      assert.equal(result.problems.length, 1);
      assert.match(result.problems[0], /code-reviewer\.md/);
      assert.match(result.problems[0], /test-reviewer\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkReviewerScriptBundleParity — live repo (ratchet proof)', () => {
  it('the actual ai-sdlc-plugin/agents/*.md + ai-sdlc-plugin/scripts/ currently satisfy the gate', () => {
    // Post-AISDLC-623, resolve-transcript-task-id.sh IS bundled and
    // byte-identical to its scripts/ counterpart, so this must pass. Had
    // this gate existed pre-AISDLC-623, this exact assertion would have
    // failed with a "missing bundled copy" problem naming
    // resolve-transcript-task-id.sh and every reviewer .md — precisely the
    // AISDLC-562/#970 incident.
    const result = checkReviewerScriptBundleParity(REAL_REPO_ROOT);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
  });
});
