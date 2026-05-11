import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FALLBACK_SLUG,
  computeBranchName,
  readBranchPattern,
  slugify,
} from './02-compute-branch.js';
import { parseTaskFile } from './01-validate.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import type { PipelineLogger, TaskSpec } from '../types.js';

function makeRecordingLogger(): PipelineLogger & { warnings: string[] } {
  const warnings: string[] = [];
  const logger = {
    info: () => undefined,
    warn: (m: string) => warnings.push(m),
    error: () => undefined,
    progress: () => undefined,
    warnings,
  } as PipelineLogger & { warnings: string[] };
  return logger;
}

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

const baseTask: TaskSpec = {
  id: 'AISDLC-100',
  title: 'My Heavy Task: extract step functions',
  status: 'To Do',
  acceptanceCriteria: ['a'],
  acceptanceCriteriaChecked: [false],
  description: '',
  rawBody: '',
  filePath: '',
};

describe('Step 2 — computeBranchName', () => {
  it('uses the default pattern when no yaml', async () => {
    const r = await computeBranchName({ taskId: 'AISDLC-100', task: baseTask, workDir: tmp });
    expect(r.branch).toMatch(/^ai-sdlc\/aisdlc-100-/);
    expect(r.slug).toMatch(/^my-heavy-task/);
    expect(r.taskIdLower).toBe('aisdlc-100');
    expect(r.worktreePath).toBe(join(tmp, '.worktrees', 'aisdlc-100'));
  });

  it('reads pipeline.yaml spec.backlog.branching.pattern (canonical, AISDLC-245.5)', async () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      [
        'apiVersion: ai-sdlc.io/v1alpha1',
        'kind: Pipeline',
        'metadata:',
        '  name: test',
        'spec:',
        '  triggers:',
        '    - event: issue.labeled',
        '  providers: {}',
        '  stages: []',
        '  backlog:',
        '    branching:',
        "      pattern: 'feat/{issueIdLower}/{slug}'",
      ].join('\n') + '\n',
    );
    const r = await computeBranchName({ taskId: 'AISDLC-100', task: baseTask, workDir: tmp });
    expect(r.branch).toMatch(/^feat\/aisdlc-100\/my-heavy/);
  });

  it('reads pipeline-backlog.yaml when present (deprecated shim, warns)', async () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `branching:\n  pattern: 'feat/{issueIdLower}/{slug}'\n`,
    );
    const logger = makeRecordingLogger();
    const r = await computeBranchName({
      taskId: 'AISDLC-100',
      task: baseTask,
      workDir: tmp,
      logger,
    });
    expect(r.branch).toMatch(/^feat\/aisdlc-100\/my-heavy/);
    // Deprecation warning must fire when falling back to pipeline-backlog.yaml.
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toMatch(/DEPRECATION/);
    expect(logger.warnings[0]).toMatch(/pipeline-backlog\.yaml/);
  });

  it('prefers pipeline.yaml over pipeline-backlog.yaml (canonical wins)', async () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    // pipeline.yaml has backlog section
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      [
        'apiVersion: ai-sdlc.io/v1alpha1',
        'kind: Pipeline',
        'metadata:',
        '  name: test',
        'spec:',
        '  triggers: []',
        '  providers: {}',
        '  stages: []',
        '  backlog:',
        '    branching:',
        "      pattern: 'canonical/{issueIdLower}'",
      ].join('\n') + '\n',
    );
    // pipeline-backlog.yaml has a different pattern
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `branching:\n  pattern: 'legacy/{issueIdLower}'\n`,
    );
    const logger = makeRecordingLogger();
    const r = await computeBranchName({
      taskId: 'AISDLC-100',
      task: baseTask,
      workDir: tmp,
      logger,
    });
    // canonical pipeline.yaml wins — no deprecation warning
    expect(r.branch).toBe('canonical/aisdlc-100');
    expect(logger.warnings).toHaveLength(0);
  });

  it('respects defaultPattern override', async () => {
    const r = await computeBranchName({
      taskId: 'AISDLC-100',
      task: baseTask,
      workDir: tmp,
      defaultPattern: 'custom/{issueIdLower}',
    });
    expect(r.branch).toBe('custom/aisdlc-100');
  });
});

describe('Step 2 — slugify', () => {
  it('lowercases + kebabs', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });

  it('collapses non-alphanumeric runs', () => {
    expect(slugify('A:::B---C')).toBe('a-b-c');
  });

  it('caps at 50 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBe(50);
  });

  it('strips leading/trailing dashes', () => {
    expect(slugify('--abc--')).toBe('abc');
  });
});

