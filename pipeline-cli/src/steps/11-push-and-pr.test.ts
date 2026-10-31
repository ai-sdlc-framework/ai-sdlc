import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkClobberSignature,
  composeBody,
  composeTitle,
  pushAndPr,
  readTitleTemplate,
} from './11-push-and-pr.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import type { AggregatedVerdict, DeveloperReturn, TaskSpec } from '../types.js';
import { eventsFilePath } from '../orchestrator/events.js';

let tmp: string;
beforeEach(() => {
  // The lease-push preflight reads the session env (AISDLC-798); keep it hermetic.
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
  vi.stubEnv('AI_SDLC_HIERARCHY_ROLE', '');
  tmp = makeTmpProject();
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTmpProject(tmp);
});

const task: TaskSpec = {
  id: 'AISDLC-1',
  title: 'demo',
  status: 'In Progress',
  acceptanceCriteria: ['a'],
  acceptanceCriteriaChecked: [false],
  description: '',
  rawBody: '',
  filePath: '',
};

const dev: DeveloperReturn = {
  summary: 'shipped X',
  filesChanged: ['a.ts'],
  commitSha: 'abc',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1],
};

const approved: AggregatedVerdict = {
  approved: true,
  decision: 'APPROVED',
  counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  verdicts: [
    {
      agentId: 'code-reviewer',
      harness: 'claude-code',
      approved: true,
      findings: [],
      summary: 'lgtm',
    },
  ],
  harnessNote: '',
  summary: 'APPROVED',
};

function makeRecordingLogger() {
  const warnings: string[] = [];
  const logger = {
    info: () => undefined,
    warn: (m: string) => warnings.push(m),
    error: () => undefined,
    progress: () => undefined,
    warnings,
  };
  return logger;
}

describe('Step 11 — readTitleTemplate', () => {
  it('returns default when yaml missing', () => {
    expect(readTitleTemplate('/no/such')).toMatch(/feat: \{issueTitle\}/);
  });

  it('reads pullRequest.titleTemplate from legacy pipeline-backlog.yaml (deprecated shim, warns)', () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `pullRequest:\n  titleTemplate: 'fix: {issueTitle} ({issueId})'\n`,
    );
    const logger = makeRecordingLogger();
    expect(readTitleTemplate(tmp, logger)).toBe('fix: {issueTitle} ({issueId})');
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toMatch(/DEPRECATION/);
    expect(logger.warnings[0]).toMatch(/pipeline-backlog\.yaml/);
  });

  it('reads pullRequest.titleTemplate from pipeline.yaml spec.backlog section (canonical, AISDLC-245.5)', () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      [
        'spec:',
        '  backlog:',
        '    pullRequest:',
        "      titleTemplate: 'chore: {issueTitle} ({issueId})'",
      ].join('\n') + '\n',
    );
    const logger = makeRecordingLogger();
    expect(readTitleTemplate(tmp, logger)).toBe('chore: {issueTitle} ({issueId})');
    // Canonical path MUST NOT emit deprecation warning
    expect(logger.warnings).toHaveLength(0);
  });

  it('prefers pipeline.yaml over pipeline-backlog.yaml for title template (canonical wins, no warning)', () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      [
        'spec:',
        '  backlog:',
        '    pullRequest:',
        "      titleTemplate: 'canonical: {issueTitle}'",
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `pullRequest:\n  titleTemplate: 'legacy: {issueTitle}'\n`,
    );
    const logger = makeRecordingLogger();
    expect(readTitleTemplate(tmp, logger)).toBe('canonical: {issueTitle}');
    expect(logger.warnings).toHaveLength(0);
  });

  it('does not warn when legacy file exists but lacks titleTemplate (returns default)', () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'), 'branching:\n  pattern: x\n');
    const logger = makeRecordingLogger();
    expect(readTitleTemplate(tmp, logger)).toMatch(/feat: \{issueTitle\}/);
    expect(logger.warnings).toHaveLength(0);
  });

  // AISDLC-245.5 round-2 code-reviewer MAJOR regression: when spec.backlog
  // exists but lacks pullRequest, the lookup MUST NOT fall through to a
  // sibling spec.pullRequest.titleTemplate (which is a different config).
  // Pre-fix the broad regex would silently misread spec.pullRequest.titleTemplate
  // as if it were spec.backlog.pullRequest.titleTemplate.
  it('does NOT cross spec.backlog into sibling spec.pullRequest (section-scoped)', () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      [
        'spec:',
        '  backlog:',
        '    branching:',
        "      pattern: 'ai-sdlc/{issueIdLower}'",
        '  pullRequest:',
        "    titleTemplate: 'WRONG: {issueTitle}'",
      ].join('\n') + '\n',
    );
    const logger = makeRecordingLogger();
    // backlog has no pullRequest.titleTemplate → MUST return default,
    // NOT 'WRONG: {issueTitle}' from the sibling spec.pullRequest.
    expect(readTitleTemplate(tmp, logger)).toMatch(/feat: \{issueTitle\}/);
    expect(logger.warnings).toHaveLength(0);
  });
});

