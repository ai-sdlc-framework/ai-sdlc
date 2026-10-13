/**
 * The `staged` reviewer set: selected exactly as the merged set is (env var, or the
 * base-ref config, never the working tree), limited to `backlog` work, and falling back
 * to `three` with a logged reason otherwise.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STAGED_REVIEWER_SET,
  explicitReviewerSetMode,
  parseReviewerSetModeYaml,
  resolveReviewerSet,
  resolveReviewerSetMode,
  selectReviewerSet,
} from './reviewer-set.js';

const configWith = (mode: string) => () => `reviewerSet: ${mode}\n`;

describe('parseReviewerSetModeYaml', () => {
  it.each(['staged', "'staged'", '"staged"'])('reads %s', (v) => {
    expect(parseReviewerSetModeYaml(`reviewerSet: ${v}\n`)).toBe('staged');
  });
  it('still reads the other modes and rejects unknown ones', () => {
    expect(parseReviewerSetModeYaml('reviewerSet: code-test-merged')).toBe('code-test-merged');
    expect(parseReviewerSetModeYaml('reviewerSet: three')).toBe('three');
    expect(parseReviewerSetModeYaml('reviewerSet: stagedx')).toBeNull();
  });
});

describe('resolveReviewerSetMode: staged', () => {
  it('is selected by the env var for backlog work', () => {
    const logs: string[] = [];
    expect(
      resolveReviewerSetMode({
        env: { AI_SDLC_REVIEWER_SET: 'staged' },
        sourceKind: 'backlog',
        readBaseConfig: () => null,
        log: (m) => logs.push(m),
      }),
    ).toBe('staged');
    expect(logs).toEqual([]);
  });

  it('is selected by the base-ref config for backlog work', () => {
    expect(
      resolveReviewerSetMode({
        env: {},
        sourceKind: 'backlog',
        readBaseConfig: configWith('staged'),
      }),
    ).toBe('staged');
  });

  it('falls back to three for gh-issue work, and logs why', () => {
    const logs: string[] = [];
    const mode = resolveReviewerSetMode({
      env: {},
      sourceKind: 'gh-issue',
      readBaseConfig: configWith('staged'),
      log: (m) => logs.push(m),
    });
    expect(mode).toBe('three');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("'staged'");
    expect(logs[0]).toContain('gh-issue');
    expect(logs[0]).toContain("falling back to 'three'");
  });

  it('falls back to three, and says so, when the source kind is not given', () => {
    const logs: string[] = [];
    expect(
      resolveReviewerSetMode({
        env: { AI_SDLC_REVIEWER_SET: 'staged' },
        readBaseConfig: () => null,
        log: (m) => logs.push(m),
      }),
    ).toBe('three');
    expect(logs[0]).toContain('unspecified');
  });

  it('writes the reason to stderr by default', () => {
    const chunks: string[] = [];
    const saved = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      resolveReviewerSetMode({
        env: {},
        sourceKind: 'gh-issue',
        readBaseConfig: configWith('staged'),
      });
    } finally {
      process.stderr.write = saved;
    }
    expect(chunks.join('')).toContain("falling back to 'three'");
  });

  it('never changes the other modes, whatever the source kind', () => {
    for (const sourceKind of ['backlog', 'gh-issue', undefined]) {
      expect(
        resolveReviewerSetMode({
          env: {},
          sourceKind,
          readBaseConfig: configWith('code-test-merged'),
        }),
      ).toBe('code-test-merged');
      expect(resolveReviewerSetMode({ env: {}, sourceKind, readBaseConfig: () => null })).toBe(
        'three',
      );
    }
  });

  it('lets the env var override the config, in both directions', () => {
    expect(
      resolveReviewerSetMode({
        env: { AI_SDLC_REVIEWER_SET: 'three' },
        sourceKind: 'backlog',
        readBaseConfig: configWith('staged'),
      }),
    ).toBe('three');
    expect(
      resolveReviewerSetMode({
        env: { AI_SDLC_REVIEWER_SET: 'staged' },
        sourceKind: 'backlog',
        readBaseConfig: configWith('three'),
      }),
    ).toBe('staged');
  });
});

describe('resolveReviewerSetMode: the config is read from the base ref, never the working tree', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'reviewer-set-staged-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const writeWorkingCopy = (mode: string) => {
    mkdirSync(join(repo, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(repo, '.ai-sdlc', 'review-config.yaml'), `reviewerSet: ${mode}\n`);
  };

  it('ignores a staged setting that exists only in the working tree', () => {
    writeWorkingCopy('staged');
    expect(resolveReviewerSetMode({ env: {}, sourceKind: 'backlog', workDir: repo })).toBe('three');
  });

  it('honours staged once the base ref carries it', () => {
    writeWorkingCopy('staged');
    git('add', '.ai-sdlc/review-config.yaml');
    git('commit', '-q', '-m', 'adopt staged');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    // Remove the working copy: only the committed base-ref copy remains.
    rmSync(join(repo, '.ai-sdlc'), { recursive: true });
    expect(resolveReviewerSetMode({ env: {}, sourceKind: 'backlog', workDir: repo })).toBe(
      'staged',
    );
  });

  it('is not widened by a working tree that disagrees with the base ref', () => {
    writeWorkingCopy('staged');
    git('add', '.ai-sdlc/review-config.yaml');
    git('commit', '-q', '-m', 'adopt staged');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeWorkingCopy('three');
    expect(resolveReviewerSetMode({ env: {}, sourceKind: 'backlog', workDir: repo })).toBe(
      'staged',
    );
  });
});

describe('the staged set and its neighbours', () => {
  it('resolves to the standalone security reviewer that runs beside the pipeline', () => {
    expect(
      resolveReviewerSet({ env: { AI_SDLC_REVIEWER_SET: 'staged' }, sourceKind: 'backlog' }),
    ).toEqual([...STAGED_REVIEWER_SET]);
    expect(STAGED_REVIEWER_SET).toEqual(['security-reviewer']);
  });

  it('is reported as the pinned mode only when eligible', () => {
    expect(
      explicitReviewerSetMode({
        env: {},
        sourceKind: 'backlog',
        readBaseConfig: configWith('staged'),
      }),
    ).toBe('staged');
    expect(
      explicitReviewerSetMode({
        env: {},
        sourceKind: 'gh-issue',
        readBaseConfig: configWith('staged'),
        log: () => undefined,
      }),
    ).toBe('three');
  });

  it('selectReviewerSet returns the staged mode without a judgment, and logs a fallback once', async () => {
    const changed = ['src/a.ts'];
    const staged = await selectReviewerSet({
      env: {},
      sourceKind: 'backlog',
      readBaseConfig: configWith('staged'),
      changedFiles: changed,
      diff: 'diff',
    });
    expect(staged).toMatchObject({ mode: 'staged', reviewers: ['security-reviewer'] });

    const logs: string[] = [];
    const fell = await selectReviewerSet({
      env: {},
      sourceKind: 'gh-issue',
      readBaseConfig: configWith('staged'),
      changedFiles: changed,
      diff: 'diff',
      log: (m) => logs.push(m),
    });
    expect(fell.mode).toBe('three');
    expect(fell.reviewers).toEqual(['code-reviewer', 'test-reviewer', 'security-reviewer']);
    expect(logs).toHaveLength(1);
  });
});
