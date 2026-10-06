/**
 * Tests for the AI-SDLC plugin enforce-blocked-actions hook.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs
 * Uses Node.js built-in test runner (no Vitest needed).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
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
      env: { ...process.env, GITHUB_ACTIONS: '', CLAUDE_PROJECT_DIR: tempDir, ...extraEnv },
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
        env: { ...process.env, GITHUB_ACTIONS: '', CLAUDE_PROJECT_DIR: tempDir },
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
      parsed.hookSpecificOutput.permissionDecisionReason.includes(
        "outside the agent's active worktree/project root",
      ),
      'reason should mention outside worktree/project root',
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

// ── AISDLC-567 Part A — .github/workflows/** is project-configurable ────

describe('ai-sdlc-plugin enforce-blocked-actions hook (AISDLC-567 Part A: configurable workflow blocking)', () => {
  let permissiveDir;

  before(() => {
    permissiveDir = join(tmpdir(), `enforce-blocked-permissive-${Date.now()}`);
    mkdirSync(join(permissiveDir, '.ai-sdlc'), { recursive: true });
    // blockedPaths deliberately omits '.github/workflows/**' — this project
    // opts agents IN to editing its own CI workflows.
    writeFileSync(
      join(permissiveDir, '.ai-sdlc', 'agent-role.yaml'),
      `role: coding-agent
goal: Test agent
blockedPaths:
  - '.ai-sdlc/**'
blockedActions: []
`,
    );
  });

  after(() => {
    rmSync(permissiveDir, { recursive: true, force: true });
  });

  it('allows Edit to .github/workflows/ci.yml when the project does NOT list it in blockedPaths', () => {
    const input = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: join(permissiveDir, '.github', 'workflows', 'ci.yml') },
    });
    const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: permissiveDir });
    assert.ok(!isDenied(result), 'should allow workflow edit when not in blockedPaths');
  });

  it('still refuses .ai-sdlc/** even though this project only lists it (not workflows)', () => {
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(permissiveDir, '.ai-sdlc', 'agent-role.yaml') },
    });
    const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: permissiveDir });
    assert.ok(isDenied(result), 'should deny .ai-sdlc/** regardless');
  });

  it('refuses .github/workflows/** when blockedPaths lists it (existing fixture)', () => {
    // Uses the top-level `tempDir` fixture, whose agent-role.yaml DOES list
    // '.github/workflows/**' under blockedPaths.
    const result = runHookFile('Edit', join(tempDir, '.github', 'workflows', 'ci.yml'));
    assert.ok(isDenied(result), 'should deny when project opts in via blockedPaths');
  });

  it('AISDLC-720: .ai-sdlc/** is editable by an internal session when agent-role.yaml is entirely missing', () => {
    const noConfigDir = join(tmpdir(), `enforce-blocked-noconfig-${Date.now()}`);
    mkdirSync(noConfigDir, { recursive: true });
    try {
      const input = JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: join(noConfigDir, '.ai-sdlc', 'foo.yaml') },
      });
      const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: noConfigDir });
      assert.ok(!isDenied(result), 'no hardcoded .ai-sdlc/** floor for internal sessions');
    } finally {
      rmSync(noConfigDir, { recursive: true, force: true });
    }
  });

  it('.github/workflows/** is editable when agent-role.yaml is entirely missing (not blocked by default)', () => {
    const noConfigDir = join(tmpdir(), `enforce-blocked-noconfig2-${Date.now()}`);
    mkdirSync(noConfigDir, { recursive: true });
    try {
      const input = JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: join(noConfigDir, '.github', 'workflows', 'ci.yml') },
      });
      const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: noConfigDir });
      assert.ok(!isDenied(result), 'no config => no workflow ban by default');
    } finally {
      rmSync(noConfigDir, { recursive: true, force: true });
    }
  });

  it('refuses a mixed-case .AI-SDLC/agent-role.yaml write (case-insensitive filesystem bypass regression)', () => {
    // On case-insensitive filesystems (macOS, Windows) `.AI-SDLC/agent-role.yaml`
    // resolves to the SAME real file as `.ai-sdlc/agent-role.yaml`. The hardcoded
    // floor must not be bypassable by case alone — matchGlob() must match
    // case-insensitively (mirrors enforceBash()'s `i` flag).
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(tempDir, '.AI-SDLC', 'agent-role.yaml') },
    });
    const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: tempDir });
    assert.ok(
      isDenied(result),
      'mixed-case .AI-SDLC/** must still be refused (listed in tempDir blockedPaths)',
    );
  });

  it('refuses an arbitrarily-cased .Ai-Sdlc/ path too', () => {
    const input = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: join(tempDir, '.Ai-Sdlc', 'verdicts', 'aisdlc-567.json') },
    });
    const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: tempDir });
    assert.ok(isDenied(result), 'mixed-case .Ai-Sdlc/ must still be refused');
  });

  it('AISDLC-720: malformed agent-role.yaml does not crash the hook; internal .ai-sdlc/** edit allowed', () => {
    // A syntactically-broken YAML file must not crash the hook: it falls
    // through to "no config parsed" (empty blockedPaths/blockedActions).
    // Internal sessions are then allowed; untrusted runs stay blocked.
    const malformedDir = join(tmpdir(), `enforce-blocked-malformed-${Date.now()}`);
    mkdirSync(join(malformedDir, '.ai-sdlc'), { recursive: true });
    try {
      writeFileSync(
        join(malformedDir, '.ai-sdlc', 'agent-role.yaml'),
        '{ bad: yaml: [unclosed\n  - this is not valid: :::\n',
      );
      const input = JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: join(malformedDir, '.ai-sdlc', 'foo.yaml') },
      });
      const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: malformedDir });
      assert.ok(!isDenied(result), 'internal session is not blocked by a malformed config');
      const untrusted = runHookRaw(input, {
        CLAUDE_PROJECT_DIR: malformedDir,
        AI_SDLC_UNTRUSTED_RUN: '1',
      });
      assert.ok(isDenied(untrusted), 'untrusted run is still blocked with malformed config');
    } finally {
      rmSync(malformedDir, { recursive: true, force: true });
    }
  });
});

// ── AISDLC-567 Part B — isolate agents from sibling/parent repos ────────

describe('ai-sdlc-plugin enforce-blocked-actions hook (AISDLC-567 Part B: worktree isolation)', () => {
  let isoParent;
  let isoWorktree;
  let isoSiblingRepo;

  before(() => {
    isoParent = join(tmpdir(), `enforce-blocked-isolation-${Date.now()}`);
    isoWorktree = join(isoParent, '.worktrees', 'aisdlc-200');
    isoSiblingRepo = join(tmpdir(), `enforce-blocked-isolation-sibling-${Date.now()}`);

    mkdirSync(join(isoParent, '.ai-sdlc'), { recursive: true });
    mkdirSync(join(isoWorktree, 'src'), { recursive: true });
    mkdirSync(join(isoWorktree, '.ai-sdlc'), { recursive: true });
    mkdirSync(isoSiblingRepo, { recursive: true });

    writeFileSync(
      join(isoParent, '.ai-sdlc', 'agent-role.yaml'),
      `role: coding-agent
goal: Test agent
blockedPaths:
  - '.ai-sdlc/**'
blockedActions: []
`,
    );

    // The "sibling repo" really is a git repo, to prove the refusal applies
    // regardless of whether the outside path is itself a repo (the original
    // incident: an agent wrote into an unrelated framework checkout because
    // it happened to be a filesystem sibling).
    execSync('git init -q', { cwd: isoSiblingRepo });
    execSync('git config user.email test@example.com', { cwd: isoSiblingRepo });
    execSync('git config user.name Test', { cwd: isoSiblingRepo });
  });

  after(() => {
    rmSync(isoParent, { recursive: true, force: true });
    rmSync(isoSiblingRepo, { recursive: true, force: true });
  });

  it('allows Write inside the active worktree that is not under any blockedPaths glob', () => {
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(isoWorktree, 'src', 'foo.ts') },
      cwd: isoWorktree,
    });
    const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: isoParent });
    assert.ok(!isDenied(result), 'ordinary in-worktree write is allowed');
  });

  it('denies Write into the PARENT project root from a worktree cwd, even though it is "inside the project"', () => {
    // AISDLC-567 Part B: the agent's home is the worktree, not the whole
    // project root. A write that targets the parent repo's own working
    // tree (outside .worktrees/<id>/) must be denied unless it is in
    // permittedExternalPaths — this is exactly the incident's root cause.
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(isoParent, 'README.md') },
      cwd: isoWorktree,
    });
    const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: isoParent });
    assert.ok(isDenied(result), 'write to parent working tree from inside a worktree is denied');
  });

  it('denies Write into a sibling git repo outside the active worktree', () => {
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(isoSiblingRepo, 'foo.ts') },
      cwd: isoWorktree,
    });
    const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: isoParent });
    assert.ok(isDenied(result), 'sibling repo write denied without permittedExternalPaths');
  });

  it('still enforces .ai-sdlc/** relative to the worktree root (not just the project root)', () => {
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: join(isoWorktree, '.ai-sdlc', 'agent-role.yaml') },
      cwd: isoWorktree,
    });
    const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: isoParent });
    assert.ok(isDenied(result), '.ai-sdlc/** inside the worktree is still refused');
  });
});

// ── AISDLC-602 merge governance (reconciles gh-pr-merge drift) ──────────
//
// These fixtures deliberately omit any 'gh pr merge*' blockedActions
// pattern — the point of AISDLC-602 is that merge governance is now a
// DEDICATED check (enforceMergeGovernance) independent of the generic
// blockedActions glob list, so it must hold even with blockedActions: [].

describe('ai-sdlc-plugin enforce-blocked-actions hook (AISDLC-602 merge governance, strict default)', () => {
  let strictDir;

  before(() => {
    strictDir = join(tmpdir(), `enforce-blocked-merge-strict-${Date.now()}`);
    mkdirSync(join(strictDir, '.ai-sdlc'), { recursive: true });
    // No governance: section at all — resolves to STRICT_DEFAULTS.
    writeFileSync(
      join(strictDir, '.ai-sdlc', 'agent-role.yaml'),
      `role: coding-agent
goal: Test agent
blockedActions: []
`,
    );
  });

  after(() => {
    rmSync(strictDir, { recursive: true, force: true });
  });

  function run(command) {
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    return runHookRaw(input, { CLAUDE_PROJECT_DIR: strictDir });
  }

  it('blocks a raw "gh pr merge" (no --auto) under strict, even with no blockedActions configured', () => {
    const result = run('gh pr merge 42');
    assert.ok(isDenied(result), 'raw gh pr merge must be blocked under strict');
  });

  it('blocks "gh pr merge 42 --squash" (no --auto) under strict', () => {
    const result = run('gh pr merge 42 --squash');
    assert.ok(isDenied(result), 'raw gh pr merge with --squash (no --auto) is still a real merge');
  });

  it('blocks arming "gh pr merge --auto" under strict (arming is a merge in waiting)', () => {
    const result = run('gh pr merge 42 --auto');
    assert.ok(isDenied(result), 'raw arming must go through the helper --arm mode');
    assert.match(
      JSON.parse(result.output).hookSpecificOutput.permissionDecisionReason,
      /cli-merge-if-eligible\.mjs <pr> --arm/,
    );
  });

  it('blocks arming "gh pr merge --auto --squash" under strict (flag order/combination)', () => {
    assert.ok(isDenied(run('gh pr merge 42 --auto --squash')));
    assert.ok(isDenied(run('gh pr merge --squash --auto 42')));
  });

  it('allows the helper in merge mode and in --arm mode under strict', () => {
    assert.ok(!isDenied(run('node pipeline-cli/bin/cli-merge-if-eligible.mjs 42 --arm')));
    assert.ok(
      !isDenied(
        run(
          'node pipeline-cli/bin/cli-merge-if-eligible.mjs 42 --source-kind backlog --arm --format json',
        ),
      ),
    );
  });

  it('allows the cli-merge-if-eligible helper invocation under strict', () => {
    const result = run('node pipeline-cli/bin/cli-merge-if-eligible.mjs --pr 42');
    assert.ok(!isDenied(result), 'the merge-if-eligible helper is the sanctioned merge path');
  });

  it('deny reason cites the resolved policy and the sanctioned helper path', () => {
    const result = run('gh pr merge 42');
    const parsed = JSON.parse(result.output);
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /allowMerge="never"/);
    assert.match(reason, /cli-merge-if-eligible/);
    assert.match(reason, /--source-kind release --arm/);
  });

  // ── AISDLC-602 security-review regression: raw-merge bypasses ──────────
  // Each of these executes (or would execute) an IMMEDIATE merge and must be
  // blocked; the pre-fix `/--auto\b/` whole-string check let them through.

  it('blocks "gh pr merge --auto=false 42" (=false disables auto → immediate merge)', () => {
    const result = run('gh pr merge --auto=false 42');
    assert.ok(isDenied(result), '--auto=false is a real merge, not an arm');
  });

  it('blocks "gh pr merge --auto=0 42" (=0 disables auto → immediate merge)', () => {
    const result = run('gh pr merge --auto=0 42');
    assert.ok(isDenied(result), '--auto=0 is a real merge, not an arm');
  });

  it('blocks a raw merge chained before a stray --auto ("gh pr merge 42 && echo --auto")', () => {
    const result = run('gh pr merge 42 && echo --auto');
    assert.ok(
      isDenied(result),
      'a stray --auto in a chained command must not unblock the raw merge',
    );
  });

  it('blocks a raw merge with --auto only in a trailing comment ("gh pr merge 42 # --auto")', () => {
    const result = run('gh pr merge 42 # --auto');
    assert.ok(
      isDenied(result),
      'a --auto inside a shell comment never reaches gh → still a raw merge',
    );
  });

  it('blocks when a raw merge is chained before a real arm ("gh pr merge 42 && gh pr merge 42 --auto")', () => {
    const result = run('gh pr merge 42 && gh pr merge 42 --auto');
    assert.ok(isDenied(result), 'the leading raw-merge segment must block the whole command');
  });

  it('blocks the reverse order too: an arm chained BEFORE a raw merge ("gh pr merge 42 --auto && gh pr merge 42")', () => {
    // Segments are evaluated independently, so a clean arm in an earlier
    // segment must not launder a raw-merge segment that follows it.
    const result = run('gh pr merge 42 --auto && gh pr merge 42');
    assert.ok(
      isDenied(result),
      'a trailing raw-merge segment must block regardless of a preceding arm',
    );
  });

  it('blocks "gh pr merge 42 --body \\"--auto\\"" (--auto is a quoted arg value, not the flag)', () => {
    const result = run('gh pr merge 42 --body "--auto"');
    assert.ok(isDenied(result), 'a quoted --auto value must not be mistaken for the arming flag');
  });

  it('blocks quote-obfuscated "gh \\"pr\\" merge 42"', () => {
    const result = run('gh "pr" merge 42');
    assert.ok(isDenied(result), 'quote-obfuscated gh pr merge must still be detected and blocked');
  });

  it('blocks an arm with an explicit repo flag ("gh pr merge 42 --auto -R owner/repo")', () => {
    const result = run('gh pr merge 42 --auto -R owner/repo');
    assert.ok(isDenied(result), 'no raw arming form is allowed any more');
  });

  it('blocks every raw merge/arm flag combination and the disarm form', () => {
    for (const cmd of [
      'gh pr merge 42 --auto --squash --match-head-commit abc',
      'gh pr merge 42 --auto --rebase --delete-branch',
      'gh pr merge 42 -d --auto',
      'gh pr merge 42 --merge',
      'gh pr merge 42 --rebase',
      'gh pr merge 42 --admin',
      'gh pr merge --disable-auto 42',
      'gh pr merge',
      'gh pr merge https://github.com/o/r/pull/42 --auto',
      'GH_TOKEN=x gh pr merge 42 --auto',
      'cd repo && gh pr merge 42 --auto',
      '(gh pr merge 42 --auto)',
      'GH PR MERGE 42 --AUTO',
      'gh \'pr\' "merge" 42 --auto',
      'gh pr merge 42 --auto 2>&1',
      'gh pr merge 42 --auto | cat',
    ]) {
      assert.ok(isDenied(run(cmd)), `expected deny: ${cmd}`);
    }
  });

  it('fails CLOSED: raw "gh pr merge" is blocked even when agent-role.yaml is entirely missing', () => {
    const noConfigDir = join(tmpdir(), `enforce-blocked-merge-noconfig-${Date.now()}`);
    mkdirSync(noConfigDir, { recursive: true });
    try {
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'gh pr merge 42' },
      });
      const result = runHookRaw(input, { CLAUDE_PROJECT_DIR: noConfigDir });
      assert.ok(
        isDenied(result),
        'with no resolvable policy the hook must default to strict and block the raw merge',
      );
    } finally {
      rmSync(noConfigDir, { recursive: true, force: true });
    }
  });
});

describe('ai-sdlc-plugin enforce-blocked-actions hook (AISDLC-602 merge governance, onGreenClean policy)', () => {
  let greenDir;

  before(() => {
    greenDir = join(tmpdir(), `enforce-blocked-merge-green-${Date.now()}`);
    mkdirSync(join(greenDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(greenDir, '.ai-sdlc', 'agent-role.yaml'),
      `role: coding-agent
goal: Test agent
governance:
  allowMerge: onGreenClean
blockedActions: []
`,
    );
  });

  after(() => {
    rmSync(greenDir, { recursive: true, force: true });
  });

  function run(command) {
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    return runHookRaw(input, { CLAUDE_PROJECT_DIR: greenDir });
  }

  it('still blocks a raw "gh pr merge" even when policy permits merge-on-green — must route through the helper', () => {
    const result = run('gh pr merge 42 --squash');
    assert.ok(
      isDenied(result),
      'raw gh pr merge stays blocked under onGreenClean too — only the helper is sanctioned',
    );
  });

  it('blocks arming "gh pr merge --auto" under onGreenClean too (helper --arm is the route)', () => {
    const result = run('gh pr merge 42 --auto');
    assert.ok(isDenied(result), 'raw arming is denied regardless of policy');
  });

  it('allows the helper --arm mode under onGreenClean', () => {
    assert.ok(!isDenied(run('node pipeline-cli/bin/cli-merge-if-eligible.mjs 42 --arm')));
  });

  it('allows the cli-merge-if-eligible helper invocation under onGreenClean', () => {
    const result = run(
      'node pipeline-cli/bin/cli-merge-if-eligible.mjs --pr 42 --source-kind backlog',
    );
    assert.ok(!isDenied(result), 'the helper is the sanctioned merge path under onGreenClean');
  });

  it('deny reason cites the resolved onGreenClean policy', () => {
    const result = run('gh pr merge 42');
    const parsed = JSON.parse(result.output);
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /allowMerge="onGreenClean"/);
  });
});

// ── API-merge governance (denied under every allowMerge value) ───────────

describe('ai-sdlc-plugin enforce-blocked-actions hook (API-merge governance)', () => {
  const dirs = {};

  before(() => {
    for (const [name, governance] of [
      ['strict', ''],
      ['green', 'governance:\n  allowMerge: onGreenClean\n'],
    ]) {
      const d = join(tmpdir(), `enforce-blocked-apimerge-${name}-${Date.now()}`);
      mkdirSync(join(d, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(d, '.ai-sdlc', 'agent-role.yaml'),
        `role: coding-agent\ngoal: Test agent\n${governance}blockedActions: []\n`,
      );
      dirs[name] = d;
    }
  });

  after(() => {
    for (const d of Object.values(dirs)) rmSync(d, { recursive: true, force: true });
  });

  function run(policy, command) {
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    return runHookRaw(input, { CLAUDE_PROJECT_DIR: dirs[policy] });
  }

  const DENIED = [
    'gh api repos/acme/widgets/pulls/42/merge -X PUT',
    'gh api -X PUT repos/acme/widgets/pulls/42/merge',
    'gh api /repos/acme/widgets/pulls/42/merge --method PUT -f merge_method=squash',
    'gh api --method=PUT repos/acme/widgets/pulls/42/merge',
    'gh api repos/acme/widgets/pulls/42/merge',
    'gh api -f merge_method=squash -F sha=abc123 repos/acme/widgets/pulls/42/merge -X PUT',
    'gh api "repos/acme/widgets/pulls/42/merge" -X PUT',
    "gh api 'repos/acme/widgets/pu''lls/42/merge' -X PUT",
    'gh api repos/acme/widgets/pulls/42/merge/ -X PUT',
    'gh api repos/{owner}/{repo}/pulls/42/merge -X PUT',
    'gh api repos/$OWNER/$REPO/pulls/$PR/merge -X PUT',
    'gh api repos/${OWNER}/${REPO}/pulls/${PR}/merge -X PUT',
    'gh api repos/acme/widgets/pulls/42/%6Derge -X PUT',
    'gh api repos/acme/widgets/pulls/42/merge -X PUT && echo done',
    'echo start; gh api repos/acme/widgets/pulls/42/merge -X PUT',
    'gh api graphql -f query=\'mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }\'',
    'gh api graphql -f query=\'mutation { enablePullRequestAutoMerge(input:{pullRequestId:"x"}) { clientMutationId } }\'',
    'curl -X PUT https://api.github.com/repos/acme/widgets/pulls/42/merge',
    'curl -sS -H "Authorization: Bearer $GH_TOKEN" -X PUT https://api.github.com/repos/acme/widgets/pulls/42/merge -d \'{"merge_method":"squash"}\'',
    'curl --request PUT --url https://api.github.com/repos/acme/widgets/pulls/42/merge',
    '/usr/bin/curl -X PUT api.github.com/repos/acme/widgets/pulls/42/merge',
    'wget --method=PUT https://api.github.com/repos/acme/widgets/pulls/42/merge',
    'http PUT https://api.github.com/repos/acme/widgets/pulls/42/merge',
    'bash -c "gh api repos/acme/widgets/pulls/42/merge -X PUT"',
    'echo repos/acme/widgets/pulls/42/merge | xargs gh api -X PUT',
    "node -e \"fetch('https://api.github.com/repos/acme/widgets/pulls/42/merge',{method:'PUT'})\"",
    'python3 -c "import requests; requests.put(\'https://api.github.com/repos/acme/widgets/pulls/42/merge\')"',
  ];

  for (const policy of ['strict', 'green']) {
    for (const cmd of DENIED) {
      it(`denies under ${policy}: ${cmd}`, () => {
        const result = run(policy, cmd);
        assert.ok(isDenied(result), `expected deny: ${cmd}`);
        const parsed = JSON.parse(result.output);
        assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /GitHub API/);
        assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /cli-merge-if-eligible/);
      });
    }
  }

  for (const policy of ['strict', 'green']) {
    it(`heredoc handling is whole-text and fail-closed under ${policy}: no spelling hides a merge`, () => {
      const commands = [
        'gh pr merge 42 --auto',
        'gh pr merge 42 --squash',
        'gh api repos/acme/widgets/pulls/42/merge -X PUT',
        'curl -X PUT https://api.github.com/repos/acme/widgets/pulls/42/merge',
      ];
      // Fake "heredoc openers" that never open a heredoc: the command that follows is real.
      const fakeOpeners = [
        'echo hi <<<x',
        'echo "<<X"',
        'true # <<X',
        'echo $((1<<X))',
        "echo '<<EOF'",
        'cat <<< "<<EOF"',
      ];
      // Real heredocs fed to something that executes the body, or to something inert:
      // the merge text inside the body is denied regardless of the opener.
      const openers = [
        'bash <<EOF',
        "sh <<'EOF'",
        'bash -s <<EOF',
        'cat <<EOF | sh',
        'cat <<EOF | bash',
        'cat <<EOF > x.sh',
        'cat <<EOF',
        "cat <<'EOF'",
        'python3 - <<EOF',
        'python <<EOF',
        'node - <<EOF',
        'nodejs <<EOF',
        'perl <<EOF',
        'ruby <<EOF',
        'eval "$(cat <<EOF',
        'xargs -0 sh -c <<EOF',
        'source /dev/stdin <<EOF',
        '. /dev/stdin <<EOF',
        '${SHELL} <<EOF',
        'git commit -F - <<EOF',
        'tee note.txt <<EOF',
      ];
      for (const cmd of commands) {
        for (const opener of fakeOpeners) {
          const text = `${opener}\n${cmd}`;
          assert.ok(isDenied(run(policy, text)), `expected deny: ${JSON.stringify(text)}`);
        }
        for (const opener of openers) {
          const text = `${opener}\n${cmd}\nEOF`;
          assert.ok(isDenied(run(policy, text)), `expected deny: ${JSON.stringify(text)}`);
        }
        // The opener line itself is a real command and is always checked.
        assert.ok(isDenied(run(policy, `${cmd} <<'EOF'\nbody\nEOF`)));
      }
    });

    it(`documentation quoting the command in a heredoc is also denied (accepted false denial) under ${policy}`, () => {
      assert.ok(isDenied(run(policy, "cat <<'EOF'\ngh pr merge 42 --auto\nEOF")));
      assert.ok(
        isDenied(
          run(policy, 'git commit -F - <<EOF\nnote: never run gh pr merge --auto here\nEOF'),
        ),
      );
      // Prose that does not contain the command text is unaffected.
      assert.ok(
        !isDenied(run(policy, 'git commit -F - <<EOF\nnote: use the merge helper instead\nEOF')),
      );
    });

    it(`API-merge deny message no longer claims arming stays allowed under ${policy}`, () => {
      const result = run(policy, 'gh api repos/acme/widgets/pulls/42/merge -X PUT');
      const reason = JSON.parse(result.output).hookSpecificOutput.permissionDecisionReason;
      assert.doesNotMatch(reason, /remains allowed/);
      assert.match(reason, /--arm/);
    });

    it(`denies arming with --admin (an admin merge bypass) under ${policy}`, () => {
      assert.ok(isDenied(run(policy, 'gh pr merge 42 --auto --admin')));
      assert.ok(isDenied(run(policy, 'gh pr merge 42 --admin --squash')));
    });

    it(`denies any command naming the removed policy-root override under ${policy}`, () => {
      const result = run(
        policy,
        'AI_SDLC_MERGE_POLICY_ROOT_FOR_TESTS=1 node pipeline-cli/bin/cli-merge-if-eligible.mjs 42 --source-kind backlog',
      );
      assert.ok(isDenied(result));
      assert.match(
        JSON.parse(result.output).hookSpecificOutput.permissionDecisionReason,
        /policy root/,
      );
    });
  }

  const ALLOWED = [
    // the sanctioned helper (merge and arm modes)
    'node pipeline-cli/bin/cli-merge-if-eligible.mjs 42 --arm',
    'node pipeline-cli/bin/cli-merge-if-eligible.mjs 42 --source-kind backlog --arm --dry-run',
    'node pipeline-cli/bin/cli-merge-if-eligible.mjs 42 --source-kind backlog',
    'node pipeline-cli/bin/cli-merge-if-eligible.mjs 42 --source-kind backlog --dry-run',
    // reads and unrelated API calls
    'gh api repos/acme/widgets/pulls/42',
    'gh api repos/acme/widgets/pulls/42/files',
    'gh api repos/acme/widgets/pulls/42/comments -f body=hi',
    'gh api repos/acme/widgets/pulls/42/merge-queue-entry',
    'curl -s https://api.github.com/repos/acme/widgets/pulls/42',
    // text that merely mentions the path, no network/interpreter tool
    'grep -rn "pulls/42/merge" docs',
    'cat docs/api-reference/governance.md',
  ];

  for (const policy of ['strict', 'green']) {
    for (const cmd of ALLOWED) {
      it(`allows under ${policy}: ${cmd.split('\n')[0]}`, () => {
        const result = run(policy, cmd);
        assert.ok(!isDenied(result), `expected allow: ${cmd}`);
      });
    }
  }
});

// ── AISDLC-567 stale-base guard ──────────────────────────────────────────

describe('ai-sdlc-plugin enforce-blocked-actions hook (AISDLC-567 stale-base guard)', () => {
  let staleParent;
  let staleOrigin;
  let staleWorktree;

  before(() => {
    staleParent = join(tmpdir(), `enforce-blocked-stale-${Date.now()}`);
    staleOrigin = join(tmpdir(), `enforce-blocked-stale-origin-${Date.now()}`);
    staleWorktree = join(staleParent, '.worktrees', 'aisdlc-300');

    mkdirSync(staleOrigin, { recursive: true });
    mkdirSync(join(staleParent, '.ai-sdlc'), { recursive: true });
    mkdirSync(staleWorktree, { recursive: true });

    writeFileSync(
      join(staleParent, '.ai-sdlc', 'agent-role.yaml'),
      `role: coding-agent
goal: Test agent
blockedPaths: []
blockedActions: []
`,
    );

    // Build a local "origin" repo with a main branch — no network involved,
    // just a second local repo acting as the remote.
    execSync('git init -q -b main', { cwd: staleOrigin });
    execSync('git config user.email test@example.com', { cwd: staleOrigin });
    execSync('git config user.name Test', { cwd: staleOrigin });
    writeFileSync(join(staleOrigin, 'file.txt'), 'v1\n');
    execSync('git add file.txt && git commit -q -m "initial"', { cwd: staleOrigin });

    // "Worktree" clones origin at this point — its HEAD matches origin/main.
    execSync(`git clone -q "${staleOrigin}" "${staleWorktree}"`, { cwd: staleParent });
    execSync('git config user.email test@example.com', { cwd: staleWorktree });
    execSync('git config user.name Test', { cwd: staleWorktree });

    // Origin advances further — the worktree's checked-out HEAD is now stale
    // relative to origin/main.
    writeFileSync(join(staleOrigin, 'file.txt'), 'v2\n');
    execSync('git add file.txt && git commit -q -m "second"', { cwd: staleOrigin });

    // Refresh the worktree's LOCAL knowledge of origin/main (a normal
    // `git fetch`, not a hook-triggered network call) without touching its
    // own HEAD — this reproduces "operator hasn't rebased yet".
    execSync('git fetch -q origin main', { cwd: staleWorktree });
  });

  after(() => {
    rmSync(staleParent, { recursive: true, force: true });
    rmSync(staleOrigin, { recursive: true, force: true });
  });

  function runHookCaptureStderr(payload, env = {}) {
    const result = spawnSync('node', [hookScript], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env: { ...process.env, GITHUB_ACTIONS: '', CLAUDE_PROJECT_DIR: staleParent, ...env },
      timeout: 5000,
    });
    return {
      stdout: (result.stdout || '').trim(),
      stderr: result.stderr || '',
      status: result.status,
    };
  }

  it('warns on stderr when the worktree HEAD is behind origin/main, without blocking the write', () => {
    const result = runHookCaptureStderr({
      tool_name: 'Write',
      tool_input: { file_path: join(staleWorktree, 'new-file.ts') },
      cwd: staleWorktree,
    });
    assert.match(result.stderr, /behind origin\/main/i, 'should warn about stale base');
    assert.ok(!result.stdout.includes('"deny"'), 'must not block the write — warning only');
  });

  it('does not warn once the worktree is rebased onto origin/main', () => {
    execSync('git rebase origin/main', { cwd: staleWorktree });
    const result = runHookCaptureStderr({
      tool_name: 'Write',
      tool_input: { file_path: join(staleWorktree, 'new-file2.ts') },
      cwd: staleWorktree,
    });
    assert.doesNotMatch(result.stderr, /behind origin\/main/i, 'no warning once rebased');
  });
});

describe('ai-sdlc-plugin enforce-blocked-actions hook — no-bare-stash governance (AISDLC-611)', () => {
  // ── Block cases (AC-1) ──────────────────────────────────────────────

  // Round-5 scope (operator decision): destructive-ops-only. Bare `git stash`
  // and untagged push/save are NON-destructive (they only ADD to the stack),
  // so they are ALLOWED; only pop/clear/bare-drop are blocked.
  it('allows bare git stash (a non-destructive push)', () => {
    const result = runHook('git stash');
    assert.ok(!isDenied(result), 'bare git stash only adds to the stack — allowed');
  });

  it('allows git stash save with no tag (non-destructive)', () => {
    const result = runHook('git stash save');
    assert.ok(!isDenied(result), 'untagged save only adds to the stack — allowed');
  });

  it('allows git stash push with no -m/--message tag (non-destructive)', () => {
    const result = runHook('git stash push -u');
    assert.ok(!isDenied(result), 'untagged push only adds to the stack — allowed');
  });

  it('blocks git stash pop unconditionally', () => {
    const result = runHook('git stash pop');
    assert.ok(isDenied(result), 'should deny git stash pop');
  });

  it('blocks git stash pop even with a stash ref argument', () => {
    const result = runHook('git stash pop stash@{0}');
    assert.ok(isDenied(result), 'pop is never safe, even with an explicit ref');
  });

  it('blocks bare git stash drop (no explicit ref)', () => {
    const result = runHook('git stash drop');
    assert.ok(isDenied(result), 'should deny bare git stash drop');
  });

  it('blocks git stash clear (destructive: wipes the whole shared stack)', () => {
    const result = runHook('git stash clear');
    assert.ok(isDenied(result), 'should deny git stash clear');
  });

  it('block message points at the safe pattern', () => {
    const result = runHook('git stash pop');
    assert.match(result.output, /git stash push -u -m/, 'reason should mention the safe pattern');
    assert.match(result.output, /git stash apply/, 'reason should mention apply-by-ref');
  });

  // ── Allow cases (AC-1 + AC-3) ───────────────────────────────────────

  it('allows tagged git stash push -u -m', () => {
    const result = runHook('git stash push -u -m "wip-aisdlc-611"');
    assert.ok(!isDenied(result), 'should allow tagged push');
  });

  it('allows git stash push --message=<tag>', () => {
    const result = runHook('git stash push --message=wip-tag');
    assert.ok(!isDenied(result), 'should allow --message= form');
  });

  it('allows git stash save "<tag>" (positional message)', () => {
    const result = runHook('git stash save "wip work"');
    assert.ok(!isDenied(result), 'should allow tagged save');
  });

  it('allows git stash apply <ref>', () => {
    const result = runHook('git stash apply stash@{0}');
    assert.ok(!isDenied(result), 'should allow apply by ref');
  });

  it('allows git stash apply with no ref (never drops anything)', () => {
    const result = runHook('git stash apply');
    assert.ok(!isDenied(result), 'apply never drops from the stack, safe even bare');
  });

  it('allows git stash list', () => {
    const result = runHook('git stash list');
    assert.ok(!isDenied(result), 'should allow list');
  });

  it('allows git stash show', () => {
    const result = runHook('git stash show stash@{0}');
    assert.ok(!isDenied(result), 'should allow show');
  });

  it('allows git stash drop <ref> (tagged/explicit drop)', () => {
    const result = runHook('git stash drop stash@{0}');
    assert.ok(!isDenied(result), 'should allow drop with an explicit ref');
  });

  it('allows a normal git push unrelated to stash', () => {
    const result = runHook('git push origin feature');
    assert.ok(!isDenied(result), 'unrelated git commands are untouched');
  });

  // ── Evasion shapes (AC-1): chained &&, quoting, control operators ───

  it('blocks git stash pop chained after an unrelated command with &&', () => {
    const result = runHook('pnpm test && git stash pop');
    assert.ok(isDenied(result), 'chained && must not evade the guard');
  });

  it('blocks git stash pop chained with ;', () => {
    const result = runHook('echo hi; git stash pop');
    assert.ok(isDenied(result), 'chained ; must not evade the guard');
  });

  it('blocks git stash pop after ||', () => {
    const result = runHook('false || git stash pop');
    assert.ok(isDenied(result), 'chained || must not evade the guard');
  });

  it('blocks quote-obfuscated git "stash" pop', () => {
    const result = runHook('git "stash" pop');
    assert.ok(isDenied(result), 'quote-splitting the stash token must not evade the guard');
  });

  // ── Path-qualified / quote-obfuscated / shell-wrapped bypass (security review) ──

  it('blocks a path-qualified /usr/bin/git stash pop', () => {
    const result = runHook('/usr/bin/git stash pop');
    assert.ok(isDenied(result), 'basename-tolerant git matching must catch a full-path git binary');
  });

  it('blocks a path-qualified /usr/bin/git stash clear', () => {
    const result = runHook('/usr/bin/git stash clear');
    assert.ok(
      isDenied(result),
      'basename-tolerant git matching must catch clear on a full-path git',
    );
  });

  it("blocks git st''ash pop (mid-token empty single-quote splice)", () => {
    const result = runHook("git st''ash pop");
    assert.ok(
      isDenied(result),
      'a real shell concatenates st + \'\' + ash into "stash" — detection must too',
    );
  });

  it('blocks git sta"sh" pop (mid-token double-quote splice)', () => {
    const result = runHook('git sta"sh" pop');
    assert.ok(
      isDenied(result),
      'a real shell concatenates sta + "sh" into "stash" — detection must too',
    );
  });

  it('blocks (git stash pop) wrapped in a subshell', () => {
    const result = runHook('(git stash pop)');
    assert.ok(
      isDenied(result),
      'a subshell still EXECUTES its contents — must not evade the guard',
    );
  });

  it('blocks { git stash pop; } wrapped in a brace group', () => {
    const result = runHook('{ git stash pop; }');
    assert.ok(
      isDenied(result),
      'a brace group still EXECUTES its contents — must not evade the guard',
    );
  });

  it('blocks $(git stash pop) command substitution', () => {
    const result = runHook('$(git stash pop)');
    assert.ok(
      isDenied(result),
      'command substitution still EXECUTES its contents — must not evade the guard',
    );
  });

  it('blocks `git stash pop` backtick substitution', () => {
    const result = runHook('`git stash pop`');
    assert.ok(
      isDenied(result),
      'backtick substitution still EXECUTES its contents — must not evade the guard',
    );
  });

  it('blocks git stash pop with global -C flag inserted', () => {
    const result = runHook('git -C /tmp/some-worktree stash pop');
    assert.ok(isDenied(result), 'global git flags before stash must not evade the guard');
  });

  // ── $IFS / backslash-splice / leading-backslash bypass (2nd security re-review) ──

  it('blocks git${IFS}stash${IFS}pop ($IFS word-splitting)', () => {
    const result = runHook('git${IFS}stash${IFS}pop');
    assert.ok(
      isDenied(result),
      "bash's default $IFS is whitespace — this really does execute git stash pop",
    );
  });

  it('blocks git${IFS}stash${IFS}pop with braces omitted ($IFS bare form)', () => {
    const result = runHook('git $IFS stash $IFS pop');
    assert.ok(isDenied(result), 'bare $VAR form must also be collapsed to whitespace');
  });

  it('blocks git st\\ash pop (backslash mid-token splice)', () => {
    const result = runHook('git st\\ash pop');
    assert.ok(
      isDenied(result),
      'a real shell drops the unescaped backslash and joins st+ash into stash',
    );
  });

  it('blocks \\git stash pop (leading backslash on the git token)', () => {
    const result = runHook('\\git stash pop');
    assert.ok(isDenied(result), 'a leading backslash must not hide the git token');
  });

  // ── $VAR-then-quote ordering bypass (3rd security re-review) ─────────

  it("blocks git$IFS'stash'${IFS}pop (quote terminates $VAR name)", () => {
    const result = runHook("git$IFS'stash'${IFS}pop");
    assert.ok(
      isDenied(result),
      '$VAR collapse must run BEFORE quote-stripping so the quote correctly ' +
        'terminates the $IFS variable name, leaving the stash token intact',
    );
  });

  it("blocks git $IFS'stash' pop (bare $VAR immediately followed by a quote)", () => {
    const result = runHook("git $IFS'stash' pop");
    assert.ok(isDenied(result), 'bare $VAR form must also respect quote-termination ordering');
  });

  it("blocks git$IFS''stash pop (empty-quote immediately after $VAR)", () => {
    const result = runHook("git$IFS''stash pop");
    assert.ok(isDenied(result), 'an empty quote right after $VAR must not swallow the stash token');
  });

  // ── Empty-variable intra-token splice (4th security re-review) ───────
  // An UNSET/empty var concatenates its neighbors in a real shell, so a splice
  // INSIDE the git or stash token would hide it under a space-only collapse.
  // The single shell-accurate normalizer (other vars→empty) concatenates and
  // catches these.

  it('blocks g${x}it stash pop (empty var spliced inside the git token)', () => {
    const result = runHook('g${x}it stash pop');
    assert.ok(
      isDenied(result),
      'an unset var concatenates to `git` — the empty interpretation must reveal it',
    );
  });

  it('blocks git st${x}ash pop (empty var spliced inside the stash token)', () => {
    const result = runHook('git st${x}ash pop');
    assert.ok(isDenied(result), 'an unset var concatenates to `stash` — must still block pop');
  });

  it('blocks gi${x}t stash pop (empty var spliced inside the git token, variant)', () => {
    const result = runHook('gi${x}t stash pop');
    assert.ok(isDenied(result), 'empty-var splice on the git token must not evade detection');
  });

  it('blocks g${x}it stash clear (empty-var splice + destructive clear)', () => {
    const result = runHook('g${x}it stash clear');
    assert.ok(isDenied(result), 'empty-var splice must not hide a destructive clear');
  });

  // ── MIXED expansion: empty user var + $IFS in the SAME command (5th security re-review) ──
  // A real shell resolves each var independently — an unset var concatenates
  // while $IFS word-splits. The single shell-accurate normalize pass ($IFS→space,
  // other vars→empty) models this; a two-uniform-corner sweep could not.

  it('blocks g${x}it${IFS}stash pop (empty user var joins git, $IFS splits stash/pop)', () => {
    const result = runHook('g${x}it${IFS}stash pop');
    assert.ok(
      isDenied(result),
      'mixed empty-var + $IFS expansion must still resolve to a blocked pop',
    );
  });

  it('blocks git${IFS}st${x}ash pop (empty splice inside stash + $IFS separator)', () => {
    const result = runHook('git${IFS}st${x}ash pop');
    assert.ok(isDenied(result), 'mixed expansion inside the stash token must still block pop');
  });

  it('blocks g${x}it${IFS}stash clear (mixed expansion + destructive clear)', () => {
    const result = runHook('g${x}it${IFS}stash clear');
    assert.ok(isDenied(result), 'mixed expansion must not hide a destructive clear');
  });

  it('blocks git${IFS:0:1}stash${IFS:0:1}pop (IFS parameter-expansion → space)', () => {
    const result = runHook('git${IFS:0:1}stash${IFS:0:1}pop');
    assert.ok(
      isDenied(result),
      '${IFS:0:1} evaluates to a space in-shell — must be treated as a separator, not deleted',
    );
  });

  it('does not misclassify ${IFSX} (a distinct unset var) as the IFS separator', () => {
    // ${IFSX} is a DIFFERENT variable → empty → `gitstash pop` is not a git
    // token, so this is allowed (it does not execute a real git stash in-shell
    // either — `$IFSX` is unset). Guards the IFS-param-expansion regex against
    // over-matching a same-prefixed distinct variable name.
    const result = runHook('git${IFSX}stash pop');
    assert.ok(!isDenied(result), '${IFSX} is a distinct unset var (empty), not the IFS separator');
  });

  // ── Fail-closed subcommand-position redesign: no-over-block guard ────

  it('does not block git commit -m stash (stash is an argument, not the subcommand)', () => {
    const result = runHook('git commit -m stash');
    assert.ok(!isDenied(result), 'stash must be the SUBCOMMAND position to trigger detection');
  });

  it('does not block git branch stash-experiment (stash is a branch-name argument)', () => {
    const result = runHook('git branch stash-experiment');
    assert.ok(!isDenied(result), 'branch is the subcommand here, not stash');
  });

  it('does not block git log --grep stash (stash is a grep pattern argument)', () => {
    const result = runHook('git log --grep stash');
    assert.ok(!isDenied(result), 'log is the subcommand here, not stash');
  });

  it('allows git stash push -u -m "$TAG" (variable-valued tag — over-block regression guard)', () => {
    const result = runHook('git stash push -u -m "$TAG"');
    assert.ok(
      !isDenied(result),
      'a $VAR-valued tag must not be falsely blocked: push is non-destructive and allowed ' +
        'regardless of tag (the round-4 reorder + tag-parsing combo had falsely denied this)',
    );
  });

  // ── No-over-block cases (AC-3) ───────────────────────────────────────

  it('does not block git stash list even though it is a stash subcommand', () => {
    const result = runHook('git stash list');
    assert.equal(result.output, '', 'should produce no output (fully allowed)');
  });

  it('does not block an echo that merely mentions "git stash pop" as text', () => {
    const result = runHook('echo "remember: never run git stash pop"');
    assert.ok(!isDenied(result), 'echo text is data, not an invocation');
  });

  it('does not block a path containing the word "stash"', () => {
    const result = runHook('ls -la ./stash-archive/');
    assert.ok(!isDenied(result), 'a path substring must not trigger the guard');
  });

  it('does not block a heredoc body that contains "git stash pop" as example text', () => {
    const result = runHook('cat <<EOF\nDoc: never run git stash pop manually.\nEOF');
    assert.ok(!isDenied(result), 'heredoc body content is inert data, not an invocation');
  });

  it('does not block git commit -m "stash" (message value happens to be the word stash)', () => {
    const result = runHook('git commit -m stash');
    assert.ok(!isDenied(result), 'git commit is not git stash');
  });

  it('does not block an unrelated npm/pnpm script whose name contains stash', () => {
    const result = runHook('pnpm run unstash-fixtures');
    assert.ok(!isDenied(result), 'script name containing "stash" must not trigger the guard');
  });
});

// ── AISDLC-720 — internal sessions may edit .ai-sdlc; untrusted runs may not ──

describe('ai-sdlc-plugin enforce-blocked-actions hook (AISDLC-720: trust model)', () => {
  let dir;
  const yamlPath = () => join(dir, '.ai-sdlc', 'agent-role.yaml');
  const UNTRUSTED = { AI_SDLC_UNTRUSTED_RUN: '1' };

  before(() => {
    dir = join(tmpdir(), `enforce-blocked-720-${Date.now()}`);
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    // Default configuration: no blockedPaths at all.
    writeFileSync(yamlPath(), 'role: coding-agent\ngoal: Test agent\nblockedActions: []\n');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const run = (toolName, file, env = {}) =>
    runHookRaw(JSON.stringify({ tool_name: toolName, tool_input: { file_path: file } }), {
      CLAUDE_PROJECT_DIR: dir,
      GITHUB_ACTIONS: '',
      AI_SDLC_UNTRUSTED_RUN: '',
      ...env,
    });
  const bash = (command, env = {}) =>
    runHookRaw(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), {
      CLAUDE_PROJECT_DIR: dir,
      GITHUB_ACTIONS: '',
      AI_SDLC_UNTRUSTED_RUN: '',
      ...env,
    });

  it('happy path: internal session, default config, Edit of .ai-sdlc/agent-role.yaml is not refused', () => {
    assert.ok(!isDenied(run('Edit', yamlPath())));
    assert.ok(!isDenied(run('Write', yamlPath())));
    assert.ok(!isDenied(run('MultiEdit', yamlPath())));
  });

  it('reviewers can write their own review transcript / ledger / leaves under .ai-sdlc/', () => {
    for (const rel of [
      '.ai-sdlc/reviews/aisdlc-720.jsonl',
      '.ai-sdlc/transcript-leaves/abc.jsonl',
      '.ai-sdlc/transcript-leaves.jsonl',
      '.ai-sdlc/verdicts/aisdlc-720.json',
    ]) {
      assert.ok(!isDenied(run('Write', join(dir, rel))), `${rel} must be writable`);
    }
  });

  it('internal sessions may run shell writes under .ai-sdlc/ (sanctioned CLIs)', () => {
    assert.ok(!isDenied(bash('echo x >> .ai-sdlc/reviews/aisdlc-720.jsonl')));
  });

  it('project blockedPaths still works as explicit opt-in for internal sessions', () => {
    const optIn = join(tmpdir(), `enforce-blocked-720-optin-${Date.now()}`);
    mkdirSync(join(optIn, '.ai-sdlc'), { recursive: true });
    try {
      writeFileSync(
        join(optIn, '.ai-sdlc', 'agent-role.yaml'),
        "role: coding-agent\nblockedPaths:\n  - '.ai-sdlc/**'\n",
      );
      const r = runHookRaw(
        JSON.stringify({
          tool_name: 'MultiEdit',
          tool_input: { file_path: join(optIn, '.ai-sdlc', 'x.yaml') },
        }),
        { CLAUDE_PROJECT_DIR: optIn, AI_SDLC_UNTRUSTED_RUN: '', GITHUB_ACTIONS: '' },
      );
      assert.ok(isDenied(r));
    } finally {
      rmSync(optIn, { recursive: true, force: true });
    }
  });

  it('untrusted: Write/Edit/MultiEdit on .ai-sdlc/** and .github/workflows/** are refused with the untrusted message', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      for (const f of [yamlPath(), join(dir, '.github', 'workflows', 'ci.yml')]) {
        const r = run(tool, f, { ...UNTRUSTED, AI_SDLC_UNTRUSTED_REASON: 'fork PR' });
        assert.ok(isDenied(r), `${tool} ${f}`);
        const reason = JSON.parse(r.output).hookSpecificOutput.permissionDecisionReason;
        assert.match(reason, /untrusted/);
        assert.match(reason, /step-level env:/, 'refusal names the step-level form of the marker');
        assert.match(reason, /AI_SDLC_INTERNAL_RUN/);
        assert.match(reason, /fork PR/);
        assert.match(reason, /maintainer/);
      }
    }
    assert.ok(!isDenied(run('Write', join(dir, 'src', 'a.ts'), UNTRUSTED)), 'other paths fine');
  });

  it('AISDLC-720(a): GITHUB_ACTIONS with no signal and no internal marker is refused', () => {
    const ci = { GITHUB_ACTIONS: 'true' };
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const r = run(tool, yamlPath(), ci);
      assert.ok(isDenied(r), tool);
      assert.match(JSON.parse(r.output).hookSpecificOutput.permissionDecisionReason, /untrusted/);
    }
    assert.ok(isDenied(bash('echo x > .ai-sdlc/agent-role.yaml', ci)));
    assert.ok(!isDenied(run('Write', join(dir, 'src', 'a.ts'), ci)), 'other paths fine');
  });

  it('AISDLC-720(a): signal absent and running locally is allowed (GITHUB_ACTIONS unset or not true)', () => {
    assert.ok(!isDenied(run('Edit', yamlPath(), { GITHUB_ACTIONS: '' })));
    assert.ok(!isDenied(run('Edit', yamlPath(), { GITHUB_ACTIONS: 'false' })));
  });

  it('AISDLC-720(a): an explicit internal marker trusts a CI run, but cannot override the untrusted signal', () => {
    assert.ok(
      !isDenied(run('Edit', yamlPath(), { GITHUB_ACTIONS: 'true', AI_SDLC_INTERNAL_RUN: '1' })),
    );
    assert.ok(
      isDenied(
        run('Edit', yamlPath(), {
          GITHUB_ACTIONS: 'true',
          AI_SDLC_INTERNAL_RUN: '1',
          AI_SDLC_UNTRUSTED_RUN: '1',
        }),
      ),
    );
  });

  it('AISDLC-720(a): the env a gh-issue executePipeline run gives its agents is refused, in CI or locally', () => {
    // Mirrors UNTRUSTED_SPAWN_ENV in pipeline-cli/src/runtime/untrusted-env.ts.
    const ghIssue = { AI_SDLC_UNTRUSTED_RUN: '1', AI_SDLC_UNTRUSTED_REASON: 'gh-issue source' };
    assert.ok(isDenied(run('Edit', yamlPath(), ghIssue)));
    assert.ok(isDenied(run('Edit', yamlPath(), { ...ghIssue, GITHUB_ACTIONS: 'true' })));
  });

  it('untrusted: shell writes under .ai-sdlc/ and .github/workflows/ are refused', () => {
    for (const cmd of [
      'echo x > .ai-sdlc/agent-role.yaml',
      'echo x >> .github/workflows/ci.yml',
      'cat a | tee .ai-sdlc/agent-role.yaml',
      "sed -i 's/a/b/' .ai-sdlc/agent-role.yaml",
      'cp /tmp/x .github/workflows/ci.yml',
      'mv /tmp/x .ai-sdlc/agent-role.yaml',
      'rm -rf .ai-sdlc/attestations',
    ]) {
      const r = bash(cmd, UNTRUSTED);
      assert.ok(isDenied(r), cmd);
      assert.match(JSON.parse(r.output).hookSpecificOutput.permissionDecisionReason, /untrusted/);
    }
    assert.ok(!isDenied(bash('cat .ai-sdlc/agent-role.yaml', UNTRUSTED)), 'reads are fine');
  });

  it('untrusted signal cannot be cleared from inside the run', () => {
    // env assignments / export / unset in the command do not matter: hook reads its own env.
    for (const cmd of [
      'AI_SDLC_UNTRUSTED_RUN=0 sh -c "echo x > .ai-sdlc/agent-role.yaml"',
      'export AI_SDLC_UNTRUSTED_RUN=0; echo x > .ai-sdlc/agent-role.yaml',
      'unset AI_SDLC_UNTRUSTED_RUN; echo x > .ai-sdlc/agent-role.yaml',
    ]) {
      assert.ok(isDenied(bash(cmd, UNTRUSTED)), cmd);
    }
    // agent-role.yaml content and .active-task sentinel cannot downgrade it.
    writeFileSync(
      yamlPath(),
      'role: coding-agent\nuntrusted: false\nAI_SDLC_UNTRUSTED_RUN: 0\ntrusted: true\n',
    );
    writeFileSync(join(dir, '.active-task'), 'AISDLC-720\n');
    assert.ok(isDenied(run('Edit', yamlPath(), UNTRUSTED)));
    assert.ok(isDenied(run('Write', join(dir, '.active-task'), UNTRUSTED)));
  });

  it('falsy / unset signal values are internal', () => {
    for (const v of ['', '0', 'false', 'no', 'off']) {
      assert.ok(!isDenied(run('Edit', yamlPath(), { AI_SDLC_UNTRUSTED_RUN: v })), v);
    }
    for (const v of ['1', 'true', 'YES', 'On']) {
      assert.ok(isDenied(run('Edit', yamlPath(), { AI_SDLC_UNTRUSTED_RUN: v })), v);
    }
  });
});

// ── AISDLC-720 round 2 — hardening ──────────────────────────────────────

describe('ai-sdlc-plugin enforce-blocked-actions hook (AISDLC-720 round 2)', () => {
  let dir;
  let outside;
  const U = { AI_SDLC_UNTRUSTED_RUN: '1' };

  before(() => {
    dir = join(tmpdir(), `enforce-blocked-720b-${Date.now()}`);
    outside = join(tmpdir(), `enforce-blocked-720b-out-${Date.now()}`);
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(outside, '.ai-sdlc'), { recursive: true });
    mkdirSync(join(outside, 'plain'), { recursive: true });
    writeFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), 'role: coding-agent\n');
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const run = (tool, file, env = {}, project = dir) =>
    runHookRaw(JSON.stringify({ tool_name: tool, tool_input: { file_path: file } }), {
      CLAUDE_PROJECT_DIR: project,
      GITHUB_ACTIONS: '',
      AI_SDLC_UNTRUSTED_RUN: '',
      ...env,
    });
  const bash = (command, env = {}) =>
    runHookRaw(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), {
      CLAUDE_PROJECT_DIR: dir,
      GITHUB_ACTIONS: '',
      AI_SDLC_UNTRUSTED_RUN: '',
      ...env,
    });

  it('#2 untrusted: protected paths OUTSIDE home are refused even if permittedExternalPaths allows them', () => {
    // permittedExternalPaths for AISDLC-720 is delivered via the task file + env fallback.
    mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(
      join(dir, 'backlog', 'tasks', 'aisdlc-720 - t.md'),
      `---\nid: AISDLC-720\npermittedExternalPaths:\n  - '${outside}'\n---\n`,
    );
    const env = { AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-720' };
    assert.ok(!isDenied(run('Write', join(outside, 'plain', 'a.txt'), env)), 'internal baseline');
    assert.ok(!isDenied(run('Write', join(outside, 'plain', 'a.txt'), { ...env, ...U })));
    assert.ok(!isDenied(run('Write', join(outside, '.ai-sdlc', 'x.yaml'), env)), 'internal ok');
    assert.ok(isDenied(run('Write', join(outside, '.ai-sdlc', 'x.yaml'), { ...env, ...U })));
    assert.ok(
      isDenied(run('Edit', join(outside, '.GitHub', 'Workflows', 'ci.yml'), { ...env, ...U })),
    );
  });

  it('#2 untrusted: .active-task writes are refused', () => {
    assert.ok(isDenied(run('Write', join(dir, '.active-task'), U)));
    assert.ok(!isDenied(run('Write', join(dir, '.active-task'))));
  });

  it('#3 untrusted: a symlink into a protected area cannot be used to write', () => {
    symlinkSync(join(dir, '.ai-sdlc'), join(dir, 'src', 'link'));
    const viaLink = join(dir, 'src', 'link', 'agent-role.yaml');
    assert.ok(isDenied(run('Write', viaLink, U)), 'file under symlinked dir');
    assert.ok(isDenied(run('Write', join(dir, 'src', 'link', 'new', 'deep.yaml'), U)), 'new file');
    assert.ok(!isDenied(run('Write', viaLink)), 'internal sessions unaffected');
  });

  it('#4 untrusted: .claude, .husky and plugin hooks are protected; internal is not', () => {
    for (const rel of [
      '.claude/settings.json',
      '.husky/pre-push',
      'ai-sdlc-plugin/hooks/enforce-blocked-actions.js',
    ]) {
      assert.ok(isDenied(run('Edit', join(dir, rel), U)), rel);
      assert.ok(!isDenied(run('Edit', join(dir, rel))), `internal ${rel}`);
    }
    assert.ok(isDenied(bash('echo x > .claude/settings.json', U)));
    assert.ok(isDenied(bash('sed -i s/a/b/ .husky/pre-push', U)));
  });

  it('#5 both plugin.json copies register MultiEdit on the write matcher', () => {
    const root = join(__dirname, '..');
    for (const f of ['plugin.json', join('.claude-plugin', 'plugin.json')]) {
      const j = JSON.parse(readFileSync(join(root, f), 'utf-8'));
      const matchers = j.hooks.PreToolUse.map((h) => h.matcher);
      const m = matchers.find((x) => x.includes('Write'));
      assert.ok(m && m.split('|').includes('MultiEdit'), `${f}: ${matchers.join(',')}`);
    }
  });

  it('#6 unknown non-empty signal values fail closed', () => {
    assert.ok(
      isDenied(
        run('Edit', join(dir, '.ai-sdlc', 'agent-role.yaml'), { AI_SDLC_UNTRUSTED_RUN: 'maybe' }),
      ),
    );
  });

  it('#7 untrusted shell: interpreters, cd+write, tar/unzip, tree rewrites', () => {
    for (const cmd of [
      `python3 -c "open('.ai-sdlc/agent-role.yaml','w').write('x')"`,
      `node -e "require('fs').writeFileSync('.github/workflows/ci.yml','x')"`,
      'cd .ai-sdlc && echo x > agent-role.yaml',
      'cd .github/workflows && cp /tmp/x ci.yml',
      'tar -xf /tmp/a.tar -C .ai-sdlc',
      'unzip /tmp/a.zip -d .github/workflows',
      'git switch other',
      'git am /tmp/p.patch',
      'git cherry-pick abc123',
      'git stash apply stash@{0}',
      'git reset --hard origin/main',
    ]) {
      assert.ok(isDenied(bash(cmd, U)), cmd);
      assert.ok(!isDenied(bash(cmd.replace(/git reset --hard.*/, 'true'))), `internal: ${cmd}`);
    }
    assert.ok(!isDenied(bash('node pipeline-cli/bin/cli-x.mjs --help', U)), 'plain node is fine');
  });

  it('#8 untrusted mixed-case paths and shell commands are refused', () => {
    assert.ok(isDenied(run('Write', join(dir, '.AI-SDLC', 'agent-role.yaml'), U)));
    assert.ok(isDenied(run('Edit', join(dir, '.Github', 'WORKFLOWS', 'ci.yml'), U)));
    assert.ok(isDenied(bash('echo x > .AI-SDLC/agent-role.yaml', U)));
    assert.ok(isDenied(bash('rm .GITHUB/Workflows/ci.yml', U)));
  });

  it('#9 untrusted run fails closed (exit 2) on unparseable input; internal does not', () => {
    const run2 = (env) => {
      const r = spawnSync('node', [hookScript], {
        input: 'not json',
        encoding: 'utf-8',
        env: {
          ...process.env,
          GITHUB_ACTIONS: '',
          CLAUDE_PROJECT_DIR: dir,
          AI_SDLC_UNTRUSTED_RUN: '',
          ...env,
        },
        timeout: 5000,
      });
      return r;
    };
    const u = run2(U);
    assert.equal(u.status, 2);
    assert.match(u.stderr, /untrusted/);
    const i = run2({});
    assert.equal(i.status, 0);
  });
});