// AISDLC-180 — guard against the witness-test regression where YAML
// block-scalar titles slipped past slug normalisation as `>-` and produced
// branch names like `ai-sdlc/aisdlc-178.1-` (trailing dash, no slug body).
describe('Step 2 — slugify (AISDLC-180 fixtures)', () => {
  it('handles short single-word titles', () => {
    expect(slugify('Demo')).toBe('demo');
  });

  it('handles long titles with em-dashes (AISDLC-178.1 reproducer)', () => {
    const title =
      'Phase 1: Skeleton — cli-tui binary, Ink scaffold, Overview Mode placeholder panes';
    const slug = slugify(title);
    expect(slug).not.toBe('');
    expect(slug.startsWith('phase-1-skeleton')).toBe(true);
    // Em-dash is non-alphanumeric so it gets collapsed into a `-`.
    expect(slug).not.toContain('—');
    // 50-char cap still applies.
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it('handles titles with assorted special chars + unicode punctuation', () => {
    const title = 'API: don\'t break — "quoted" things & ™symbols / slashes (parens) [brackets]';
    const slug = slugify(title);
    expect(slug).toMatch(/^api-don-t-break/);
    // Every special char run collapses to a single `-`; no doubled dashes.
    expect(slug).not.toMatch(/--/);
  });

  it('returns empty string for a title with no alphanumeric chars (caller fails loud)', () => {
    expect(slugify('>-')).toBe('');
    expect(slugify('— — —')).toBe('');
    expect(slugify('!!!')).toBe('');
  });
});

// AISDLC-202.2 — degraded-input fallback. AISDLC-180 originally threw here so
// the upstream parser bug (block-scalar markers leaking through) would fail
// loud; AISDLC-202.2 replaces the throw with a stable fallback slug + warning
// so Codex/unattended runs that hit a degraded title still produce a valid
// branch name without operator hand-patching.
describe('Step 2 — computeBranchName degraded-slug fallback (AISDLC-202.2)', () => {
  const evilTask = (title: string): TaskSpec => ({
    id: 'AISDLC-EMPTY',
    title,
    status: 'To Do',
    acceptanceCriteria: ['a'],
    acceptanceCriteriaChecked: [false],
    description: '',
    rawBody: '',
    filePath: '',
  });

  it('substitutes the fallback slug when the title is a block-scalar marker (>-)', async () => {
    const logger = makeRecordingLogger();
    const r = await computeBranchName({
      taskId: 'AISDLC-EMPTY',
      task: evilTask('>-'),
      workDir: tmp,
      logger,
    });
    expect(r.slug).toBe(FALLBACK_SLUG);
    expect(r.branch).toBe(`ai-sdlc/aisdlc-empty-${FALLBACK_SLUG}`);
    // Warning surfaces the upstream parser bug — same diagnostic as the
    // legacy throw so operators can grep their logs for degraded titles.
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toMatch(/empty string/);
    expect(logger.warnings[0]).toMatch(/fallback slug "task"/);
  });

  it('substitutes the fallback slug when the title is pure punctuation', async () => {
    const logger = makeRecordingLogger();
    const r = await computeBranchName({
      taskId: 'AISDLC-EMPTY',
      task: evilTask('!!!'),
      workDir: tmp,
      logger,
    });
    expect(r.slug).toBe(FALLBACK_SLUG);
    expect(r.branch).toBe(`ai-sdlc/aisdlc-empty-${FALLBACK_SLUG}`);
    expect(logger.warnings).toHaveLength(1);
  });

  it('substitutes the fallback slug for the AISDLC-201 reproducer (em-dashes only)', async () => {
    const logger = makeRecordingLogger();
    const r = await computeBranchName({
      taskId: 'AISDLC-201',
      task: evilTask('— — —'),
      workDir: tmp,
      logger,
    });
    // Branch is valid (no trailing dash) and worktree path is taskId-derived.
    expect(r.branch).toMatch(/^ai-sdlc\/aisdlc-201-task$/);
    expect(r.worktreePath).toBe(join(tmp, '.worktrees', 'aisdlc-201'));
    // Branch must be a valid git ref shape — no doubled dashes, no trailing
    // dash, no leading slash, no empty segments.
    expect(r.branch).not.toMatch(/--/);
    expect(r.branch).not.toMatch(/-$/);
    expect(r.branch.split('/').every((seg) => seg.length > 0)).toBe(true);
  });

  it('falls back to console.warn when no logger is injected', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const r = await computeBranchName({
        taskId: 'AISDLC-EMPTY',
        task: evilTask('>-'),
        workDir: tmp,
      });
      expect(r.slug).toBe(FALLBACK_SLUG);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatch(/fallback slug "task"/);
    } finally {
      spy.mockRestore();
    }
  });

  it('does NOT warn or fall back when slug is non-empty', async () => {
    const logger = makeRecordingLogger();
    const r = await computeBranchName({
      taskId: 'AISDLC-100',
      task: evilTask('Real Title'),
      workDir: tmp,
      logger,
    });
    expect(r.slug).toBe('real-title');
    expect(r.branch).toBe('ai-sdlc/aisdlc-100-real-title');
    expect(logger.warnings).toHaveLength(0);
  });

  it('does NOT warn or fall back when the branch pattern omits {slug}', async () => {
    const logger = makeRecordingLogger();
    // Slug-less pattern is fine even when the title produces empty slug —
    // the empty slug never reaches the rendered branch, so the fallback
    // path is skipped entirely. No warning is emitted.
    const r = await computeBranchName({
      taskId: 'AISDLC-EMPTY',
      task: evilTask('!!!'),
      workDir: tmp,
      defaultPattern: 'manual/{issueIdLower}',
      logger,
    });
    expect(r.branch).toBe('manual/aisdlc-empty');
    expect(r.slug).toBe('');
    expect(logger.warnings).toHaveLength(0);
  });
});