// AISDLC-245.5 — migration equivalence: an adopter who edits pipeline-backlog.yaml
// today must get the IDENTICAL title template after migrating to pipeline.yaml's
// spec.backlog.pullRequest.titleTemplate. Mirror of the step-02 migration test.
describe('Step 11 — readTitleTemplate migration equivalence (AISDLC-245.5)', () => {
  const TEMPLATES = [
    'feat: {issueTitle} ({issueId})',
    'fix: {issueTitle} ({issueId})',
    'chore: {issueTitle}',
  ];

  for (const template of TEMPLATES) {
    it(`legacy and canonical produce same template: ${template}`, () => {
      // Legacy
      mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
        `pullRequest:\n  titleTemplate: '${template}'\n`,
      );
      const legacyLogger = makeRecordingLogger();
      const legacyResult = readTitleTemplate(tmp, legacyLogger);

      // Canonical (in a fresh project, otherwise pipeline.yaml would win in tmp)
      const canonicalDir = makeTmpProject();
      try {
        mkdirSync(join(canonicalDir, '.ai-sdlc'), { recursive: true });
        writeFileSync(
          join(canonicalDir, '.ai-sdlc', 'pipeline.yaml'),
          ['spec:', '  backlog:', '    pullRequest:', `      titleTemplate: '${template}'`].join(
            '\n',
          ) + '\n',
        );
        const canonicalLogger = makeRecordingLogger();
        const canonicalResult = readTitleTemplate(canonicalDir, canonicalLogger);

        expect(canonicalResult).toBe(legacyResult);
        expect(canonicalResult).toBe(template);
        expect(canonicalLogger.warnings).toHaveLength(0);
        expect(legacyLogger.warnings).toHaveLength(1);
        expect(legacyLogger.warnings[0]).toMatch(/DEPRECATION/);
      } finally {
        cleanupTmpProject(canonicalDir);
      }
    });
  }
});

describe('Step 11 — composeTitle', () => {
  it('substitutes both vars', () => {
    expect(composeTitle('{issueTitle} ({issueId})', 'AISDLC-1', 'demo', false)).toBe(
      'demo (AISDLC-1)',
    );
  });

  it('appends [needs-human-attention] when flagged', () => {
    expect(composeTitle('{issueTitle} ({issueId})', 'AISDLC-1', 'demo', true)).toBe(
      'demo [needs-human-attention] (AISDLC-1)',
    );
  });

  // AISDLC-393 — GH-issue path: {issueId} is swapped for `closes #N` so the
  // title reads e.g. `feat: demo (closes #612)` and GitHub auto-closes on merge.
  it('substitutes {issueId} with `closes #N` for gh-issue source (AISDLC-393)', () => {
    expect(
      composeTitle('feat: {issueTitle} ({issueId})', 'gh-issue-612', 'demo', false, {
        sourceKind: 'gh-issue',
        issueNumber: 612,
      }),
    ).toBe('feat: demo (closes #612)');
  });

  it('still appends [needs-human-attention] on gh-issue path (AISDLC-393)', () => {
    expect(
      composeTitle('feat: {issueTitle} ({issueId})', 'gh-issue-7', 'demo', true, {
        sourceKind: 'gh-issue',
        issueNumber: 7,
      }),
    ).toBe('feat: demo [needs-human-attention] (closes #7)');
  });
});

