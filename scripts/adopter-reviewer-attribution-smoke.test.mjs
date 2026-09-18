/**
 * Adopter-environment reviewer-attribution smoke test — AISDLC-625.
 *
 * Root cause this guards against (AISDLC-562 / #970 regression): the
 * reviewer subagents' Step 0 transcript-attribution resolver HARD-REFUSED
 * every review when no task attribution could be resolved. In the AI-SDLC
 * monorepo this branch is NEVER exercised — the resolver script lives at
 * repo root (`scripts/resolve-transcript-task-id.sh`) and `/ai-sdlc execute`
 * always writes a `.active-task` sentinel before dispatching reviewers — so
 * CI here stayed green while every adopter/consumer repo (no monorepo
 * script, no `.active-task`, no `AI_SDLC_ACTIVE_TASK_ID`) bricked at Step 0:
 * every reviewer refused before reading the diff, no attestation could be
 * produced, nothing could ever merge. AISDLC-623 fixed the behavior (fail
 * SOFT to a unique `UNKNOWN-<reviewer>-...` id instead of refusing, and
 * bundled the resolver into `ai-sdlc-plugin/scripts/` so it actually reaches
 * an adopter's plugin install). This test reproduces the exact adopter
 * topology `resolve-transcript-task-id.test.mjs` cannot: a cwd with none of
 * the three monorepo-only attribution signals, resolving the script the way
 * an adopter's plugin install would (via `$CLAUDE_PLUGIN_ROOT`), so a future
 * regression of this class fails THIS CI instead of an adopter's pipeline.
 *
 * Hermetic: every test runs against a mkdtemp'd "consumer repo" dir — never
 * a shared /tmp marker path (AISDLC feedback: shared-tmp pollution incident).
 *
 * Run with: node --test scripts/adopter-reviewer-attribution-smoke.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'ai-sdlc-plugin');
const PLUGIN_RESOLVER = join(PLUGIN_ROOT, 'scripts', 'resolve-transcript-task-id.sh');

/** Fresh "consumer repo" dir per test — mkdtemp only, never a shared path. */
function consumerRepoDir() {
  return mkdtempSync(join(tmpdir(), 'ai-sdlc-625-adopter-consumer-repo-'));
}

/**
 * Build the adopter/consumer environment: no `.active-task`, no
 * `AI_SDLC_ACTIVE_TASK_ID`, and (implicitly, via a fresh mkdtemp dir with no
 * `scripts/` subdir) no monorepo-relative resolver script — exactly the
 * condition #970 got wrong. `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DIR` are set
 * the way an adopter's plugin install would set them.
 */
function adopterEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.TASK_ID;
  delete env.AI_SDLC_ACTIVE_TASK_ID;
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CLAUDE_PLUGIN_DIR;
  return { ...env, ...overrides };
}

/**
 * Reproduces the exact CANDIDATES resolution chain from the reviewer `.md`
 * Step 0 bash block (ai-sdlc-plugin/agents/code-reviewer.md and siblings):
 * prefer $CLAUDE_PLUGIN_ROOT, then $CLAUDE_PLUGIN_DIR, then the
 * monorepo-relative `scripts/` path, first candidate that exists on disk
 * wins. Runs the resolved script and prints only its resolved path (or
 * nothing if none resolved), so the test can assert on the resolution
 * outcome directly without needing to extract/execute the full agent `.md`
 * bash block (which also does transcript bookkeeping not relevant here).
 */
const CANDIDATE_RESOLUTION_SNIPPET = `
CANDIDATES=()
[ -n "\${CLAUDE_PLUGIN_ROOT:-}" ] && CANDIDATES+=("\${CLAUDE_PLUGIN_ROOT}/scripts/resolve-transcript-task-id.sh")
[ -n "\${CLAUDE_PLUGIN_DIR:-}" ] && CANDIDATES+=("\${CLAUDE_PLUGIN_DIR}/scripts/resolve-transcript-task-id.sh")
CANDIDATES+=("scripts/resolve-transcript-task-id.sh")
RESOLVE_SCRIPT=""
for candidate in "\${CANDIDATES[@]}"; do
  if [ -f "$candidate" ]; then
    RESOLVE_SCRIPT="$candidate"
    break
  fi
done
printf '%s' "$RESOLVE_SCRIPT"
`;

function resolveCandidateScript(cwd, env) {
  return spawnSync('bash', ['-c', CANDIDATE_RESOLUTION_SNIPPET], { cwd, env, encoding: 'utf-8' });
}

