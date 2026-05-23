import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeBody, composeTitle, pushAndPr, readTitleTemplate } from './11-push-and-pr.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import type { AggregatedVerdict, DeveloperReturn, TaskSpec } from '../types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
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
});