describe('Step 11 — composeBody', () => {
  it('records the pinned pipeline sha of the hotfix lane (AISDLC-1024)', () => {
    const base = {
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
    };
    expect(composeBody({ ...base, pipelineRef: 'abc1234' })).toContain(
      'pinned pipeline-cli build abc1234',
    );
    expect(composeBody(base)).not.toContain('Pipeline build');
  });

  it('produces a body with summary, files, and code-reviewer block', () => {
    const body = composeBody({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
    });
    expect(body).toContain('shipped X');
    expect(body).toContain('- a.ts');
    expect(body).toContain('Code reviewer verdict');
    expect(body).toContain('lgtm');
    expect(body).toContain('References AISDLC-1');
  });

  it('includes the DEC-0202 waiver section with tests and evidence', () => {
    const body = composeBody({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: {
        ...dev,
        verifications: { ...dev.verifications, test: 'waived' },
        testWaiver: { tests: ['flaky > case'], passesAlone: 'passed alone x3', untouched: true },
      },
      verdict: approved,
    });
    expect(body).toContain('Local test waiver (DEC-0202)');
    expect(body).toContain('- flaky > case');
    expect(body).toContain('passed alone x3');
  });

  it('omits the judgment section when there is nothing to report', () => {
    const base = {
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
    };
    const plain = composeBody(base);
    expect(plain).not.toContain('Judgment notes');
    expect(
      composeBody({
        ...base,
        acCoverage: {
          criteria: [{ index: 0, probability: 0.9, likelyUncovered: false }],
          uncovered: 0,
        },
        groundingAnnotations: [
          {
            agentId: 'code-reviewer',
            findingIndex: 0,
            file: 'a.ts',
            line: 1,
            relation: 'supports',
          },
        ],
      }),
    ).toBe(plain);
  });

  it('adds an advisory judgment section when something is flagged', () => {
    const body = composeBody({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: {
        ...approved,
        groundingAnnotations: [
          {
            agentId: 'code-reviewer',
            findingIndex: 0,
            file: 'a.ts',
            line: 9,
            relation: 'contradicts',
          },
        ],
      },
      acCoverage: {
        criteria: [{ index: 0, probability: 0.1, likelyUncovered: true }],
        uncovered: 1,
      },
    });
    expect(body).toContain('## Judgment notes (advisory)');
    expect(body).toContain('a.ts:9');
    const section = body.slice(body.indexOf('## Judgment notes'), body.indexOf('References'));
    expect(section).not.toMatch(/AISDLC/);
    expect(body.indexOf('Judgment notes')).toBeLessThan(body.indexOf('References AISDLC-1'));
  });

  it('opens with the [needs-human-attention] warning when flagged', () => {
    const body = composeBody({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      needsHumanAttention: true,
    });
    expect(body).toMatch(/⚠ This PR exceeded the auto-iteration cap/);
  });

  // AISDLC-393 — GH-issue path: body opens with `Closes #N` (auto-closes
  // the issue on merge) and the footer's `References <taskId>` line is
  // replaced with `Closes #N`.
  it('prepends Closes #N and replaces References footer for gh-issue source (AISDLC-393)', () => {
    const body = composeBody({
      taskId: 'gh-issue-612',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      sourceKind: 'gh-issue',
      issueNumber: 612,
    });
    // Opens with Closes #N (above the summary)
    expect(body.startsWith('Closes #612\n')).toBe(true);
    // Footer is `Closes #N`, not `References gh-issue-612`
    expect(body.endsWith('\nCloses #612\n')).toBe(true);
    expect(body).not.toContain('References gh-issue-612');
  });

  it('keeps References footer for backlog source (no regression on AISDLC-393)', () => {
    const body = composeBody({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      sourceKind: 'backlog',
    });
    expect(body).toContain('References AISDLC-1');
    expect(body).not.toContain('Closes #');
  });
});

