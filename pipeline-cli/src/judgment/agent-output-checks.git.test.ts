import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  resolveJudgmentConfig,
  type EvaluateJudgmentContext,
  type JudgmentEvaluationRecord,
  type JudgmentAnswer,
} from '@ai-sdlc/reference';
import {
  batchGroundingItems,
  composeJudgmentNotes,
  estimateGroundingItemTokens,
  MAX_GROUNDING_FILE_BYTES,
  MAX_GROUNDING_FINDINGS,
  MAX_GROUNDING_REQUESTS,
  readCommittedFile,
  runFindingGrounding,
} from './agent-output-checks.js';
import { defaultRunner } from '../runtime/exec.js';
import { createJudgmentEventsSink } from './events-sink.js';
import type { OrchestratorEvent } from '../orchestrator/events.js';
import type { ReviewerVerdict } from '../types.js';

let dir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

function git(...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, stdio: 'pipe' },
  );
}
function commit(): void {
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
}
const put = (name: string, content: string | Buffer): void => {
  const full = join(dir, name);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
};
const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n') + '\n';
const read = (file: string) => readCommittedFile(defaultRunner, dir, file);

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), 'grounding-git-'));
  git('init', '-q', '-b', 'main');
  put('README.md', 'x\n');
  commit();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('readCommittedFile (git objects at the reviewed commit)', () => {
  it('reads a tracked file', async () => {
    put('src/a.ts', lines(5));
    commit();
    expect(await read('src/a.ts')).toEqual({ kind: 'text', text: lines(5) });
    expect(await read('./src/a.ts')).toEqual({ kind: 'text', text: lines(5) });
  });

  it('reads the committed version, not an uncommitted edit', async () => {
    put('src/a.ts', 'committed\n');
    commit();
    put('src/a.ts', 'dirty\n');
    expect(await read('src/a.ts')).toEqual({ kind: 'text', text: 'committed\n' });
  });

  it('treats a missing file as missing', async () => {
    expect(await read('src/none.ts')).toEqual({ kind: 'missing' });
  });

  it('does not read an untracked file', async () => {
    put('src/untracked.ts', 'secret\n');
    expect(await read('src/untracked.ts')).toEqual({ kind: 'missing' });
  });

  it('does not read a gitignored file', async () => {
    put('.gitignore', '.env\n');
    commit();
    put('.env', 'TOKEN=abc\n');
    expect(await read('.env')).toEqual({ kind: 'missing' });
  });

  it('rejects a symlink pointing outside the repository', async () => {
    const outside = join(tmpdir(), `outside-${process.pid}.txt`);
    writeFileSync(outside, 'private\n');
    try {
      symlinkSync(outside, join(dir, 'link.txt'));
      commit();
      expect(await read('link.txt')).toEqual({ kind: 'missing' });
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('rejects a symlink inside the tree and a path through a symlinked directory', async () => {
    put('real/a.ts', 'x\n');
    symlinkSync('real/a.ts', join(dir, 'alias.ts'));
    symlinkSync('real', join(dir, 'aliasdir'));
    commit();
    expect(await read('alias.ts')).toEqual({ kind: 'missing' });
    expect(await read('aliasdir/a.ts')).toEqual({ kind: 'missing' });
    expect((await read('real/a.ts')).kind).toBe('text');
  });

  it('rejects directories, absolute and escaping paths', async () => {
    put('src/a.ts', 'x\n');
    commit();
    expect(await read('src')).toEqual({ kind: 'missing' });
    expect(await read('src/')).toEqual({ kind: 'missing' });
    expect(await read('/etc/passwd')).toEqual({ kind: 'missing' });
    expect(await read(join(dir, 'src/a.ts'))).toEqual({ kind: 'missing' });
    expect(await read('../etc/passwd')).toEqual({ kind: 'missing' });
    expect(await read('src/../../x')).toEqual({ kind: 'missing' });
    expect(await read('..')).toEqual({ kind: 'missing' });
    expect(await read('')).toEqual({ kind: 'missing' });
    expect(await read('a\0b')).toEqual({ kind: 'missing' });
    expect(await read('C:\\Windows\\win.ini')).toEqual({ kind: 'missing' });
  });

  it('does not falsely reject a legitimate name starting with two dots', async () => {
    put('..foo.ts', 'dots\n');
    put('..config/x.ts', 'cfg\n');
    commit();
    expect(await read('..foo.ts')).toEqual({ kind: 'text', text: 'dots\n' });
    expect(await read('..config/x.ts')).toEqual({ kind: 'text', text: 'cfg\n' });
  });

  it('treats a gitlink (submodule entry) as missing', async () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    git('update-index', '--add', '--cacheinfo', `160000,${sha},vendor/sub`);
    git('commit', '-q', '-m', 'gitlink');
    expect(await read('vendor/sub')).toEqual({ kind: 'missing' });
  });

  it('marks oversized and binary blobs unreadable', async () => {
    put('big.txt', 'a'.repeat(MAX_GROUNDING_FILE_BYTES + 1));
    put('bin.dat', Buffer.from([1, 2, 0, 3, 4]));
    commit();
    expect(await read('big.txt')).toEqual({ kind: 'unreadable' });
    expect(await read('bin.dat')).toEqual({ kind: 'unreadable' });
  });

  it('normalises CRLF so line numbers and excerpts match', async () => {
    put('win.ts', 'a\r\nb\r\nc\r\n');
    commit();
    expect(await read('win.ts')).toEqual({ kind: 'text', text: 'a\nb\nc\n' });
  });

  it('treats runner failure as missing', async () => {
    const r = await readCommittedFile(
      async () => ({ stdout: '', stderr: 'boom', code: 128 }),
      dir,
      'README.md',
    );
    expect(r).toEqual({ kind: 'missing' });
  });
});

const choice = (c: string): JudgmentAnswer => ({
  type: 'choice',
  choice: c,
  probabilities: { [c]: 0.9 },
  confidence: 0.9,
});
const verdict = (findings: ReviewerVerdict['findings']): ReviewerVerdict => ({
  agentId: 'code-reviewer',
  harness: 'claude-code',
  approved: true,
  findings,
});
const egress = ['agent-output', 'code-diff'];

function setup(
  provider: FakeJudgmentProvider,
  over: { promoted?: boolean; mode?: 'enforce' | 'shadow' } = {},
) {
  const key = `${provider.name}@${provider.modelId}`;
  const promoted = over.promoted ?? true;
  const config = resolveJudgmentConfig({
    spec: {
      provider: provider.name,
      model: provider.modelId,
      egress: { allow: egress },
      judgments: {
        'review.finding-grounding': {
          mode: over.mode ?? 'enforce',
          thresholds: promoted ? { [key]: { x: 1 } } : {},
          promotion: promoted ? { [key]: { path: 'override', evidence: 'hand reviewed' } } : {},
        },
      },
    },
  });
  const events: OrchestratorEvent[] = [];
  const records: JudgmentEvaluationRecord[] = [];
  const ctx: EvaluateJudgmentContext = {
    config,
    getProvider: (n) => (n === provider.name ? provider : undefined),
    sinks: [
      { record: (r) => void records.push(r) },
      createJudgmentEventsSink({ write: (e) => void events.push(e) }),
    ],
    taskId: 'T-1',
  };
  return { ctx, events, records };
}

describe('grounding against real git content', () => {
  it('reports out-of-range, zero, negative and fractional lines as not found with no request', async () => {
    put('src/a.ts', lines(10));
    commit();
    const provider = new FakeJudgmentProvider();
    const h = setup(provider);
    const ann = await runFindingGrounding(
      [
        verdict(
          [999, 11, 0, -3, 1.5].map((line) => ({
            severity: 'minor' as const,
            file: 'src/a.ts',
            line,
            message: 'm',
          })),
        ),
      ],
      { ctx: h.ctx, worktreePath: dir },
    );
    expect(ann?.map((a) => a.relation)).toEqual(Array(5).fill('location-not-found'));
    expect(provider.requests).toHaveLength(0);
  });

  it('untracked, gitignored and symlinked citations are never sent to the provider', async () => {
    put('.gitignore', '.env\n');
    commit();
    put('.env', 'TOKEN=abc\n');
    put('src/untracked.ts', lines(3));
    symlinkSync('/etc/hosts', join(dir, 'hosts-link'));
    git('add', 'hosts-link');
    git('commit', '-q', '-m', 'link');
    const provider = new FakeJudgmentProvider();
    const h = setup(provider);
    const ann = await runFindingGrounding(
      [
        verdict(
          ['.env', 'src/untracked.ts', 'hosts-link'].map((file) => ({
            severity: 'major' as const,
            file,
            line: 1,
            message: 'm',
          })),
        ),
      ],
      { ctx: h.ctx, worktreePath: dir },
    );
    expect(provider.requests).toHaveLength(0);
    expect(ann?.map((a) => a.relation)).toEqual(Array(3).fill('location-not-found'));
  });

  it('oversized and binary files are annotated cannot-tell without a provider call', async () => {
    put('big.txt', 'a'.repeat(MAX_GROUNDING_FILE_BYTES + 1));
    put('bin.dat', Buffer.from([1, 0, 2]));
    commit();
    const provider = new FakeJudgmentProvider();
    const h = setup(provider);
    const ann = await runFindingGrounding(
      [
        verdict([
          { severity: 'minor', file: 'big.txt', line: 1, message: 'm' },
          { severity: 'minor', file: 'bin.dat', line: 1, message: 'm' },
        ]),
      ],
      { ctx: h.ctx, worktreePath: dir },
    );
    expect(provider.requests).toHaveLength(0);
    expect(ann?.map((a) => a.relation)).toEqual(['cannot-tell', 'cannot-tell']);
    expect(h.events).toHaveLength(0);
  });

  it('sends a CRLF file with normalised excerpts', async () => {
    put('win.ts', 'a\r\nb\r\nc\r\n');
    commit();
    const provider = new FakeJudgmentProvider().script('finding-0', choice('supports'));
    const h = setup(provider);
    await runFindingGrounding(
      [verdict([{ severity: 'minor', file: 'win.ts', line: 2, message: 'm' }])],
      {
        ctx: h.ctx,
        worktreePath: dir,
      },
    );
    const state = provider.requests[0].state as { findings: Array<{ excerpt: string }> };
    expect(state.findings[0].excerpt).toBe('a\nb\nc');
  });

  it('reads each cited file once per run', async () => {
    put('src/a.ts', lines(10));
    commit();
    const provider = new FakeJudgmentProvider()
      .script('finding-0', choice('supports'))
      .script('finding-1', choice('supports'));
    const h = setup(provider);
    const calls: string[] = [];
    await runFindingGrounding(
      [
        verdict([
          { severity: 'minor', file: 'src/a.ts', line: 2, message: 'm' },
          { severity: 'minor', file: 'src/a.ts', line: 3, message: 'm' },
        ]),
      ],
      {
        ctx: h.ctx,
        worktreePath: dir,
        runner: async (c, a, o) => {
          calls.push(a.join(' '));
          return defaultRunner(c, a, o);
        },
      },
    );
    expect(calls.filter((c) => c.startsWith('ls-tree'))).toHaveLength(1);
  });
});

describe('location check obeys the enforce-to-shadow gate', () => {
  it('enforce configured but not promoted: nothing surfaced, no event, no PR section', async () => {
    const provider = new FakeJudgmentProvider();
    const h = setup(provider, { promoted: false });
    const ann = await runFindingGrounding(
      [verdict([{ severity: 'major', file: 'nope.ts', line: 1, message: 'm' }])],
      { ctx: h.ctx, worktreePath: dir },
    );
    expect(ann).toBeUndefined();
    expect(h.events).toHaveLength(0);
    expect(composeJudgmentNotes({ groundingAnnotations: ann })).toBe('');
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      mode: 'shadow',
      configuredMode: 'enforce',
      downgradeReason: 'no-thresholds',
      outcome: { kind: 'abstain', reason: 'shadow' },
      called: false,
    });
  });

  it('promoted enforce surfaces and escalates', async () => {
    const provider = new FakeJudgmentProvider();
    const h = setup(provider);
    const ann = await runFindingGrounding(
      [verdict([{ severity: 'major', file: 'nope.ts', line: 1, message: 'm' }])],
      { ctx: h.ctx, worktreePath: dir },
    );
    expect(ann).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'JudgmentEscalated')).toHaveLength(1);
    expect(h.records[0].mode).toBe('enforce');
  });

  it('an unresolvable provider downgrades to shadow', async () => {
    const provider = new FakeJudgmentProvider();
    const h = setup(provider);
    h.ctx.getProvider = () => undefined;
    const ann = await runFindingGrounding(
      [verdict([{ severity: 'major', file: 'nope.ts', line: 1, message: 'm' }])],
      { ctx: h.ctx, worktreePath: dir },
    );
    expect(ann).toBeUndefined();
    expect(h.records[0].downgradeReason).toBe('provider-unavailable');
  });
});

