/**
 * Tests for `scripts/resolve-transcript-task-id.sh` — AISDLC-562, updated for
 * the fail-soft-unique regression fix AISDLC-623.
 *
 * The script is the single point of TASK_ID resolution shared by the Bash-
 * capable reviewer subagents (code-reviewer, test-reviewer, and their -codex
 * variants). AISDLC-562 eliminated the silent SHARED 'UNKNOWN' fallback that
 * let unrelated reviewer runs collide on `.ai-sdlc/transcripts/UNKNOWN/` and
 * overwrite each other's evidence — but its hard-refusal-on-missing-
 * attribution over-reached and bricked every reviewer dispatch that isn't
 * routed through `/ai-sdlc execute` (adopter repos, ad-hoc invocations).
 * AISDLC-623 restores fail-SOFT: missing attribution now synthesizes a
 * UNIQUE `UNKNOWN-<reviewer>-<timestamp>-<random>` id and exits 0 so the
 * review proceeds, while a malformed PRESENT id (from `.active-task` or
 * `AI_SDLC_ACTIVE_TASK_ID`) still hard-refuses (genuine misconfiguration).
 *
 * Hermetic: every test runs the script against a mkdtemp'd cwd — never a
 * shared /tmp marker path (AISDLC feedback: shared-tmp pollution incident).
 *
 * Run with: node --test scripts/resolve-transcript-task-id.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'resolve-transcript-task-id.sh');

/** Fresh scratch dir per test — never a shared /tmp marker path. */
function scratchDir() {
  return mkdtempSync(join(tmpdir(), 'ai-sdlc-resolve-transcript-task-id-'));
}

/** Run the script with a clean env (no TASK_ID / AI_SDLC_ACTIVE_TASK_ID bleed from the host). */
function run(cwd, args, extraEnv = {}) {
  const env = { ...process.env };
  delete env.TASK_ID;
  delete env.AI_SDLC_ACTIVE_TASK_ID;
  Object.assign(env, extraEnv);
  return spawnSync('bash', [SCRIPT, ...args], { cwd, env, encoding: 'utf-8' });
}