describe('Step 11 — pushAndPr', () => {
  it('happy path returns prUrl', async () => {
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/1\n'));
    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    expect(r.pushed).toBe(true);
    expect(r.prUrl).toBe('https://github.com/x/y/pull/1');
  });

  // AISDLC-218: regression guard — `gh pr create` must include `--draft`.
  // Without this assertion, removing the flag wouldn't be caught by any
  // other test in the suite (the `/^gh pr create/` matcher is permissive).
  it('opens the PR as DRAFT (AISDLC-218 regression guard)', async () => {
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/1\n'));
    await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    const ghPrCreateCall = fake.calls.find(
      (c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create',
    );
    expect(ghPrCreateCall, '`gh pr create` must be invoked').toBeDefined();
    expect(
      ghPrCreateCall!.args.includes('--draft'),
      `gh pr create args must include --draft (AISDLC-218); got: ${ghPrCreateCall!.args.join(' ')}`,
    ).toBe(true);
  });

  // AISDLC-606 — `gh pr create --base` must default to 'main' (no
  // regression) when spec.branching.targetBranch is unset.
  it('opens the PR with --base main when targetBranch is unset (AISDLC-606 no-regression)', async () => {
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/1\n'));
    await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    const ghPrCreateCall = fake.calls.find(
      (c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create',
    );
    const baseIdx = ghPrCreateCall!.args.indexOf('--base');
    expect(ghPrCreateCall!.args[baseIdx + 1]).toBe('main');
  });

  // AISDLC-606 — `gh pr create --base` must honor spec.branching.targetBranch
  // when configured (develop-based repo).
  it('opens the PR with --base develop when spec.branching.targetBranch=develop', async () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      ['spec:', '  branching:', '    targetBranch: develop'].join('\n') + '\n',
    );
    const fake = new FakeRunner()
      .on(/^git fetch origin develop/, ok())
      .on(/^git merge-base --is-ancestor origin\/develop HEAD/, ok())
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/1\n'));
    await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    const ghPrCreateCall = fake.calls.find(
      (c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create',
    );
    const baseIdx = ghPrCreateCall!.args.indexOf('--base');
    expect(ghPrCreateCall!.args[baseIdx + 1]).toBe('develop');
  });

  it('returns pushed=false with reason on non-fast-forward', async () => {
    const fake = new FakeRunner().on(
      /^git push -u origin/,
      fail('! [rejected] b -> b (non-fast-forward)\nerror: failed to push some refs', 1),
    );
    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    expect(r.pushed).toBe(false);
    expect(r.reason).toMatch(/non-fast-forward/);
  });

  describe('lease push of its own pre-rebase copy (AISDLC-1016)', () => {
    const PRE = 'a'.repeat(40);
    const REMOTE = 'b'.repeat(40);
    const rejected = fail('! [rejected] b -> b (non-fast-forward)', 1);
    const policyOf = (
      forcePushMode: 'never' | 'leaseOnOwnBranch' | 'lease',
      notOwn: string | null = null,
    ) => ({ forcePushMode, protectedBranches: [], ownWorktree: () => notOwn });
    const run = async (
      ancestor: boolean,
      mode: 'never' | 'leaseOnOwnBranch' | 'lease',
      notOwn: string | null = null,
    ) => {
      const fake = new FakeRunner()
        .on(/^git rev-parse HEAD$/, ok(PRE + '\n'))
        .on(/^git push -u origin b$/, rejected)
        .on(/^git rev-parse refs\/remotes/, ok(REMOTE + '\n'))
        .on(/^git merge-base --is-ancestor/, ancestor ? ok() : fail('', 1))
        .on(/^gh pr create/, ok('https://example/1'));
      const r = await pushAndPr({
        taskId: 'AISDLC-1',
        workDir: tmp,
        worktreePath: tmp,
        branch: 'b',
        task,
        developerReturn: dev,
        verdict: approved,
        runner: fake.toRunner(),
        resumeLeasePolicy: policyOf(mode, notOwn),
      });
      return { r, fake };
    };
    const leasePushes = (fake: FakeRunner) =>
      fake.calls.filter(
        (c) => c.command === 'git' && c.args.some((a) => a.startsWith('--force-with-lease')),
      );

    it('leases against the observed remote head when it is the pre-rebase copy', async () => {
      const { r, fake } = await run(true, 'lease');
      expect(r.pushed).toBe(true);
      expect(leasePushes(fake)).toHaveLength(1);
      expect(leasePushes(fake)[0]!.args).toContain(`--force-with-lease=refs/heads/b:${REMOTE}`);
    });

    it('honours leaseOnOwnBranch inside the task worktree', async () => {
      expect((await run(true, 'leaseOnOwnBranch')).r.pushed).toBe(true);
    });

    it('aborts when the remote holds a foreign commit', async () => {
      const { r, fake } = await run(false, 'lease');
      expect(r.pushed).toBe(false);
      expect(r.reason).toMatch(/non-fast-forward/);
      expect(leasePushes(fake)).toHaveLength(0);
    });

    it('aborts under leaseOnOwnBranch outside the task worktree', async () => {
      const { r, fake } = await run(true, 'leaseOnOwnBranch', 'not registered');
      expect(r.pushed).toBe(false);
      expect(leasePushes(fake)).toHaveLength(0);
    });

    it('aborts when the policy is never', async () => {
      const { r, fake } = await run(true, 'never');
      expect(r.pushed).toBe(false);
      expect(leasePushes(fake)).toHaveLength(0);
    });
  });

  describe('first push leases against an existing remote head (AISDLC-1138)', () => {
    const REMOTE = 'c'.repeat(40);
    const policyOf = (
      forcePushMode: 'never' | 'leaseOnOwnBranch' | 'lease',
      protectedBranches: string[] = [],
      notOwn: string | null = null,
    ) => ({ forcePushMode, protectedBranches, ownWorktree: () => notOwn });
    const run = async (
      branch: string,
      remoteHead: boolean,
      policy: ReturnType<typeof policyOf>,
      pushResult = ok(),
    ) => {
      const fake = new FakeRunner()
        .on(/^git ls-remote/, ok(remoteHead ? `${REMOTE}\trefs/heads/${branch}\n` : ''))
        .on(/^git push/, pushResult)
        .on(/^gh pr create/, ok('https://example/1'));
      const r = await pushAndPr({
        taskId: 'AISDLC-1',
        workDir: tmp,
        worktreePath: tmp,
        branch,
        task,
        developerReturn: dev,
        verdict: approved,
        runner: fake.toRunner(),
        resumeLeasePolicy: policy,
      });
      const push = fake.calls.find((c) => c.command === 'git' && c.args[0] === 'push')!;
      return { r, push };
    };

    it.each(['lease', 'leaseOnOwnBranch'] as const)(
      'leases when the head exists (%s)',
      async (m) => {
        const { r, push } = await run('b', true, policyOf(m));
        expect(r.pushed).toBe(true);
        expect(push.args).toContain(`--force-with-lease=refs/heads/b:${REMOTE}`);
      },
    );

    it('pushes plainly when the branch is absent on origin', async () => {
      const { push } = await run('b', false, policyOf('lease'));
      expect(push.args).toEqual(['push', '-u', 'origin', 'b']);
    });

    it('mode never keeps the plain push and names the policy on refusal', async () => {
      const { r, push } = await run(
        'b',
        true,
        policyOf('never'),
        fail('! [rejected] b -> b (non-fast-forward)', 1),
      );
      expect(push.args).toEqual(['push', '-u', 'origin', 'b']);
      expect(r.pushed).toBe(false);
      expect(r.reason).toMatch(/allowForcePush: never/);
      expect(r.reason).toMatch(/forbids a lease push/);
    });

    it('leaseOnOwnBranch outside the own worktree stays plain', async () => {
      const { push } = await run('b', true, policyOf('leaseOnOwnBranch', [], 'not registered'));
      expect(push.args).toEqual(['push', '-u', 'origin', 'b']);
    });

    it.each(['main', 'master', 'release'])('never leases protected branch %s', async (b) => {
      const { push } = await run(b, true, policyOf('lease', ['release']));
      expect(push.args.some((a) => a.startsWith('--force-with-lease'))).toBe(false);
    });
  });

  it('returns prUrl=null when gh pr create fails', async () => {
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, fail('gh: bad token', 1));
    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    expect(r.pushed).toBe(true);
    expect(r.prUrl).toBeNull();
    expect(r.reason).toMatch(/gh pr create failed/);
  });

  it('does NOT call git push --force under any circumstance', async () => {
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://example/1'));
    await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    const dangerous = fake.calls.find(
      (c) => c.command === 'git' && c.args.some((a) => a === '--force' || a === '-f'),
    );
    expect(dangerous).toBeUndefined();
  });

  // AISDLC-493 — PrOpened event must be emitted when gh pr create succeeds.
  // This test proves the emit call is wired (major finding #1 from iteration-1 review).
  it('emits PrOpened event to the events stream when gh pr create succeeds (AISDLC-493)', async () => {
    const frozenDate = new Date('2026-05-31T10:00:00.000Z');
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/42\n'));
    await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
      artifactsDir: tmp,
      now: () => frozenDate,
      isEnabled: () => true,
    });
    const evPath = eventsFilePath(tmp, frozenDate);
    expect(existsSync(evPath), `events file must exist at ${evPath}`).toBe(true);
    const raw = readFileSync(evPath, 'utf8').trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.type).toBe('PrOpened');
    expect(parsed.taskId).toBe('AISDLC-1');
    expect(parsed.prUrl).toBe('https://github.com/x/y/pull/42');
    expect(typeof parsed.prOpenedAt).toBe('string');
  });

  it('does NOT emit PrOpened when gh pr create fails (AISDLC-493)', async () => {
    const frozenDate = new Date('2026-05-31T10:00:00.000Z');
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, fail('auth error', 1));
    await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
      artifactsDir: tmp,
      now: () => frozenDate,
      isEnabled: () => true,
    });
    const evPath = eventsFilePath(tmp, frozenDate);
    // No event written when PR creation fails
    expect(existsSync(evPath)).toBe(false);
  });
});