describe('grounding caps', () => {
  const item = (i: number) => ({
    id: `finding-${i}`,
    agentId: 'code-reviewer',
    findingIndex: i,
    claim: 'm',
    file: 'a.ts',
    line: 1,
    excerptStart: 1,
    excerpt: 'x'.repeat(400),
  });

  it('packs exactly by the budget', () => {
    const cost = estimateGroundingItemTokens(item(0));
    const items = [0, 1, 2].map(item);
    expect(batchGroundingItems(items, cost * 2 + 5).map((b) => b.length)).toEqual([2, 1]);
    expect(batchGroundingItems(items, cost + 5).map((b) => b.length)).toEqual([1, 1, 1]);
    expect(batchGroundingItems(items, cost * 10).map((b) => b.length)).toEqual([3]);
    expect(batchGroundingItems(items, 1).map((b) => b.length)).toEqual([1, 1, 1]);
    expect(batchGroundingItems([], 100)).toEqual([]);
  });

  it('a flood of findings considers at most the finding ceiling and logs the skip', async () => {
    put('src/a.ts', lines(5));
    commit();
    const provider = new FakeJudgmentProvider();
    for (let i = 0; i < MAX_GROUNDING_FINDINGS + 20; i++)
      provider.script(`finding-${i}`, choice('supports'));
    const h = setup(provider);
    const findings = Array.from({ length: MAX_GROUNDING_FINDINGS + 20 }, () => ({
      severity: 'minor' as const,
      file: 'src/a.ts',
      line: 2,
      message: 'm',
    }));
    const ann = await runFindingGrounding([verdict(findings)], { ctx: h.ctx, worktreePath: dir });
    expect(ann).toHaveLength(MAX_GROUNDING_FINDINGS);
    expect(
      h.records.some(
        (r) => r.outcome.kind === 'abstain' && r.outcome.reason === 'finding-cap-exceeded',
      ),
    ).toBe(true);
  });

  it('never makes more provider requests than the request ceiling', async () => {
    put('src/a.ts', lines(5));
    commit();
    const provider = new FakeJudgmentProvider({ capabilities: { maxStateTokens: 150 } });
    for (let i = 0; i < MAX_GROUNDING_FINDINGS; i++)
      provider.script(`finding-${i}`, choice('supports'));
    const h = setup(provider);
    const findings = Array.from({ length: 30 }, () => ({
      severity: 'minor' as const,
      file: 'src/a.ts',
      line: 2,
      message: 'm',
    }));
    await runFindingGrounding([verdict(findings)], { ctx: h.ctx, worktreePath: dir });
    expect(provider.requests.length).toBeLessThanOrEqual(MAX_GROUNDING_REQUESTS);
    expect(provider.requests.length).toBe(MAX_GROUNDING_REQUESTS);
    expect(
      h.records.some(
        (r) => r.outcome.kind === 'abstain' && r.outcome.reason === 'request-cap-exceeded',
      ),
    ).toBe(true);
  });
});

