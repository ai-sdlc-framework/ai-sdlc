/**
 * Tests for the AI-SDLC plugin enforce-blocked-actions hook.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs
 * Uses Node.js built-in test runner (no Vitest needed).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = join(__dirname, 'enforce-blocked-actions.js');

// Create a temp project dir with agent-role.yaml containing blocked actions/paths.
let tempDir;
let siblingDir;

before(() => {
  tempDir = join(tmpdir(), `enforce-blocked-test-${Date.now()}`);
  siblingDir = join(tmpdir(), `enforce-blocked-sibling-${Date.now()}`);
  const aiSdlcDir = join(tempDir, '.ai-sdlc');
  const tasksDir = join(tempDir, 'backlog', 'tasks');
  mkdirSync(aiSdlcDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(
    join(aiSdlcDir, 'agent-role.yaml'),
    `role: coding-agent
goal: Test agent
blockedPaths:
  - '.github/workflows/**'
  - '.ai-sdlc/**'
blockedActions:
  - 'gh pr merge*'
  - 'git merge*'
  - 'git push --force*'
  - 'git push -f*'
  - 'gh pr close*'
  - 'gh issue close*'
  - 'git branch -D*'
  - 'git reset --hard*'
`,
  );

  // A task file with permittedExternalPaths pointing at the sibling dir
  // (relative path that resolves up out of the project root).
  const siblingRelative = '../' + siblingDir.split('/').pop();
  writeFileSync(
    join(tasksDir, 'aisdlc-99 - test-task.md'),
    `---
id: AISDLC-99
title: Test task
permittedExternalPaths:
  - '${siblingRelative}'
---

Body.
`,
  );
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(siblingDir, { recursive: true, force: true });
});

function runHook(command) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  return runHookRaw(input);
}

function runHookFile(toolName, file_path, env = {}, cwd) {
  const payload = { tool_name: toolName, tool_input: { file_path } };
  if (cwd) payload.cwd = cwd;
  const input = JSON.stringify(payload);
  return runHookRaw(input, env);
}

function runHookRaw(input, extraEnv = {}) {
  try {
    const output = execFileSync('node', [hookScript], {
      input,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tempDir, ...extraEnv },
      timeout: 5000,
    });
    return { output: output.trim(), exitCode: 0 };
  } catch (err) {
    return { output: err.stdout?.trim() || '', exitCode: err.status };
  }
}

function isDenied(result) {
  if (!result.output) return false;
  try {
    const parsed = JSON.parse(result.output);
    return parsed.hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

describe('ai-sdlc-plugin enforce-blocked-actions hook', () => {
  it('blocks gh pr merge', () => {
    const result = runHook('gh pr merge 42');
    assert.ok(isDenied(result), 'should deny gh pr merge');
  });

  it('allows git push origin feature (non-force)', () => {
    const result = runHook('git push origin feature');
    assert.ok(!isDenied(result), 'should allow regular git push');
    assert.equal(result.output, '', 'should produce no output');
  });

  it('blocks force push', () => {
    const result = runHook('git push --force origin main');
    assert.ok(isDenied(result), 'should deny force push');
  });

  it('blocks git push -f', () => {
    const result = runHook('git push -f origin main');
    assert.ok(isDenied(result), 'should deny -f push');
  });

  it('allows empty command', () => {
    const result = runHook('');
    assert.ok(!isDenied(result), 'should allow empty command');
    assert.equal(result.output, '', 'should produce no output');
  });

  it('handles invalid JSON input gracefully (fail-safe allows)', () => {
    try {
      const output = execFileSync('node', [hookScript], {
        input: 'not valid json at all',
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tempDir },
        timeout: 5000,
      });
      assert.equal(output.trim(), '', 'should produce no output (allow)');
    } catch (err) {
      // Exit code 0 is expected; if it threw, the test still passes
      // as long as no deny output was produced
      assert.equal(err.stdout?.trim() || '', '');
    }
  });

  it('blocks git reset --hard', () => {
    const result = runHook('git reset --hard HEAD~1');
    assert.ok(isDenied(result), 'should deny git reset --hard');
  });

  it('allows gh pr create', () => {
    const result = runHook('gh pr create --title "test"');
    assert.ok(!isDenied(result), 'should allow gh pr create');
  });

  it('deny output includes reason with the matched pattern', () => {
    const result = runHook('gh pr merge 42 --squash');
    assert.ok(result.output, 'should have output');
    const parsed = JSON.parse(result.output);
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes('gh pr merge'),
      'reason should mention the blocked pattern',
    );
  });
});

describe('ai-sdlc-plugin enforce-blocked-actions hook (Write/Edit)', () => {
  it('blocks Write to .ai-sdlc/foo.yaml (matches .ai-sdlc/** glob)', () => {
    const result = runHookFile('Write', join(tempDir, '.ai-sdlc', 'foo.yaml'));
    assert.ok(isDenied(result), 'should deny write under .ai-sdlc/');
  });

  it('blocks Edit to .github/workflows/ci.yml (matches .github/workflows/** glob)', () => {
    const result = runHookFile('Edit', join(tempDir, '.github', 'workflows', 'ci.yml'));
    assert.ok(isDenied(result), 'should deny edit under .github/workflows/');
  });

  it('blocks Write to nested .ai-sdlc/sub/dir/file (recursive glob match)', () => {
    const result = runHookFile('Write', join(tempDir, '.ai-sdlc', 'sub', 'dir', 'file.md'));
    assert.ok(isDenied(result), 'should deny nested write under .ai-sdlc/');
  });

  it('allows Write to src/foo.ts (not in any blockedPaths glob)', () => {
    const result = runHookFile('Write', join(tempDir, 'src', 'foo.ts'));
    assert.ok(!isDenied(result), 'should allow write under src/');
    assert.equal(result.output, '', 'no output');
  });

  it('allows Edit to README.md at the project root', () => {
    const result = runHookFile('Edit', join(tempDir, 'README.md'));
    assert.ok(!isDenied(result), 'should allow edit at project root');
  });

  it('blocks Write outside the project root when no AI_SDLC_ACTIVE_TASK_ID is set', () => {
    const result = runHookFile('Write', join(siblingDir, 'foo.txt'));
    assert.ok(isDenied(result), 'should deny external write without active task');
    const parsed = JSON.parse(result.output);
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes('outside the project root'),
      'reason should mention outside project root',
    );
  });

  it('blocks Write outside the project root when active task does not list the path', () => {
    const otherSibling = join(tmpdir(), 'some-other-dir');
    const result = runHookFile('Write', join(otherSibling, 'foo.txt'), {
      AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-99',
    });
    assert.ok(isDenied(result), 'should deny path not in permittedExternalPaths');
  });

  it('allows Write outside the project root when path is in permittedExternalPaths', () => {
    const result = runHookFile('Write', join(siblingDir, 'allowed.txt'), {
      AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-99',
    });
    assert.ok(!isDenied(result), 'should allow write under permittedExternalPaths');
  });

  it('allows nested Write under permittedExternalPaths', () => {
    const result = runHookFile('Write', join(siblingDir, 'sub', 'nested.txt'), {
      AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-99',
    });
    assert.ok(!isDenied(result), 'should allow nested write under permittedExternalPaths');
  });

  it('handles missing file_path gracefully (allows)', () => {
    const result = runHookFile('Write', '');
    assert.ok(!isDenied(result), 'should not deny on empty file_path');
  });

  it('treats non-existent active task ID as no permittedExternalPaths', () => {
    const result = runHookFile('Write', join(siblingDir, 'foo.txt'), {
      AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-9999',
    });
    assert.ok(isDenied(result), 'should deny when task ID is not found');
  });

  it('reads active task from .worktrees/.active-task sentinel file (preferred over env)', () => {
    // Slash command writes this sentinel at start of /ai-sdlc execute.
    // The env-var path is a fallback; the file is the canonical source of truth.
    const sentinelDir = join(tempDir, '.worktrees');
    const sentinelPath = join(sentinelDir, '.active-task');
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(sentinelPath, 'AISDLC-99\n');
    try {
      const result = runHookFile('Write', join(siblingDir, 'allowed.txt'));
      assert.ok(!isDenied(result), 'should allow when sentinel file points at AISDLC-99');
    } finally {
      rmSync(sentinelPath, { force: true });
      rmSync(sentinelDir, { recursive: true, force: true });
    }
  });

  it('sentinel file takes precedence over env var when both set', () => {
    const sentinelDir = join(tempDir, '.worktrees');
    const sentinelPath = join(sentinelDir, '.active-task');
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(sentinelPath, 'AISDLC-99\n');
    try {
      // env var points at a non-existent task; sentinel points at the real one
      const result = runHookFile('Write', join(siblingDir, 'allowed.txt'), {
        AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-9999',
      });
      assert.ok(!isDenied(result), 'sentinel wins over env var');
    } finally {
      rmSync(sentinelPath, { force: true });
      rmSync(sentinelDir, { recursive: true, force: true });
    }
  });

  it('falls back to env var when sentinel file is missing', () => {
    const result = runHookFile('Write', join(siblingDir, 'allowed.txt'), {
      AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-99',
    });
    assert.ok(!isDenied(result), 'env var fallback works for tests / external tooling');
  });

  it('handles empty sentinel file gracefully (treats as no active task)', () => {
    const sentinelDir = join(tempDir, '.worktrees');
    const sentinelPath = join(sentinelDir, '.active-task');
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(sentinelPath, '');
    try {
      const result = runHookFile('Write', join(siblingDir, 'foo.txt'));
      assert.ok(isDenied(result), 'empty sentinel = no allowlist = deny');
    } finally {
      rmSync(sentinelPath, { force: true });
      rmSync(sentinelDir, { recursive: true, force: true });
    }
  });

  it('does not block Bash tools when toolName is Write/Edit (no cross-tool leakage)', () => {
    // Even with a Bash command in tool_input, if tool_name is Write the Bash
    // blocked-actions logic should NOT fire (only file_path enforcement applies).
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { command: 'gh pr merge 42', file_path: join(tempDir, 'src', 'foo.ts') },
    });
    const result = runHookRaw(input);
    assert.ok(!isDenied(result), 'should not apply Bash rules to Write tool');
  });
});

// ── Per-worktree sentinel resolution (AISDLC-81) ────────────────────
//
// The single project-level sentinel can't support parallel /ai-sdlc execute
// runs. The hook now walks up from the tool's cwd to find a per-worktree
// sentinel `<projectRoot>/.worktrees/<id>/.active-task`. Project-level
// sentinel is kept as a fallback for one release for backwards compat.

describe('ai-sdlc-plugin enforce-blocked-actions hook (per-worktree sentinel, AISDLC-81)', () => {
  // Build TWO synthetic worktrees, each with its OWN active-task sentinel,
  // each pointing at a DIFFERENT task with DIFFERENT permittedExternalPaths.
  // The regression scenario: parallel runs must each get the right allowlist.
  let parTempDir;
  let siblingA;
  let siblingB;
  let worktreeA;
  let worktreeB;

  before(() => {
    parTempDir = join(tmpdir(), `enforce-blocked-parallel-${Date.now()}`);
    siblingA = join(tmpdir(), `enforce-blocked-sibling-a-${Date.now()}`);
    siblingB = join(tmpdir(), `enforce-blocked-sibling-b-${Date.now()}`);

    const aiSdlcDir = join(parTempDir, '.ai-sdlc');
    const tasksDir = join(parTempDir, 'backlog', 'tasks');
    worktreeA = join(parTempDir, '.worktrees', 'aisdlc-100');
    worktreeB = join(parTempDir, '.worktrees', 'aisdlc-101');

    mkdirSync(aiSdlcDir, { recursive: true });
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(siblingA, { recursive: true });
    mkdirSync(siblingB, { recursive: true });
    mkdirSync(worktreeA, { recursive: true });
    mkdirSync(worktreeB, { recursive: true });
    mkdirSync(join(worktreeA, 'src'), { recursive: true });

    writeFileSync(
      join(aiSdlcDir, 'agent-role.yaml'),
      `role: coding-agent
goal: Test agent
blockedPaths:
  - '.github/workflows/**'
  - '.ai-sdlc/**'
blockedActions: []
`,
    );

    // Two task files, each pointing at a DIFFERENT sibling.
    const siblingARelative = '../' + siblingA.split('/').pop();
    const siblingBRelative = '../' + siblingB.split('/').pop();

    writeFileSync(
      join(tasksDir, 'aisdlc-100 - task-a.md'),
      `---
id: AISDLC-100
title: Task A
permittedExternalPaths:
  - '${siblingARelative}'
---

Body A.
`,
    );
    writeFileSync(
      join(tasksDir, 'aisdlc-101 - task-b.md'),
      `---
id: AISDLC-101
title: Task B
permittedExternalPaths:
  - '${siblingBRelative}'
---

Body B.
`,
    );

    // Write each worktree's per-worktree sentinel.
    writeFileSync(join(worktreeA, '.active-task'), 'AISDLC-100\n');
    writeFileSync(join(worktreeB, '.active-task'), 'AISDLC-101\n');
  });

  after(() => {
    rmSync(parTempDir, { recursive: true, force: true });
    rmSync(siblingA, { recursive: true, force: true });
    rmSync(siblingB, { recursive: true, force: true });
  });

  function runWith({ file_path, cwd, env = {} }) {
    const payload = { tool_name: 'Write', tool_input: { file_path }, cwd };
    return runHookRaw(JSON.stringify(payload), {
      ...env,
      CLAUDE_PROJECT_DIR: parTempDir,
    });
  }

  it('worktree A active task (cwd inside worktreeA) allows write to siblingA', () => {
    const result = runWith({
      file_path: join(siblingA, 'foo.txt'),
      cwd: worktreeA,
    });
    assert.ok(!isDenied(result), 'siblingA is in AISDLC-100 allowlist');
  });

  it('worktree A active task (cwd inside worktreeA) DENIES write to siblingB', () => {
    const result = runWith({
      file_path: join(siblingB, 'foo.txt'),
      cwd: worktreeA,
    });
    assert.ok(isDenied(result), 'siblingB is NOT in AISDLC-100 allowlist');
  });

  it('worktree B active task (cwd inside worktreeB) allows write to siblingB', () => {
    const result = runWith({
      file_path: join(siblingB, 'foo.txt'),
      cwd: worktreeB,
    });
    assert.ok(!isDenied(result), 'siblingB is in AISDLC-101 allowlist');
  });

  it('worktree B active task (cwd inside worktreeB) DENIES write to siblingA', () => {
    const result = runWith({
      file_path: join(siblingA, 'foo.txt'),
      cwd: worktreeB,
    });
    assert.ok(isDenied(result), 'siblingA is NOT in AISDLC-101 allowlist');
  });

  it('cwd nested DEEP inside worktreeA still resolves the right sentinel', () => {
    // A subagent often does a real Edit inside a nested package directory; the
    // hook walks up to find the worktree's sentinel.
    const deepCwd = join(worktreeA, 'src', 'lib', 'inner');
    mkdirSync(deepCwd, { recursive: true });
    const result = runWith({
      file_path: join(siblingA, 'foo.txt'),
      cwd: deepCwd,
    });
    assert.ok(!isDenied(result), 'deep cwd still resolves to AISDLC-100 sentinel');
  });

  it('falls back to project-level sentinel when cwd is outside any worktree', () => {
    // Write a project-level sentinel pointing at AISDLC-100.
    const projectSentinelDir = join(parTempDir, '.worktrees');
    const projectSentinelPath = join(projectSentinelDir, '.active-task');
    writeFileSync(projectSentinelPath, 'AISDLC-100\n');
    try {
      // cwd is the project root itself (NOT inside any .worktrees/<id>).
      const result = runWith({
        file_path: join(siblingA, 'foo.txt'),
        cwd: parTempDir,
      });
      assert.ok(
        !isDenied(result),
        'project-level sentinel fallback should grant the legacy AISDLC-100 allowlist',
      );
    } finally {
      rmSync(projectSentinelPath, { force: true });
    }
  });

  it('per-worktree sentinel takes precedence over project-level sentinel', () => {
    // worktreeA sentinel says AISDLC-100 (siblingA OK, siblingB blocked).
    // Project-level sentinel claims AISDLC-101 (would allow siblingB).
    // The per-worktree value MUST win.
    const projectSentinelDir = join(parTempDir, '.worktrees');
    const projectSentinelPath = join(projectSentinelDir, '.active-task');
    writeFileSync(projectSentinelPath, 'AISDLC-101\n');
    try {
      const result = runWith({
        file_path: join(siblingB, 'foo.txt'),
        cwd: worktreeA,
      });
      assert.ok(
        isDenied(result),
        'per-worktree sentinel (AISDLC-100) wins over project-level (AISDLC-101); siblingB still blocked',
      );
    } finally {
      rmSync(projectSentinelPath, { force: true });
    }
  });

  it('falls back to env var when neither per-worktree nor project-level sentinel exists', () => {
    // Use the original test fixture's env var fallback against a worktree
    // path that has no per-worktree sentinel and no project-level sentinel.
    const orphanWorktree = join(parTempDir, '.worktrees', 'aisdlc-200-orphan');
    mkdirSync(orphanWorktree, { recursive: true });
    try {
      const result = runWith({
        file_path: join(siblingA, 'foo.txt'),
        cwd: orphanWorktree,
        env: { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-100' },
      });
      assert.ok(!isDenied(result), 'env var fallback supplies AISDLC-100 allowlist');
    } finally {
      rmSync(orphanWorktree, { recursive: true, force: true });
    }
  });

  it('REGRESSION: two parallel worktrees with different active tasks resolve independently', () => {
    // The crux of AISDLC-81: simulate two interleaved tool calls from two
    // different /ai-sdlc execute runs, both in flight simultaneously. Each
    // must get the correct allowlist, even though they share the project root.
    const aIntoA = runWith({ file_path: join(siblingA, 'a1.txt'), cwd: worktreeA });
    const aIntoB = runWith({ file_path: join(siblingB, 'a2.txt'), cwd: worktreeA });
    const bIntoA = runWith({ file_path: join(siblingA, 'b1.txt'), cwd: worktreeB });
    const bIntoB = runWith({ file_path: join(siblingB, 'b2.txt'), cwd: worktreeB });

    assert.ok(!isDenied(aIntoA), 'A→siblingA allowed (A is AISDLC-100)');
    assert.ok(isDenied(aIntoB), 'A→siblingB denied (B not in AISDLC-100 allowlist)');
    assert.ok(isDenied(bIntoA), 'B→siblingA denied (A not in AISDLC-101 allowlist)');
    assert.ok(!isDenied(bIntoB), 'B→siblingB allowed (B is AISDLC-101)');
  });

  it('handles missing per-worktree sentinel by falling through (no crash)', () => {
    // A worktree directory exists but its sentinel does not — should fall
    // through to project-level / env, not crash.
    const sentinelLessWorktree = join(parTempDir, '.worktrees', 'aisdlc-300-no-sentinel');
    mkdirSync(sentinelLessWorktree, { recursive: true });
    try {
      const result = runWith({
        file_path: join(siblingA, 'foo.txt'),
        cwd: sentinelLessWorktree,
      });
      // No allowlist anywhere => deny, but NOT crash.
      assert.ok(isDenied(result), 'no allowlist source => deny');
    } finally {
      rmSync(sentinelLessWorktree, { recursive: true, force: true });
    }
  });
});