describe('Step 11 lease-push preflight (AISDLC-798)', () => {
  const refused = (blocking: boolean) => ({
    status: 'refused' as const,
    blocking,
    failing: [{ condition: 'heartbeat', found: 'f', expected: 'e', fix: 'x' }],
    message: 'lease-push preflight: heartbeat unmet',
  });
  const base = () => ({
    taskId: 'AISDLC-1',
    workDir: tmp,
    worktreePath: tmp,
    branch: 'b',
    task,
    developerReturn: dev,
    verdict: approved,
  });

  it('stops a dispatch-managed session before the rebase, naming the failing conditions', async () => {
    const fake = new FakeRunner();
    const r = await pushAndPr({
      ...base(),
      runner: fake.toRunner(),
      leasePreflight: () => refused(true),
    });
    expect(r).toMatchObject({
      pushed: false,
      prUrl: null,
      reason: 'lease-push preflight: heartbeat unmet',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('only warns for a hand-run session and carries on', async () => {
    const warn = vi.fn();
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/1\n'));
    const r = await pushAndPr({
      ...base(),
      runner: fake.toRunner(),
      logger: { info: vi.fn(), warn, error: vi.fn(), progress: vi.fn() } as never,
      leasePreflight: () => refused(false),
    });
    expect(r.pushed).toBe(true);
    expect(warn).toHaveBeenCalledWith('lease-push preflight: heartbeat unmet');
  });

  it('runs the real preflight by default and skips it when the plugin is not on disk', async () => {
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/1\n'));
    const r = await pushAndPr({ ...base(), runner: fake.toRunner() });
    expect(r.pushed).toBe(true);
  });
});

describe('Step 11 clobber-signature guard (AISDLC-1019)', () => {
  const o = { worktreePath: '/wt/aisdlc-1', branch: 'ai-sdlc/aisdlc-1' };

  it('refuses when HEAD equals origin/main and the task branch has commits ahead', async () => {
    const fake = new FakeRunner()
      .on(/rev-parse --show-toplevel/, ok('/wt/aisdlc-1\n'))
      .on(/rev-parse HEAD/, ok('aaa\n'))
      .on(/rev-parse origin\/main/, ok('aaa\n'))
      .on(/rev-list --count/, ok('3\n'));
    const r = await checkClobberSignature(o, 'main', fake.toRunner());
    expect(r).toMatch(/HEAD equals origin\/main.*3 commit/);
  });

  it('allows a new branch (nothing ahead on origin) and a HEAD that differs from main', async () => {
    const same = new FakeRunner()
      .on(/rev-parse HEAD/, ok('aaa\n'))
      .on(/rev-parse origin\/main/, ok('aaa\n'))
      .on(/rev-list --count/, fail('unknown revision'));
    expect(await checkClobberSignature(o, 'main', same.toRunner())).toBeNull();
    const differ = new FakeRunner()
      .on(/rev-parse HEAD/, ok('bbb\n'))
      .on(/rev-parse origin\/main/, ok('aaa\n'));
    expect(await checkClobberSignature(o, 'main', differ.toRunner())).toBeNull();
  });

  it('refuses when the push cwd toplevel is not the task worktree', async () => {
    const fake = new FakeRunner().on(/rev-parse --show-toplevel/, ok('/parent\n'));
    const r = await checkClobberSignature(o, 'main', fake.toRunner());
    expect(r).toMatch(/not the task worktree \/wt\/aisdlc-1/);
  });

  it('stops pushAndPr before any push', async () => {
    const fake = new FakeRunner()
      .on(/rev-parse HEAD/, ok('aaa\n'))
      .on(/rev-parse origin\/main/, ok('aaa\n'))
      .on(/rev-list --count/, ok('2\n'));
    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    expect(r.pushed).toBe(false);
    expect(r.reason).toMatch(/push refused/);
    expect(fake.calls.some((c) => c.args[0] === 'push')).toBe(false);
  });
});

describe('workspace rebuild after the late rebase (AISDLC-1111)', () => {
  const seed = (withDist: boolean) => {
    mkdirSync(join(tmp, 'node_modules'), { recursive: true });
    if (withDist) {
      for (const p of ['orchestrator/dist/runtime/attestations.js', 'reference/dist/index.js']) {
        mkdirSync(join(tmp, p, '..'), { recursive: true });
        writeFileSync(join(tmp, p), '');
      }
    }
  };
  const run = async (rebaseMoves: boolean) => {
    let head = 'aaa';
    const fake = new FakeRunner()
      .on(/^git rev-parse HEAD$/, () => ok(head + '\n'))
      .on(/^git merge-base --is-ancestor/, rebaseMoves ? fail('', 1) : ok())
      .on(/^git rebase /, () => {
        head = 'bbb';
        return ok();
      })
      .on(/^gh pr create/, ok('https://example/1'));
    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
      leasePreflight: () => ({ status: 'ok' }) as never,
    });
    return { r, fake };
  };
  const order = (f: FakeRunner) =>
    f.calls
      .map((c) => `${c.command} ${c.args[0]}`)
      .filter((c) => /pnpm build|git rebase|git push/.test(c));

  it('rebuilds after the rebase moved HEAD, before the push', async () => {
    seed(true);
    const { r, fake } = await run(true);
    expect(r.pushed).toBe(true);
    expect(order(fake)).toEqual(['git rebase', 'pnpm build', 'git push']);
  });

  it('does not rebuild when the rebase left HEAD alone', async () => {
    seed(true);
    const { fake } = await run(false);
    expect(order(fake)).not.toContain('pnpm build');
  });

  it('rebuilds a missing dist entry point even though HEAD did not move', async () => {
    seed(false);
    const { fake } = await run(false);
    expect(order(fake)).toEqual(['pnpm build', 'git push']);
  });

  it('refuses to push when the rebuild fails', async () => {
    seed(false);
    const fake = new FakeRunner().on(/^pnpm build/, fail('TS2305 no exported member'));
    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
      leasePreflight: () => ({ status: 'ok' }) as never,
    });
    expect(r.pushed).toBe(false);
    expect(r.reason).toContain('TS2305');
    expect(fake.calls.some((c) => c.args[0] === 'push')).toBe(false);
  });
});
