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

  it('reads pipeline-backlog.yaml when present', async () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `branching:\n  pattern: 'feat/{issueIdLower}/{slug}'\n`,
    );
    const r = await computeBranchName({ taskId: 'AISDLC-100', task: baseTask, workDir: tmp });
    expect(r.branch).toMatch(/^feat\/aisdlc-100\/my-heavy/);
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
    expect(files.length).toBeGreaterThan(0);

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

  it('returns fallback when key absent', () => {
    writeFileSync(join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'), 'branching: {}\n');
    expect(readBranchPattern(tmp, 'fb')).toBe('fb');
  });

  it('handles double-quoted patterns', () => {
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `branching:\n  pattern: "test/{slug}"\n`,
    );
    expect(readBranchPattern(tmp)).toBe('test/{slug}');
  });
});