// Regression: parse every backlog task on disk and confirm slug computation
// produces a non-empty result. Catches the AISDLC-178.1-shape regression and
// any future title shape that survives slugify() to an empty string. Runs
// against the live repo by walking up from the test file's URL.
describe('Step 2 — backlog regression (AISDLC-180)', () => {
  it('every backlog/tasks/aisdlc-*.md file produces a non-empty slug', async () => {
    const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
    const tasksDir = join(repoRoot, 'backlog', 'tasks');
    const files = readdirSync(tasksDir).filter((n) => n.endsWith('.md'));
    // No `> 0` assertion: when the dispatchable backlog is fully drained
    // (all tasks moved to backlog/completed/), files.length is legitimately 0.
    // The regression this test guards (AISDLC-180 block-scalar title leaking
    // through slugify as `>-`) only matters when there ARE open tasks; an
    // empty backlog is a degenerate-but-valid pass.

    const failures: { file: string; title: string; slug: string }[] = [];
    for (const name of files) {
      const filePath = join(tasksDir, name);
      let task: TaskSpec;
      try {
        task = parseTaskFile(filePath);
      } catch {
        // Files that don't parse aren't slug-able — surface them as failures.
        failures.push({ file: name, title: '<parse-error>', slug: '' });
        continue;
      }
      const slug = slugify(task.title);
      if (slug === '') {
        failures.push({ file: name, title: task.title, slug });
      }
    }

    if (failures.length > 0) {
      const detail = failures
        .map((f) => `  ${f.file} → title=${JSON.stringify(f.title)} slug=${JSON.stringify(f.slug)}`)
        .join('\n');
      throw new Error(`${failures.length} backlog task(s) produced an empty slug:\n${detail}`);
    }
  });
});

describe('Step 2 — readBranchPattern', () => {
  it('returns fallback for missing yaml', () => {
    expect(readBranchPattern('/no/such', 'fb')).toBe('fb');
  });

  it('returns fallback when key absent in both files', () => {
    writeFileSync(join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'), 'branching: {}\n');
    expect(readBranchPattern(tmp, 'fb')).toBe('fb');
  });

  it('reads from pipeline-backlog.yaml when pipeline.yaml has no backlog section (deprecated)', () => {
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `branching:\n  pattern: "test/{slug}"\n`,
    );
    const logger = makeRecordingLogger();
    expect(readBranchPattern(tmp, 'fb', logger)).toBe('test/{slug}');
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toMatch(/DEPRECATION/);
  });

  it('reads from pipeline.yaml backlog section (canonical, no warning)', () => {
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      ['spec:', '  backlog:', '    branching:', "      pattern: 'canonical/{issueIdLower}'"].join(
        '\n',
      ) + '\n',
    );
    const logger = makeRecordingLogger();
    expect(readBranchPattern(tmp, 'fb', logger)).toBe('canonical/{issueIdLower}');
    expect(logger.warnings).toHaveLength(0);
  });

  it('handles double-quoted patterns in legacy pipeline-backlog.yaml', () => {
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `branching:\n  pattern: "test/{slug}"\n`,
    );
    const logger = makeRecordingLogger();
    expect(readBranchPattern(tmp, undefined, logger)).toBe('test/{slug}');
  });

  // AISDLC-245.5 round-2 code-reviewer MINOR regression: when spec.backlog
  // exists but lacks branching, the lookup MUST NOT fall through to a sibling
  // spec.branching.pattern (which is a different config — backlog branching is
  // for /ai-sdlc execute, while spec.branching could be a future workflow setting).
  it('does NOT cross spec.backlog into a sibling top-level branching (section-scoped)', () => {
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      [
        'spec:',
        '  backlog:',
        '    pullRequest:',
        "      titleTemplate: 'feat: {issueTitle}'",
        '  branching:',
        "    pattern: 'WRONG/{issueIdLower}'",
      ].join('\n') + '\n',
    );
    const logger = makeRecordingLogger();
    // backlog has no branching.pattern → MUST return fallback, NOT 'WRONG/...'
    // from the sibling spec.branching block.
    expect(readBranchPattern(tmp, 'fallback/{slug}', logger)).toBe('fallback/{slug}');
    expect(logger.warnings).toHaveLength(0);
  });
});

