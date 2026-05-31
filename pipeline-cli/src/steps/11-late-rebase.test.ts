/**
 * Hermetic tests for Step 11 late-rebase (AISDLC-232).
 *
 * Covers:
 *   (a) clean rebase — origin/main is already ancestor → noop fast-forward
 *   (b) auto-resolvable CHANGELOG conflict → resolves + push proceeds
 *   (c) hard conflict → abort cleanly + outcome envelope well-formed
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import {
  lateRebase,
  resolveChangelogConflict,
  resolveTestConflict,
  tryResolveFile,
} from './11-late-rebase.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

// ── Unit: resolveChangelogConflict ───────────────────────────────────────────

describe('resolveChangelogConflict', () => {
  it('keeps both bullet sets when both sides are bullet-only', () => {
    const content = `## [Unreleased]
### Added
<<<<<<< HEAD
- feat A from branch
=======
- feat B from main
>>>>>>> origin/main
`;
    const result = resolveChangelogConflict(content);
    expect(result).not.toBeNull();
    expect(result).toContain('- feat B from main');
    expect(result).toContain('- feat A from branch');
    expect(result).not.toContain('<<<<<<<');
    expect(result).not.toContain('>>>>>>>');
    expect(result).not.toContain('=======');
  });

  it('incoming-from-main bullets come first', () => {
    const content = `<<<<<<< HEAD\n- branch bullet\n=======\n- main bullet\n>>>>>>> origin/main\n`;
    const result = resolveChangelogConflict(content);
    expect(result).not.toBeNull();
    const mainIdx = result!.indexOf('- main bullet');
    const branchIdx = result!.indexOf('- branch bullet');
    expect(mainIdx).toBeLessThan(branchIdx);
  });

  it('returns null when conflict contains non-bullet content (escalate)', () => {
    const content = `<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> origin/main\n`;
    expect(resolveChangelogConflict(content)).toBeNull();
  });

  it('returns content unchanged when no conflict markers', () => {
    const content = '## [Unreleased]\n- some bullet\n';
    expect(resolveChangelogConflict(content)).toBe(content);
  });

  it('escalates (returns null) when conflicted content exceeds 1 MB (ReDoS guard)', () => {
    // Oversized conflict → manual resolution; also bounds the double-lazy regex.
    const content = `<<<<<<< HEAD\n${'a'.repeat(1_000_001)}\n=======\nb\n>>>>>>> origin/main\n`;
    expect(content.length).toBeGreaterThan(1_000_000);
    expect(resolveChangelogConflict(content)).toBeNull();
  });
});

// ── Unit: resolveTestConflict ────────────────────────────────────────────────

describe('resolveTestConflict', () => {
  it('keeps both it() blocks when no shared identifiers', () => {
    const content = `describe('suite', () => {
<<<<<<< HEAD
  it('test A', () => {});
=======
  it('test B', () => {});
>>>>>>> origin/main
});`;
    const result = resolveTestConflict(content);
    expect(result).not.toBeNull();
    expect(result).toContain("it('test A'");
    expect(result).toContain("it('test B'");
    expect(result).not.toContain('<<<<<<<');
  });

  it('returns null when shared const identifier detected (escalate)', () => {
    const content = `<<<<<<< HEAD
  const helper = () => {};
  it('test A', () => {});
=======
  const helper = () => {};
  it('test B', () => {});
>>>>>>> origin/main`;
    expect(resolveTestConflict(content)).toBeNull();
  });

  it('returns null when conflict does not contain test calls (not a test conflict)', () => {
    const content = `<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> origin/main\n`;
    expect(resolveTestConflict(content)).toBeNull();
  });

  it('escalates (returns null) when conflicted content exceeds 1 MB (ReDoS guard)', () => {
    const content = `<<<<<<< HEAD\n${'a'.repeat(1_000_001)}\n=======\nb\n>>>>>>> origin/main\n`;
    expect(content.length).toBeGreaterThan(1_000_000);
    expect(resolveTestConflict(content)).toBeNull();
  });
});

// ── Unit: tryResolveFile ─────────────────────────────────────────────────────

describe('tryResolveFile', () => {
  it('resolves a CHANGELOG conflict in-place', () => {
    const changelogPath = join(tmp, 'CHANGELOG.md');
    writeFileSync(
      changelogPath,
      `## [Unreleased]\n### Added\n<<<<<<< HEAD\n- branch feature\n=======\n- main feature\n>>>>>>> origin/main\n`,
    );
    const result = tryResolveFile('CHANGELOG.md', tmp);
    expect(result).toBe(true);
    const resolved = readFileSync(changelogPath, 'utf8');
    expect(resolved).not.toContain('<<<<<<<');
    expect(resolved).toContain('- main feature');
    expect(resolved).toContain('- branch feature');
  });

  it('returns true when file has no conflict markers', () => {
    writeFileSync(join(tmp, 'clean.ts'), 'const x = 1;\n');
    expect(tryResolveFile('clean.ts', tmp)).toBe(true);
  });

  it('returns false for semantic conflict in non-changelog non-test file', () => {
    writeFileSync(
      join(tmp, 'service.ts'),
      `<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> origin/main\n`,
    );
    // Not a changelog or test file → cannot auto-resolve
    expect(tryResolveFile('service.ts', tmp)).toBe(false);
  });
});

// ── Integration: lateRebase ──────────────────────────────────────────────────

describe('lateRebase', () => {
  // AC7(a): clean rebase — origin/main is already ancestor → noop
  it('(a) returns ok=true when origin/main is already ancestor of HEAD', async () => {
    const fake = new FakeRunner()
      .on(/^git fetch origin main/, ok())
      // merge-base --is-ancestor exits 0 → already ancestor
      .on(/^git merge-base --is-ancestor/, ok());

    const result = await lateRebase({ worktreePath: tmp, runner: fake.toRunner() });

    expect(result.ok).toBe(true);
    expect(result.conflictingFiles).toEqual([]);
    expect(result.rebaseAttempts).toBe(0);
    // noop fast-forward: no files were auto-resolved
    expect(result.resolvedFiles).toEqual([]);

    // Verify it did NOT call git rebase (noop path)
    const rebaseCalls = fake.calls.filter(
      (c) => c.command === 'git' && c.args[0] === 'rebase' && c.args[1] === 'origin/main',
    );
    expect(rebaseCalls.length).toBe(0);
  });

  // AC7(b): auto-resolvable CHANGELOG conflict → resolves + push can proceed
  it('(b) auto-resolves CHANGELOG conflict and returns ok=true', async () => {
    // Write a conflicted CHANGELOG into the tmp dir
    writeFileSync(
      join(tmp, 'CHANGELOG.md'),
      `## [Unreleased]\n### Added\n<<<<<<< HEAD\n- branch feat\n=======\n- main feat\n>>>>>>> origin/main\n`,
    );

    const fake = new FakeRunner()
      .on(/^git fetch origin main/, ok())
      // merge-base --is-ancestor exits 1 → NOT ancestor (needs rebase)
      .on(/^git merge-base --is-ancestor/, fail('', 1))
      // First rebase attempt → fails with conflicts
      .on(
        /^git rebase origin\/main$/,
        fail('CONFLICT (content): Merge conflict in CHANGELOG.md', 1),
      )
      // git status --porcelain shows CHANGELOG.md as conflicted
      .on(/^git status --porcelain/, ok('UU CHANGELOG.md\n'))
      // prettier write → ok
      .on(/^pnpm exec prettier/, ok())
      // git add CHANGELOG.md → ok
      .on(/^git add CHANGELOG.md/, ok())
      // git rebase --continue → ok
      .on(/^git rebase --continue/, ok());

    const result = await lateRebase({ worktreePath: tmp, runner: fake.toRunner() });

    expect(result.ok).toBe(true);
    expect(result.conflictingFiles).toEqual([]);
    expect(result.rebaseAttempts).toBe(1);
    // CHANGELOG was auto-resolved → resolvedFiles must contain it
    expect(result.resolvedFiles).toContain('CHANGELOG.md');
  });

  // resolvedFiles is empty when clean rebase (no conflict, just fast-forward)
  it('returns resolvedFiles=[] when rebase is clean with no conflicts', async () => {
    const fake = new FakeRunner()
      .on(/^git fetch origin main/, ok())
      .on(/^git merge-base --is-ancestor/, fail('', 1))
      // Rebase succeeds cleanly (no conflicts at all)
      .on(/^git rebase origin\/main$/, ok());

    const result = await lateRebase({ worktreePath: tmp, runner: fake.toRunner() });

    expect(result.ok).toBe(true);
    expect(result.resolvedFiles).toEqual([]);
    expect(result.rebaseAttempts).toBe(1);
  });

  // AC7(c): hard conflict aborts cleanly + outcome envelope well-formed
  it('(c) aborts cleanly on semantic conflict and returns structured failure', async () => {
    // Write the conflicted file to the tmp root (not src/ subdir which may not exist)
    writeFileSync(
      join(tmp, 'service.ts'),
      `<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> origin/main\n`,
    );

    const fake = new FakeRunner()
      .on(/^git fetch origin main/, ok())
      .on(/^git merge-base --is-ancestor/, fail('', 1))
      .on(/^git rebase origin\/main$/, fail('CONFLICT (content): Merge conflict in service.ts', 1))
      .on(/^git status --porcelain/, ok('UU service.ts\n'))
      // git rebase --abort → ok
      .on(/^git rebase --abort/, ok());

    const result = await lateRebase({ worktreePath: tmp, runner: fake.toRunner() });

    expect(result.ok).toBe(false);
    expect(result.conflictingFiles).toContain('service.ts');
    expect(result.reason).toBeDefined();
    expect(typeof result.reason).toBe('string');
    expect(result.rebaseAttempts).toBe(1);

    // Verify git rebase --abort was called (clean abort)
    const abortCalls = fake.calls.filter((c) => c.command === 'git' && c.args.includes('--abort'));
    expect(abortCalls.length).toBeGreaterThan(0);
  });

  it('returns ok=false when git fetch fails', async () => {
    const fake = new FakeRunner().on(
      /^git fetch origin main/,
      fail('fatal: unable to connect to origin', 1),
    );

    const result = await lateRebase({ worktreePath: tmp, runner: fake.toRunner() });

    expect(result.ok).toBe(false);
    expect(result.conflictingFiles).toEqual([]);
    expect(result.reason).toMatch(/git fetch origin main failed/);
    expect(result.rebaseAttempts).toBe(0);
  });

  it('respects maxAttempts cap and returns failure after cap', async () => {
    const fake = new FakeRunner()
      .on(/^git fetch origin main/, ok())
      .on(/^git merge-base --is-ancestor/, fail('', 1))
      // Every rebase attempt fails with CHANGELOG conflict
      .on(/^git rebase origin\/main$/, fail('CONFLICT: Merge conflict in CHANGELOG.md', 1))
      .on(/^git status --porcelain/, ok('UU CHANGELOG.md\n'))
      // No CHANGELOG in tmp → tryResolveFile sees no conflict markers → returns true
      // But git rebase --continue also fails (simulating main still moving)
      .on(/^git rebase --continue/, fail('CONFLICT: another conflict', 1))
      .on(/^git rebase --abort/, ok())
      .on(/^git add/, ok())
      .on(/^pnpm exec prettier/, ok());

    // Write a resolvable CHANGELOG so tryResolveFile succeeds on first pass
    writeFileSync(
      join(tmp, 'CHANGELOG.md'),
      `<<<<<<< HEAD\n- branch\n=======\n- main\n>>>>>>> origin/main\n`,
    );

    const result = await lateRebase({ worktreePath: tmp, runner: fake.toRunner(), maxAttempts: 2 });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/iteration cap/);
  });
});

// ── Integration: pushAndPr with late-rebase ─────────────────────────────────

const integrationTask = {
  id: 'AISDLC-1',
  title: 'demo',
  status: 'In Progress',
  acceptanceCriteria: ['a'],
  acceptanceCriteriaChecked: [false],
  description: '',
  rawBody: '',
  filePath: '',
};
const integrationDev = {
  summary: 'shipped X',
  filesChanged: ['a.ts'],
  commitSha: 'abc',
  verifications: {
    build: 'passed' as const,
    test: 'passed' as const,
    lint: 'passed' as const,
    format: 'passed' as const,
  },
  acceptanceCriteriaMet: [1],
};
const integrationApproved = {
  approved: true,
  decision: 'APPROVED' as const,
  counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  verdicts: [
    {
      agentId: 'code-reviewer' as const,
      harness: 'claude-code' as const,
      approved: true,
      findings: [],
      summary: 'lgtm',
    },
  ],
  harnessNote: '',
  summary: 'APPROVED',
};

describe('Step 11 — pushAndPr with late-rebase (AISDLC-232)', () => {
  it('proceeds with push when late-rebase is a noop (already ancestor)', async () => {
    const { pushAndPr } = await import('./11-push-and-pr.js');

    const fake = new FakeRunner()
      // late-rebase: fetch ok, already ancestor → noop
      .on(/^git fetch origin main/, ok())
      .on(/^git merge-base --is-ancestor/, ok())
      // push
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/42\n'));

    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task: integrationTask,
      developerReturn: integrationDev,
      verdict: integrationApproved,
      runner: fake.toRunner(),
    });

    expect(r.pushed).toBe(true);
    expect(r.prUrl).toBe('https://github.com/x/y/pull/42');
    expect(r.rebaseConflict).toBeUndefined();
  });

  it('returns rebaseConflict when late-rebase fails with semantic conflict', async () => {
    const { pushAndPr } = await import('./11-push-and-pr.js');

    // Write to tmp root (src/ subdir may not exist in test tmp)
    writeFileSync(
      join(tmp, 'semantic.ts'),
      `<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> origin/main\n`,
    );

    const fake = new FakeRunner()
      // late-rebase: fetch ok, NOT ancestor
      .on(/^git fetch origin main/, ok())
      .on(/^git merge-base --is-ancestor/, fail('', 1))
      // rebase fails
      .on(/^git rebase origin\/main$/, fail('CONFLICT in semantic.ts', 1))
      .on(/^git status --porcelain/, ok('UU semantic.ts\n'))
      .on(/^git rebase --abort/, ok());

    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task: integrationTask,
      developerReturn: integrationDev,
      verdict: integrationApproved,
      runner: fake.toRunner(),
    });

    expect(r.pushed).toBe(false);
    expect(r.prUrl).toBeNull();
    expect(r.rebaseConflict).toBeDefined();
    expect(r.rebaseConflict!.files).toContain('semantic.ts');

    // Verify git push was NEVER called when rebase failed
    const pushCalls = fake.calls.filter(
      (c) => c.command === 'git' && c.args.some((a) => a === 'push'),
    );
    expect(pushCalls.length).toBe(0);
  });

  // AISDLC-232: re-sign attestation when lateRebase resolvedFiles is non-empty
  it('invokes sign-attestation + chore-commit before push when CHANGELOG was auto-resolved', async () => {
    const { pushAndPr } = await import('./11-push-and-pr.js');

    // Write resolvable CHANGELOG conflict
    writeFileSync(
      join(tmp, 'CHANGELOG.md'),
      `## [Unreleased]\n### Added\n<<<<<<< HEAD\n- branch feat\n=======\n- main feat\n>>>>>>> origin/main\n`,
    );

    // Create a fake sign-attestation.mjs script path that "exists" on disk
    const fakeSignScript = join(tmp, 'sign-attestation.mjs');
    writeFileSync(fakeSignScript, '// fake signer\n');

    const callOrder: string[] = [];

    const fake = new FakeRunner()
      // late-rebase: NOT ancestor → rebase needed
      .on(/^git fetch origin main/, ok())
      .on(/^git merge-base --is-ancestor/, fail('', 1))
      .on(/^git rebase origin\/main$/, fail('CONFLICT in CHANGELOG.md', 1))
      .on(/^git status --porcelain/, ok('UU CHANGELOG.md\n'))
      .on(/^pnpm exec prettier/, ok())
      .on(/^git add CHANGELOG/, ok())
      .on(/^git rebase --continue/, ok())
      // re-sign: node sign-attestation.mjs
      .on(/^node .+sign-attestation/, (_args) => {
        callOrder.push('sign');
        return ok('.ai-sdlc/attestations/abc123.dsse.json');
      })
      // git add .ai-sdlc/attestations
      .on(/^git add .ai-sdlc\/attestations/, (_args) => {
        callOrder.push('add-envelope');
        return ok();
      })
      // chore commit for re-sign
      .on(/^git commit/, (_args) => {
        callOrder.push('commit-re-sign');
        return ok();
      })
      // push + PR
      .on(/^git push -u origin/, (_args) => {
        callOrder.push('push');
        return ok();
      })
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/99\n'));

    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task: integrationTask,
      developerReturn: integrationDev,
      verdict: integrationApproved,
      runner: fake.toRunner(),
      signAttestationScript: fakeSignScript,
    });

    expect(r.pushed).toBe(true);
    expect(r.prUrl).toBe('https://github.com/x/y/pull/99');

    // sign → add-envelope → commit-re-sign must ALL happen before push
    expect(callOrder).toContain('sign');
    expect(callOrder).toContain('add-envelope');
    expect(callOrder).toContain('commit-re-sign');
    expect(callOrder).toContain('push');
    const signIdx = callOrder.indexOf('sign');
    const pushIdx = callOrder.indexOf('push');
    expect(signIdx).toBeLessThan(pushIdx);
    const commitIdx = callOrder.indexOf('commit-re-sign');
    expect(commitIdx).toBeLessThan(pushIdx);
  });

  it('skips re-sign and still pushes when signAttestationScript is absent', async () => {
    const { pushAndPr } = await import('./11-push-and-pr.js');

    // Write resolvable CHANGELOG conflict
    writeFileSync(
      join(tmp, 'CHANGELOG.md'),
      `## [Unreleased]\n### Added\n<<<<<<< HEAD\n- branch feat\n=======\n- main feat\n>>>>>>> origin/main\n`,
    );

    // No signAttestationScript provided, CLAUDE_PLUGIN_ROOT unset → no signer
    const savedEnv = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;

    const fake = new FakeRunner()
      .on(/^git fetch origin main/, ok())
      .on(/^git merge-base --is-ancestor/, fail('', 1))
      .on(/^git rebase origin\/main$/, fail('CONFLICT in CHANGELOG.md', 1))
      .on(/^git status --porcelain/, ok('UU CHANGELOG.md\n'))
      .on(/^pnpm exec prettier/, ok())
      .on(/^git add CHANGELOG/, ok())
      .on(/^git rebase --continue/, ok())
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/77\n'));

    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task: integrationTask,
      developerReturn: integrationDev,
      verdict: integrationApproved,
      runner: fake.toRunner(),
      // No signAttestationScript → signer absent
    });

    // Restore env
    if (savedEnv !== undefined) process.env.CLAUDE_PLUGIN_ROOT = savedEnv;

    // Push should still succeed (signer absence is non-fatal — pre-push hook fallback handles it)
    expect(r.pushed).toBe(true);
    expect(r.prUrl).toBe('https://github.com/x/y/pull/77');

    // No node sign-attestation call should have been made
    const signCalls = fake.calls.filter((c) => c.command === 'node');
    expect(signCalls.length).toBe(0);
  });
});