describe('AISDLC-625 — adopter-environment reviewer attribution smoke test', () => {
  it('the bundled plugin resolver exists and is executable (AISDLC-623 root cause #1)', () => {
    assert.equal(
      existsSync(PLUGIN_RESOLVER),
      true,
      `expected the plugin-bundled resolver at ${PLUGIN_RESOLVER} — its absence is the exact AISDLC-623 root cause: the monorepo-only script never reached adopter installs`,
    );
    const result = spawnSync('test', ['-x', PLUGIN_RESOLVER]);
    assert.equal(result.status, 0, 'plugin-bundled resolver must be executable');
  });

  it('a no-attribution consumer repo, invoking the BUNDLED resolver via $CLAUDE_PLUGIN_ROOT, fails SOFT (exit 0) with a unique UNKNOWN id — not exit 1/127, not a refusal', () => {
    const consumerDir = consumerRepoDir();
    try {
      // Adopter topology: no .active-task, no AI_SDLC_ACTIVE_TASK_ID, and
      // (mkdtemp'd dir has no scripts/ subdir) no monorepo-relative script
      // either — only the plugin-bundled copy, reached the way an adopter's
      // plugin install exposes it.
      const env = adopterEnv({ CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
      const result = spawnSync('bash', [PLUGIN_RESOLVER, 'code-reviewer'], {
        cwd: consumerDir,
        env,
        encoding: 'utf-8',
      });

      // The #970 regression: this used to be status 1, stdout '', a
      // refusal on stderr. AISDLC-623 restores fail-soft — assert the
      // restored contract explicitly, not just "didn't crash".
      assert.equal(
        result.status,
        0,
        `resolver must exit 0 in an adopter/consumer environment (fail-soft, AISDLC-623), got status=${result.status} stderr=${result.stderr}`,
      );
      const id = result.stdout.trim();
      assert.match(
        id,
        /^UNKNOWN-code-reviewer-[0-9TZ]+-[0-9a-f]+-[0-9]+$/,
        `expected a unique synthesized UNKNOWN-code-reviewer-... id, got '${id}'`,
      );
      // Must also satisfy the transcript-directory path-shape guard the
      // caller applies before mkdir -p .ai-sdlc/transcripts/<id>.
      assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    } finally {
      rmSync(consumerDir, { recursive: true, force: true });
    }
  });

  it('two separate no-attribution runs of the SAME reviewer never resolve to the same transcript id (the AISDLC-562 no-collision property, preserved under fail-soft)', () => {
    // Use the SAME reviewer name for BOTH runs: the reviewer name is embedded
    // in the synthesized id, so passing different names would make the ids
    // differ trivially without exercising the timestamp/random/pid uniqueness
    // logic at all. Same name means the ids can ONLY differ via that
    // uniqueness suffix — which is exactly the AISDLC-562 no-collision property
    // (two concurrent unattributed runs of the same reviewer type).
    const dirA = consumerRepoDir();
    const dirB = consumerRepoDir();
    try {
      const env = adopterEnv({ CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
      const a = spawnSync('bash', [PLUGIN_RESOLVER, 'code-reviewer'], {
        cwd: dirA,
        env,
        encoding: 'utf-8',
      });
      const b = spawnSync('bash', [PLUGIN_RESOLVER, 'code-reviewer'], {
        cwd: dirB,
        env,
        encoding: 'utf-8',
      });
      assert.equal(a.status, 0);
      assert.equal(b.status, 0);
      assert.notEqual(a.stdout.trim(), '');
      assert.notEqual(b.stdout.trim(), '');
      assert.notEqual(a.stdout.trim(), b.stdout.trim());
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('the reviewer .md Step 0 CANDIDATES resolution chain picks the plugin-bundled script when only $CLAUDE_PLUGIN_ROOT is set (AISDLC-623 root cause #2: hardcoded repo-root path)', () => {
    // This asserts the resolution-CHAIN logic itself (lifted verbatim from
    // ai-sdlc-plugin/agents/code-reviewer.md's Step 0 bash block), run
    // against a consumer-repo cwd that has no monorepo-relative
    // `scripts/resolve-transcript-task-id.sh` at all. Extracting and
    // executing the full agent `.md` bash block (which also does
    // transcript-file bookkeeping unrelated to attribution) was judged too
    // fiddly for a hermetic gate per the task scope note — this covers the
    // resolution-chain logic directly, which is the part AISDLC-623 fixed.
    const consumerDir = consumerRepoDir();
    try {
      const env = adopterEnv({ CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT });
      const result = resolveCandidateScript(consumerDir, env);
      assert.equal(result.status, 0);
      assert.equal(
        result.stdout.trim(),
        PLUGIN_RESOLVER,
        'the CANDIDATES chain must resolve to the plugin-bundled script when $CLAUDE_PLUGIN_ROOT is the only signal present and no monorepo-relative scripts/ dir exists in cwd',
      );
    } finally {
      rmSync(consumerDir, { recursive: true, force: true });
    }
  });

  it('the CANDIDATES resolution chain falls back to $CLAUDE_PLUGIN_DIR when $CLAUDE_PLUGIN_ROOT is unset', () => {
    const consumerDir = consumerRepoDir();
    try {
      const env = adopterEnv({ CLAUDE_PLUGIN_DIR: PLUGIN_ROOT });
      const result = resolveCandidateScript(consumerDir, env);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), PLUGIN_RESOLVER);
    } finally {
      rmSync(consumerDir, { recursive: true, force: true });
    }
  });

  it('the CANDIDATES resolution chain resolves to NOTHING when neither plugin env var is set and no monorepo-relative script exists in cwd (the pre-AISDLC-623 adopter dead end)', () => {
    const consumerDir = consumerRepoDir();
    try {
      const env = adopterEnv();
      const result = resolveCandidateScript(consumerDir, env);
      assert.equal(result.status, 0);
      assert.equal(
        result.stdout.trim(),
        '',
        'with no plugin env vars and no monorepo-relative script, the chain correctly resolves nothing — this is the case the .md Step 0 fallback branch (inline unique-id synthesis) exists to cover',
      );
    } finally {
      rmSync(consumerDir, { recursive: true, force: true });
    }
  });
});
