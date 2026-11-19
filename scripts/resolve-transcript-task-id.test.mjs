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
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
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

describe('resolve-transcript-task-id.sh — no id is ever invented (AISDLC-1334)', () => {
  it('exits non-zero with empty stdout, names cause and fix, and prints no UNKNOWN- id when nothing resolves', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, []);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /no task attribution/);
      assert.match(result.stderr, /Fix:/);
      assert.match(result.stderr, /\.active-task/);
      assert.match(result.stderr, /AI_SDLC_ACTIVE_TASK_ID/);
      assert.doesNotMatch(result.stdout + result.stderr, /UNKNOWN-/);
      assert.equal(existsSync(join(dir, '.ai-sdlc')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an empty .active-task file is unattributable and exits non-zero', () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, '.active-task'), '');
      const result = run(dir, ['code-reviewer']);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a whitespace-only AI_SDLC_ACTIVE_TASK_ID is unattributable and exits non-zero', () => {
    const dir = scratchDir();
    try {
      const result = run(dir, ['code-reviewer'], { AI_SDLC_ACTIVE_TASK_ID: '   \n\t  ' });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolve-transcript-task-id.sh — id and worktree arguments (AISDLC-1334)', () => {
  it('prints the id and exits 0 from a directory with no .active-task, creating no file there', () => {
    const cwd = scratchDir();
    const worktree = scratchDir();
    try {
      writeFileSync(join(worktree, '.active-task'), 'AISDLC-1334\n');
      const result = run(cwd, ['code-reviewer', 'AISDLC-1334', worktree]);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-1334');
      assert.equal(readdirSync(cwd).length, 0, 'the parent directory must stay untouched');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('wins over TASK_ID, the cwd sentinel and AI_SDLC_ACTIVE_TASK_ID', () => {
    const cwd = scratchDir();
    const worktree = scratchDir();
    try {
      writeFileSync(join(cwd, '.active-task'), 'AISDLC-1');
      writeFileSync(join(worktree, '.active-task'), 'AISDLC-1334');
      const result = run(cwd, ['code-reviewer', 'AISDLC-1334', worktree], {
        TASK_ID: 'AISDLC-2',
        AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-3',
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), 'AISDLC-1334');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('refuses a malformed id with a reason', () => {
    const cwd = scratchDir();
    const worktree = scratchDir();
    try {
      for (const bad of ['../evil', 'a/b', '-lead', 'has space']) {
        const result = run(cwd, ['code-reviewer', bad, worktree]);
        assert.notEqual(result.status, 0, bad);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /unsafe or empty shape/);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('refuses a worktree whose .active-task names a different id', () => {
    const cwd = scratchDir();
    const worktree = scratchDir();
    try {
      writeFileSync(join(worktree, '.active-task'), 'AISDLC-999');
      const result = run(cwd, ['code-reviewer', 'AISDLC-1334', worktree]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /names 'AISDLC-999', not 'AISDLC-1334'/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('refuses a missing worktree, a non-directory worktree and a worktree without .active-task', () => {
    const cwd = scratchDir();
    const worktree = scratchDir();
    try {
      for (const wt of ['', join(worktree, 'nope'), worktree]) {
        const result = run(cwd, ['code-reviewer', 'AISDLC-1334', wt]);
        assert.notEqual(result.status, 0, `worktree '${wt}'`);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /Fix:/);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
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
