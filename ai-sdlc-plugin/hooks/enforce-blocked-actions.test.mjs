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
import { join, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
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
  // A sibling repository (AISDLC-605: plain temp dirs are scratch space, git repos are not).
  mkdirSync(join(siblingDir, '.git'), { recursive: true });
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

  it('allows gh pr create', () => {
    const result = runHook('gh pr create --title "test"');
    assert.ok(!isDenied(result), 'should allow gh pr create');
  });

  // AISDLC-1014 (DEC-0267): no command-text matching. Free text that merely mentions a
  // blocked-action phrase (jq expressions, paths, echo strings, heredoc bodies) is never refused.
  const PHRASES = [
    ['gh', 'pr', 'merge'],
    ['gh', 'pr', 'close'],
    ['gh', 'issue', 'close'],
    ['git', 'merge'],
    ['git', 'reset', '--hard'],
    ['git', 'branch', '-D'],
    ['git', 'stash', 'drop'],
    ['git', 'stash', 'pop'],
  ].map((w) => w.join(' '));

  for (const phrase of PHRASES) {
    it(`does not refuse the phrase "${phrase}" in a jq expression, path, echo string or heredoc`, () => {
      const commands = [
        `gh pr view 5 --json state --jq '.note | test("${phrase}")'`,
        `cat docs/notes-${phrase.replace(/ /g, '-')}.md`,
        `echo "never run ${phrase} by hand"`,
        `cat <<'EOF' > notes.md\nhandoff: ${phrase} is a blocked action\nEOF`,
        `git log --oneline --grep="${phrase}"`,
      ];
      for (const command of commands) {
        const result = runHook(command);
        assert.ok(!isDenied(result), `should not refuse: ${command}`);
        assert.equal(result.output, '');
      }
    });
  }

  it('no longer matches blockedActions patterns configured in agent-role.yaml', () => {
    assert.ok(!isDenied(runHook('gh pr merge 42')));
    assert.ok(!isDenied(runHook('git reset --hard HEAD~1')));
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
    const otherSibling = join(homedir(), 'aisdlc-605-some-other-dir');
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
    mkdirSync(join(siblingA, '.git'), { recursive: true });
    mkdirSync(join(siblingB, '.git'), { recursive: true });
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
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        CLAUDE_PROJECT_DIR: staleParent,
        AI_SDLC_STALE_BASE_TTL_SECONDS: '0',
        ...env,
      },
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

  it('AISDLC-569: throttles the git check via a cache file (no subprocess within the TTL)', () => {
    const cacheDir = join(tmpdir(), `enforce-blocked-stale-cache-${Date.now()}`);
    const env = { AI_SDLC_STALE_BASE_TTL_SECONDS: '600', AI_SDLC_STALE_BASE_CACHE_DIR: cacheDir };
    const payload = {
      tool_name: 'Write',
      tool_input: { file_path: join(staleWorktree, 'throttle.ts') },
      cwd: staleWorktree,
    };
    try {
      // Make the worktree stale again: origin advances, worktree fetches.
      writeFileSync(join(staleOrigin, 'file.txt'), 'v3\n');
      execSync('git commit -qam third', { cwd: staleOrigin });
      execSync('git fetch -q origin main', { cwd: staleWorktree });
      const first = runHookCaptureStderr(payload, env);
      assert.match(first.stderr, /behind origin\/main/i, 'first call performs the live check');
      // Rebase: a live check would now report 0 behind; the cache must still answer.
      execSync('git rebase -q origin/main', { cwd: staleWorktree });
      const second = runHookCaptureStderr(payload, env);
      assert.match(second.stderr, /behind origin\/main/i, 'second call served from cache');
      // Expired/disabled TTL re-checks live.
      const third = runHookCaptureStderr(payload, {
        ...env,
        AI_SDLC_STALE_BASE_TTL_SECONDS: '0',
      });
      assert.doesNotMatch(third.stderr, /behind origin\/main/i, 'ttl 0 bypasses the cache');
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

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

  it('AISDLC-740: untrusted shell writes to $GITHUB_ENV / $GITHUB_PATH are refused', () => {
    for (const cmd of [
      'echo AI_SDLC_INTERNAL_RUN=1 >> $GITHUB_ENV',
      'echo AI_SDLC_INTERNAL_RUN=1 >> "$GITHUB_ENV"',
      'echo x >> ${GITHUB_PATH}',
      'echo AI_SDLC_INTERNAL_RUN=1 | tee -a "$GITHUB_ENV"',
    ]) {
      const r = bash(cmd, UNTRUSTED);
      assert.ok(isDenied(r), cmd);
    }
    assert.ok(!isDenied(bash('echo $GITHUB_ENV', UNTRUSTED)), 'reading the name is fine');
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

// ── AISDLC-730 — untrusted marker file survives a child agent clearing its env ──

describe('ai-sdlc-plugin enforce-blocked-actions hook (AISDLC-730: untrusted marker)', () => {
  let repo;
  let wtGitDir;
  const yamlPath = () => join(repo, '.ai-sdlc', 'agent-role.yaml');
  // An environment with every signal cleared, as a `claude -p` child with a wiped env would have.
  const CLEARED = { AI_SDLC_UNTRUSTED_RUN: '', AI_SDLC_UNTRUSTED_REASON: '', GITHUB_ACTIONS: '' };

  before(() => {
    repo = join(tmpdir(), `enforce-blocked-730-${Date.now()}`);
    mkdirSync(join(repo, '.ai-sdlc'), { recursive: true });
    writeFileSync(yamlPath(), 'role: coding-agent\nblockedActions: []\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    // A linked-worktree-shaped checkout: `.git` is a file pointing at a git dir elsewhere.
    wtGitDir = join(repo, 'gitdirs', 'wt');
    mkdirSync(wtGitDir, { recursive: true });
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  const call = (tool, input, cwd, env = CLEARED) =>
    runHookRaw(JSON.stringify({ tool_name: tool, tool_input: input, cwd }), {
      CLAUDE_PROJECT_DIR: repo,
      ...env,
    });

  it('marker present + environment cleared: protected writes are still refused', () => {
    writeFileSync(join(wtGitDir, 'ai-sdlc-untrusted'), 'gh-issue source\n');
    const wt = join(repo, 'wt');
    mkdirSync(join(wt, 'sub'), { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGitDir}\n`);
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const r = call(tool, { file_path: join(wt, '.ai-sdlc', 'agent-role.yaml') }, join(wt, 'sub'));
      assert.ok(isDenied(r), tool);
      assert.match(
        JSON.parse(r.output).hookSpecificOutput.permissionDecisionReason,
        /gh-issue source/,
      );
    }
    assert.ok(isDenied(call('Bash', { command: 'echo x > .ai-sdlc/agent-role.yaml' }, wt)));
    assert.ok(
      !isDenied(call('Write', { file_path: join(wt, 'src', 'a.ts') }, wt)),
      'other paths ok',
    );
  });

  it('an untrusted run cannot delete or rewrite the marker itself', () => {
    const wt = join(repo, 'wt');
    const marker = join(wtGitDir, 'ai-sdlc-untrusted');
    assert.ok(isDenied(call('Write', { file_path: marker }, wt)));
    assert.ok(isDenied(call('Bash', { command: `rm ${marker}` }, wt)));
    assert.ok(isDenied(call('Bash', { command: 'rm -f ../gitdirs/wt/ai-sdlc-untrusted' }, wt)));
  });

  it('AISDLC-730: a nested .git created inside the marked checkout does not hide the marker', () => {
    const wt = join(repo, 'wt');
    const nested = join(wt, 'nested');
    mkdirSync(join(nested, '.git'), { recursive: true });
    assert.ok(isDenied(call('Write', { file_path: join(wt, '.ai-sdlc', 'x.yaml') }, nested)));
  });

  it('AISDLC-730: an untrusted run cannot write, replace or create a .git entry or worktree admin dir', () => {
    const wt = join(repo, 'wt');
    assert.ok(isDenied(call('Write', { file_path: join(wt, '.git') }, wt)));
    assert.ok(isDenied(call('Edit', { file_path: join(wt, 'x', '.git') }, wt)));
    assert.ok(
      isDenied(call('Write', { file_path: join(repo, '.git', 'worktrees', 'w', 'gitdir') }, wt)),
    );
    assert.ok(isDenied(call('Bash', { command: 'echo "gitdir: /nonexistent" > .git' }, wt)));
    assert.ok(isDenied(call('Bash', { command: 'rm -f .git' }, wt)));
    assert.ok(isDenied(call('Bash', { command: 'mv .git .git.bak' }, wt)));
    assert.ok(isDenied(call('Bash', { command: 'rm -rf ../.git/worktrees/wt' }, wt)));
    assert.ok(isDenied(call('Bash', { command: 'mv ../gitdirs/wt/ai-sdlc-unt* /tmp/x' }, wt)));
    assert.ok(isDenied(call('Bash', { command: 'rm ../gitdirs/wt/ai-sdlc-unt?usted' }, wt)));
    // ordinary git use and unrelated files stay allowed
    assert.ok(!isDenied(call('Bash', { command: 'git status && ls .git' }, wt)));
    assert.ok(!isDenied(call('Bash', { command: 'git remote add o https://x/y.git' }, wt)));
    assert.ok(!isDenied(call('Write', { file_path: join(wt, 'repo.github', 'a.ts') }, wt)));
  });

  it('regression: a trusted local session (no signal, no marker) edits .ai-sdlc with zero prompts', () => {
    const trusted = join(repo, 'trusted');
    mkdirSync(join(trusted, '.git'), { recursive: true });
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const r = call(tool, { file_path: yamlPath() }, trusted);
      assert.equal(r.exitCode, 0);
      assert.equal(r.output, '', `${tool} produces no deny and no ask`);
    }
    const sh = call('Bash', { command: 'echo x >> .ai-sdlc/reviews/aisdlc-730.jsonl' }, trusted);
    assert.equal(sh.output, '');
  });
});

// ── AISDLC-605: scratch / temp directories under worktree confinement ──

describe('ai-sdlc-plugin enforce-blocked-actions hook (scratch dirs, AISDLC-605)', () => {
  let proj;
  let wt;
  let otherWt;
  let scratchPlain;
  let scratchRepo;

  before(() => {
    proj = join(tmpdir(), `enforce-blocked-605-proj-${Date.now()}`);
    wt = join(proj, '.worktrees', 'aisdlc-605');
    otherWt = join(proj, '.worktrees', 'aisdlc-606');
    scratchPlain = join(tmpdir(), `enforce-blocked-605-scratch-${Date.now()}`);
    scratchRepo = join(tmpdir(), `enforce-blocked-605-repo-${Date.now()}`);
    mkdirSync(join(proj, '.ai-sdlc'), { recursive: true });
    mkdirSync(join(proj, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(wt, { recursive: true });
    mkdirSync(otherWt, { recursive: true });
    mkdirSync(scratchPlain, { recursive: true });
    mkdirSync(join(scratchRepo, '.git'), { recursive: true });
    writeFileSync(join(wt, '.active-task'), 'AISDLC-605\n');
    writeFileSync(
      join(proj, '.ai-sdlc', 'agent-role.yaml'),
      `role: coding-agent\ngoal: Test agent\nblockedPaths:\n  - '.github/workflows/**'\nblockedActions: []\n`,
    );
  });

  after(() => {
    for (const d of [proj, scratchPlain, scratchRepo]) rmSync(d, { recursive: true, force: true });
  });

  function write(toolName, file_path, extraEnv = {}) {
    return runHookRaw(JSON.stringify({ tool_name: toolName, tool_input: { file_path }, cwd: wt }), {
      CLAUDE_PROJECT_DIR: proj,
      ...extraEnv,
    });
  }

  for (const tool of ['Write', 'Edit']) {
    it(`${tool} to an OS temp directory is allowed by default`, () => {
      assert.ok(!isDenied(write(tool, join(scratchPlain, 'notes.txt'))));
      assert.ok(!isDenied(write(tool, join(scratchPlain, 'deep', 'er', 'notes.txt'))));
    });

    it(`${tool} does not treat TMPDIR=/, home, or an ancestor of home as scratch`, () => {
      for (const bad of [sep, homedir(), dirname(homedir())]) {
        const target = join(homedir(), 'aisdlc-605-nonexistent', 'a.ts');
        assert.ok(isDenied(write(tool, target, { TMPDIR: bad })), `TMPDIR=${bad}`);
      }
    });

    it(`${tool} to the session scratch directory (CLAUDE_SCRATCHPAD_DIR) is allowed`, () => {
      const scratch = join(tmpdir(), `enforce-blocked-605-session-${Date.now()}`, 'scratchpad');
      assert.ok(
        !isDenied(write(tool, join(scratch, 'x.json'), { CLAUDE_SCRATCHPAD_DIR: scratch })),
      );
    });

    it(`${tool} confinement is unchanged for the main checkout, other worktrees and sibling repos`, () => {
      assert.ok(isDenied(write(tool, join(proj, 'README.md'))), 'main checkout');
      assert.ok(isDenied(write(tool, join(otherWt, 'src', 'a.ts'))), 'other worktree');
      assert.ok(isDenied(write(tool, join(scratchRepo, 'a.ts'))), 'sibling repo in a temp dir');
      assert.ok(isDenied(write(tool, join(homedir(), 'aisdlc-605-nonexistent', 'a.ts'))));
    });
  }

  for (const tool of ['Write', 'Edit']) {
    it(`${tool} through a symlink in a temp dir that points outside scratch is denied`, () => {
      const target = join('/usr', 'local', 'aisdlc-605-symlink-target-nonexistent');
      const link = join(scratchPlain, `escape-link-${tool}`);
      symlinkSync(target, link);
      assert.ok(isDenied(write(tool, join(link, 'index.ts'))), 'link to a non-scratch dir');
      const repoLink = join(scratchPlain, `repo-link-${tool}`);
      symlinkSync(scratchRepo, repoLink);
      assert.ok(isDenied(write(tool, join(repoLink, 'src', 'index.ts'))), 'link to a sibling repo');
    });
  }

  it('a dangling symlink chain deeper than the cap is denied, not judged lexically', () => {
    const base = join(scratchPlain, 'chain');
    mkdirSync(base, { recursive: true });
    const missing = join(base, 'never-created');
    // link0 -> link1 -> ... -> link19 -> never-created (all dangling)
    symlinkSync(missing, join(base, 'link19'));
    for (let i = 18; i >= 0; i--) symlinkSync(join(base, `link${i + 1}`), join(base, `link${i}`));
    for (const tool of ['Write', 'Edit']) {
      assert.ok(isDenied(write(tool, join(base, 'link0'))), `${tool} through a >16 link chain`);
    }
  });

  it('a project root that itself lives under a temp dir gains no scratch allowance', () => {
    assert.ok(isDenied(write('Write', join(proj, 'backlog', 'tasks', 'x.md'))));
  });
});

describe('ai-sdlc-plugin enforce-blocked-actions hook (AISDLC-569 realpath containment)', () => {
  let proj;
  let outside;
  let wt;
  let realProj;

  before(() => {
    const base = join(tmpdir(), `enforce-blocked-realpath-${Date.now()}`);
    proj = join(base, 'proj');
    outside = join(base, 'outside');
    wt = join(proj, '.worktrees', 'aisdlc-569');
    mkdirSync(join(proj, '.ai-sdlc'), { recursive: true });
    mkdirSync(join(wt, 'src'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(proj, '.ai-sdlc', 'agent-role.yaml'),
      `role: coding-agent
goal: Test agent
blockedPaths:
  - 'secret/**'
blockedActions: []
`,
    );
    writeFileSync(join(wt, '.active-task'), 'AISDLC-569\n');
    symlinkSync(outside, join(wt, 'src', 'escape'));
    mkdirSync(join(wt, 'secret'), { recursive: true });
    symlinkSync(join(wt, 'secret'), join(wt, 'src', 'tosecret'));
    // A symlinked project alias must still work as home.
    realProj = join(base, 'alias');
    symlinkSync(proj, realProj);
  });

  after(() => {
    rmSync(join(proj, '..'), { recursive: true, force: true });
  });

  function run(file_path, projectDir = proj, cwd = wt) {
    const result = spawnSync('node', [hookScript], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path }, cwd }),
      encoding: 'utf-8',
      env: { ...process.env, GITHUB_ACTIONS: '', CLAUDE_PROJECT_DIR: projectDir },
      timeout: 5000,
    });
    return (result.stdout || '').trim();
  }

  it('refuses a write through a symlink inside the worktree that points outside', () => {
    assert.match(run(join(wt, 'src', 'escape', 'x.ts')), /"deny"/);
  });

  it('refuses a write through a symlink that lands on a blockedPaths directory', () => {
    assert.match(run(join(wt, 'src', 'tosecret', 'x.ts')), /"deny"/);
  });

  it('still allows ordinary writes inside the worktree', () => {
    assert.equal(run(join(wt, 'src', 'ok.ts')), '');
  });

  it('still works when the project root is reached through a symlink', () => {
    const aliasWt = join(realProj, '.worktrees', 'aisdlc-569');
    assert.equal(run(join(aliasWt, 'src', 'ok.ts'), realProj, aliasWt), '');
  });
});

describe('enforce-blocked-actions: paired opencode blockedPaths entries (AISDLC-839)', () => {
  // The six entries as listed in .ai-sdlc/agent-role.yaml. matchGlob turns
  // `**/x` into `.*/x` (a slash is required) and `x` into a literal, so the
  // root and nested entries of each pair are NOT interchangeable and no
  // single glob the matcher supports equals both (`**x` would also block
  // `fooopencode.json`). The pairs therefore stay unfolded; these tests pin
  // that each original string keeps blocking and that the over-block a fold
  // would introduce does not exist today.
  const entries = [
    'opencode.json',
    'opencode.jsonc',
    '.opencode/**',
    '**/opencode.json',
    '**/opencode.jsonc',
    '**/.opencode/**',
  ];
  let dir;

  before(() => {
    dir = join(tmpdir(), `enforce-blocked-opencode-${Date.now()}`);
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(dir, '.ai-sdlc', 'agent-role.yaml'),
      `role: coding-agent
goal: Test agent
blockedPaths:
${entries.map((e) => `  - '${e}'`).join('\n')}
blockedActions: []
`,
    );
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const denied = (rel) =>
    isDenied(
      runHookRaw(
        JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(dir, rel) } }),
        { CLAUDE_PROJECT_DIR: dir },
      ),
    );

  for (const rel of [
    'opencode.json',
    'opencode.jsonc',
    '.opencode/plugin.js',
    'pkg/opencode.json',
    'a/b/opencode.jsonc',
    'pkg/.opencode/plugin.js',
  ]) {
    it(`blocks ${rel}`, () => assert.ok(denied(rel)));
  }

  it('repo agent-role.yaml still lists every original entry', () => {
    const real = readFileSync(join(__dirname, '..', '..', '.ai-sdlc', 'agent-role.yaml'), 'utf-8');
    for (const e of entries) assert.ok(real.includes(`- '${e}'`), `missing ${e}`);
  });

  for (const rel of ['fooopencode.json', 'foo.opencode/x.js']) {
    it(`does not block ${rel} (a folded '**x' glob would)`, () => assert.ok(!denied(rel)));
  }
});