// AISDLC-245.5 — migration equivalence: an adopter who edits pipeline-backlog.yaml
// today must get the IDENTICAL branch pattern after migrating that same value
// to pipeline.yaml's spec.backlog.branching.pattern. This is the contract the
// migration runbook (docs/operations/pipeline-backlog-migration.md) promises
// — if it ever drifted we'd silently break adopter branches on next run.
describe('Step 2 — migration equivalence (AISDLC-245.5)', () => {
  const PATTERNS = [
    'ai-sdlc/{issueIdLower}-{slug}',
    'feat/{issueIdLower}/{slug}',
    'custom/{issueIdLower}',
    // Test-reviewer round-2 suggestion: include a pattern with characters that
    // are YAML-sensitive in unquoted scalar context (the YAML reader uses
    // single-quoted form, but some adopters write the legacy shape unquoted).
    'release/{issueIdLower}.{slug}',
  ];

  for (const pattern of PATTERNS) {
    it(`legacy pipeline-backlog.yaml and canonical pipeline.yaml produce same pattern: ${pattern}`, () => {
      // Legacy shape: pipeline-backlog.yaml
      const legacyDir = makeTmpProject();
      try {
        mkdirSync(join(legacyDir, '.ai-sdlc'), { recursive: true });
        writeFileSync(
          join(legacyDir, '.ai-sdlc', 'pipeline-backlog.yaml'),
          `branching:\n  pattern: '${pattern}'\n`,
        );
        const legacyLogger = makeRecordingLogger();
        const legacyResult = readBranchPattern(legacyDir, 'default', legacyLogger);

        // Canonical shape: pipeline.yaml spec.backlog.branching.pattern
        const canonicalDir = makeTmpProject();
        try {
          mkdirSync(join(canonicalDir, '.ai-sdlc'), { recursive: true });
          writeFileSync(
            join(canonicalDir, '.ai-sdlc', 'pipeline.yaml'),
            [
              'apiVersion: ai-sdlc.io/v1alpha1',
              'kind: Pipeline',
              'metadata:',
              '  name: migration-test',
              'spec:',
              '  triggers: []',
              '  providers: {}',
              '  stages: []',
              '  backlog:',
              '    branching:',
              `      pattern: '${pattern}'`,
            ].join('\n') + '\n',
          );
          const canonicalLogger = makeRecordingLogger();
          const canonicalResult = readBranchPattern(canonicalDir, 'default', canonicalLogger);

          // Equivalence: same pattern value
          expect(canonicalResult).toBe(legacyResult);
          expect(canonicalResult).toBe(pattern);
          // Canonical shape MUST NOT emit deprecation warning
          expect(canonicalLogger.warnings).toHaveLength(0);
          // Legacy shape MUST emit deprecation warning
          expect(legacyLogger.warnings).toHaveLength(1);
          expect(legacyLogger.warnings[0]).toMatch(/DEPRECATION/);
        } finally {
          cleanupTmpProject(canonicalDir);
        }
      } finally {
        cleanupTmpProject(legacyDir);
      }
    });
  }

  it('end-to-end: same task + same pattern produces same branch via legacy or canonical', async () => {
    const pattern = 'feat/{issueIdLower}/{slug}';

    const legacyDir = makeTmpProject();
    const canonicalDir = makeTmpProject();
    try {
      mkdirSync(join(legacyDir, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(legacyDir, '.ai-sdlc', 'pipeline-backlog.yaml'),
        `branching:\n  pattern: '${pattern}'\n`,
      );
      mkdirSync(join(canonicalDir, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(canonicalDir, '.ai-sdlc', 'pipeline.yaml'),
        ['spec:', '  backlog:', '    branching:', `      pattern: '${pattern}'`].join('\n') + '\n',
      );

      const legacy = await computeBranchName({
        taskId: 'AISDLC-100',
        task: baseTask,
        workDir: legacyDir,
        logger: makeRecordingLogger(),
      });
      const canonical = await computeBranchName({
        taskId: 'AISDLC-100',
        task: baseTask,
        workDir: canonicalDir,
        logger: makeRecordingLogger(),
      });

      expect(canonical.branch).toBe(legacy.branch);
      expect(canonical.slug).toBe(legacy.slug);
    } finally {
      cleanupTmpProject(legacyDir);
      cleanupTmpProject(canonicalDir);
    }
  });
});