describe('resolve-transcript-task-id.sh — attribution sources', () => {
  it('resolves from the .active-task sentinel file', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), 'AISDLC-562\n');
      const result = run(dir, ['code-reviewer']);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-562');
      assert.equal(result.stderr, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trims whitespace from the .active-task file content', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), '  AISDLC-562  \n\n');
      const result = run(dir, ['test-reviewer']);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-562');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves from AI_SDLC_ACTIVE_TASK_ID when no sentinel file exists', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['code-reviewer'], { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-999' });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-999');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves from TASK_ID env var, taking precedence over the sentinel file', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), 'AISDLC-100');
      const result = run(dir, ['code-reviewer'], { TASK_ID: 'AISDLC-200' });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-200');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the sentinel file over AI_SDLC_ACTIVE_TASK_ID', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), 'AISDLC-100');
      const result = run(dir, ['code-reviewer'], { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-200' });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-100');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trims whitespace from AI_SDLC_ACTIVE_TASK_ID before resolving', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['code-reviewer'], {
        AI_SDLC_ACTIVE_TASK_ID: '  AISDLC-999  \n',
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-999');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a whitespace-only AI_SDLC_ACTIVE_TASK_ID is treated as unattributable, not as an empty task id (fail-soft, AISDLC-623)', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['code-reviewer'], { AI_SDLC_ACTIVE_TASK_ID: '   \n\t  ' });
      assert.equal(result.status, 0);
      assert.match(result.stdout.trim(), /^UNKNOWN-code-reviewer-/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolve-transcript-task-id.sh — path-safety shape validation (security)', () => {
  it('refuses a task id containing ".." (path traversal)', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), '../../etc/passwd');
      const result = run(dir, ['code-reviewer']);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /unsafe shape/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a task id containing a "/" (directory component)', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), 'AISDLC-562/extra');
      const result = run(dir, ['code-reviewer']);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /unsafe shape/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a task id from AI_SDLC_ACTIVE_TASK_ID that fails the shape check', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['code-reviewer'], { AI_SDLC_ACTIVE_TASK_ID: '..' });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /unsafe shape/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a task id with dots/dashes/underscores in valid positions', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), 'AISDLC-100.5_beta');
      const result = run(dir, ['code-reviewer']);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-100.5_beta');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolve-transcript-task-id.sh — no-sentinel case (fail-soft-unique, AISDLC-623)', () => {
  it('fails SOFT (exit 0) when no attribution source resolves, printing a unique UNKNOWN-<reviewer>-... id', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['code-reviewer']);
      assert.equal(result.status, 0);
      assert.match(result.stdout.trim(), /^UNKNOWN-code-reviewer-[0-9TZ]+-[0-9a-f]+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the synthesized id satisfies the same path-shape guard as a real task id', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['code-reviewer']);
      assert.equal(result.status, 0);
      assert.match(result.stdout.trim(), /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warning names the .active-task sentinel as a remedy', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['test-reviewer']);
      assert.match(result.stderr, /\.active-task/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warning names AI_SDLC_ACTIVE_TASK_ID as a remedy', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['test-reviewer']);
      assert.match(result.stderr, /AI_SDLC_ACTIVE_TASK_ID/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warning and synthesized id both name the calling reviewer', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['security-reviewer-example']);
      assert.match(result.stderr, /security-reviewer-example/);
      assert.match(result.stdout.trim(), /^UNKNOWN-security-reviewer-example-/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never writes a filesystem directory as a side effect (only prints the id — the caller mkdirs)', () => {
    const dir = scratchDir();
    try {
      run(dir, ['code-reviewer']);
      assert.equal(existsSync(join(dir, '.ai-sdlc')), false);
      assert.equal(existsSync(join(dir, 'UNKNOWN')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an empty .active-task file is treated as unattributable, not as an empty task id (fail-soft)', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), '');
      const result = run(dir, ['code-reviewer']);
      assert.equal(result.status, 0);
      assert.match(result.stdout.trim(), /^UNKNOWN-code-reviewer-/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires a reviewer-name argument', () => {
    const dir = scratchDir();
    try {
      const result = spawnSync('bash', [SCRIPT], { cwd: dir, encoding: 'utf-8' });
      assert.notEqual(result.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolve-transcript-task-id.sh — collision case (AC #2, uniqueness preserved under AISDLC-623)', () => {
  it('two concurrent unattributed runs both proceed (exit 0) with DIFFERENT unique ids — neither writes a shared path', () => {
    const dirA = scratchDir();
    const dirB = scratchDir();
    try {
      // Simulate two separate reviewer subagent runs (e.g. against
      // .worktrees/aisdlc-557/ and .worktrees/aisdlc-559/ from the incident
      // report) that both lack a .active-task sentinel.
      const resultA = run(dirA, ['code-reviewer']);
      const resultB = run(dirB, ['test-reviewer']);

      assert.equal(resultA.status, 0);
      assert.equal(resultB.status, 0);
      // Both runs proceed and print a task id, but the ids are UNIQUE per
      // invocation, so a caller that naively did
      // `mkdir -p .ai-sdlc/transcripts/$TASK_ID` right after this script has
      // nothing to collide on — the AISDLC-562 property is preserved by
      // uniqueness, not by refusal.
      assert.notEqual(resultA.stdout.trim(), '');
      assert.notEqual(resultB.stdout.trim(), '');
      assert.notEqual(resultA.stdout.trim(), resultB.stdout.trim());
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('two consecutive unattributed calls for the SAME reviewer in the SAME cwd print DIFFERENT ids', () => {
    const dir = scratchDir();
    try {
      const first = run(dir, ['code-reviewer']);
      const second = run(dir, ['code-reviewer']);
      assert.equal(first.status, 0);
      assert.equal(second.status, 0);
      assert.notEqual(first.stdout.trim(), second.stdout.trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two DIFFERENT attributed runs never resolve to the same task id from different sentinels', () => {
    const dirA = scratchDir();
    const dirB = scratchDir();
    try {
      writeFileSync(join(dirA, '.active-task'), 'AISDLC-557');
      writeFileSync(join(dirB, '.active-task'), 'AISDLC-559');

      const resultA = run(dirA, ['code-reviewer']);
      const resultB = run(dirB, ['code-reviewer']);

      assert.equal(resultA.status, 0);
      assert.equal(resultB.status, 0);
      assert.notEqual(resultA.stdout.trim(), resultB.stdout.trim());
      assert.equal(resultA.stdout.trim(), 'AISDLC-557');
      assert.equal(resultB.stdout.trim(), 'AISDLC-559');
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('a worktree with a sentinel and a sibling worktree without one never fall back to the SAME path', () => {
    const attributed = scratchDir();
    const unattributed = scratchDir();
    try {
      writeFileSync(join(attributed, '.active-task'), 'AISDLC-562');

      const good = run(attributed, ['code-reviewer']);
      const soft = run(unattributed, ['code-reviewer']);

      assert.equal(good.status, 0);
      assert.equal(good.stdout.trim(), 'AISDLC-562');
      // AISDLC-623: the unattributed worktree no longer refuses — it
      // proceeds with a unique unattributed id, distinct from the real one.
      assert.equal(soft.status, 0);
      assert.notEqual(soft.stdout.trim(), '');
      assert.notEqual(soft.stdout.trim(), good.stdout.trim());
    } finally {
      rmSync(attributed, { recursive: true, force: true });
      rmSync(unattributed, { recursive: true, force: true });
    }
  });
});

describe('resolve-transcript-task-id.sh — script hygiene', () => {
  it('is executable', () => {
    // Guards against a chmod regression breaking direct invocation (agents
    // invoke it as `bash scripts/resolve-transcript-task-id.sh ...`, but the
    // executable bit should still be set for direct-invocation callers).
    const result = spawnSync('test', ['-x', SCRIPT]);
    assert.equal(result.status, 0);
  });
});

describe('resolve-transcript-task-id.sh — plugin bundle parity (AISDLC-623)', () => {
  it('the ai-sdlc-plugin/scripts/ copy is byte-identical to this monorepo copy', () => {
    // The reviewer .md files in ai-sdlc-plugin/agents/ resolve this script
    // relative to the PLUGIN install (CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DIR)
    // so it reaches adopter repos — AISDLC-623 root cause #1 was that this
    // bundled copy never existed. Byte-identity (not just "exists") catches
    // an edit to one copy without the other drifting the fail-soft contract
    // apart between the monorepo dogfood path and every adopter install.
    const pluginCopy = join(
      __dirname,
      '..',
      'ai-sdlc-plugin',
      'scripts',
      'resolve-transcript-task-id.sh',
    );
    assert.equal(existsSync(pluginCopy), true, `expected plugin-bundled copy at ${pluginCopy}`);
    const rootContent = readFileSync(SCRIPT, 'utf-8');
    const pluginContent = readFileSync(pluginCopy, 'utf-8');
    assert.equal(pluginContent, rootContent);
  });

  it('the plugin-bundled copy is also executable', () => {
    const pluginCopy = join(
      __dirname,
      '..',
      'ai-sdlc-plugin',
      'scripts',
      'resolve-transcript-task-id.sh',
    );
    const result = spawnSync('test', ['-x', pluginCopy]);
    assert.equal(result.status, 0);
  });
});