describe('PR-body text is neutralised', () => {
  it('quotes hostile file paths, reviewer ids and criterion text', () => {
    const notes = composeJudgmentNotes({
      acCoverage: {
        criteria: [{ index: 0, probability: 0.1, likelyUncovered: true }],
        uncovered: 1,
      },
      acceptanceCriteria: ['see AISDLC-123\n\n## Approved\n[a](https://evil) @everyone `x`'],
      groundingAnnotations: [
        {
          agentId: 'bad\n## Pwn @team',
          findingIndex: 0,
          file: 'x\n\n## Approved\n[a](https://evil)`@bob',
          line: 4,
          relation: 'location-not-found',
        },
      ],
    });
    // No injected heading or line start: every bullet is a single line.
    expect(notes.split('\n').filter((l) => l.startsWith('#'))).toEqual([
      '## Judgment notes (advisory)',
    ]);
    const bullets = notes.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(2);
    for (const b of bullets) expect(b).not.toMatch(/\n/);
    // Hostile text sits inside code spans (no backticks inside them).
    expect(bullets[1]).toContain('`x ## Approved [a](https://evil) @bob:4`');
    expect(bullets[1]).toContain('A reviewer finding');
    expect(bullets[0]).toContain('`see AISDLC-123 ## Approved [a](https://evil) @everyone x`');
    expect(notes).not.toContain('bad');
  });

  it('keeps legitimate reviewer ids and truncates long paths', () => {
    const notes = composeJudgmentNotes({
      groundingAnnotations: [
        {
          agentId: 'security-reviewer',
          findingIndex: 0,
          file: 'p/'.repeat(300),
          line: 1,
          relation: 'unrelated',
        },
      ],
    });
    expect(notes).toContain('A security-reviewer finding');
    expect(notes).toContain('...`');
  });
});
