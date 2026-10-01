import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelCallRecord } from '@ai-sdlc/reference';
import type { ReviewLedgerRecord } from '../attestation/reviews-ledger.js';
import {
  assignmentKey,
  buildScorecard,
  deriveOutcomes,
  normalizeRole,
  renderScorecardCsv,
  renderScorecardJson,
  renderScorecardText,
  type AssignmentEntry,
  type TaskInfo,
} from './scorecard.js';
import {
  evidenceFileName,
  loadContractRetries,
  loadTaskInfo,
  readAssignmentLog,
  writeEvidenceFiles,
} from './scorecard-sources.js';
import { deriveUnitWeights } from './units.js';

const weights = deriveUnitWeights([], '2026-09-10T00:00:00Z');

function rev(
  taskId: string,
  iteration: number,
  role: ReviewLedgerRecord['role'],
  verdict: 'approved' | 'rejected',
  severities: Array<'critical' | 'major' | 'minor' | 'suggestion'> = [],
): ReviewLedgerRecord {
  return {
    taskId,
    prNumber: null,
    commitSha: 'a'.repeat(40),
    iteration,
    role,
    harness: 'claude-code',
    timestamp: '2026-09-10T00:00:00Z',
    verdict,
    findings: severities.map((severity) => ({ severity, summary: 's', title: 't' })),
  };
}

let n = 0;
function call(taskId: string, over: Partial<ModelCallRecord> = {}): ModelCallRecord {
  n += 1;
  return {
    schemaVersion: 'v1',
    callId: `c${n}`,
    ts: '2026-09-10T00:00:00.000Z',
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'model-a',
    tokens: { input: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
    billingPool: 'subscription-interactive',
    sessionId: 's',
    agentRole: 'ai-sdlc:developer',
    scope: 'framework',
    repo: 'repo-a',
    taskId,
    ...over,
  };
}

describe('deriveOutcomes', () => {
  it('marks first-pass approval with only minor findings, not with a major one', () => {
    const out = deriveOutcomes(
      [
        rev('T-1', 1, 'code', 'approved', ['minor']),
        rev('T-1', 1, 'security', 'approved', ['suggestion']),
        rev('T-2', 1, 'code', 'approved', ['major']),
        rev('T-2', 1, 'security', 'approved'),
        rev('T-2', 2, 'code', 'approved'),
        rev('T-3', 1, 'code', 'approved'),
        rev('T-3', 1, 'test', 'rejected'),
        rev('T-3', 2, 'test', 'approved'),
        rev('T-3', 3, 'test', 'approved'),
      ],
      new Map([['T-3', 2]]),
    );
    expect(out.get('T-1')).toMatchObject({
      firstPassApproved: true,
      iterations: 1,
      blockingFindings: 0,
    });
    expect(out.get('T-2')).toMatchObject({
      firstPassApproved: false,
      iterations: 2,
      blockingFindings: 1,
    });
    expect(out.get('T-3')).toMatchObject({
      firstPassApproved: false,
      iterations: 3,
      contractRetries: 2,
    });
  });

  it('skips malformed records', () => {
    expect(deriveOutcomes([{} as ReviewLedgerRecord]).size).toBe(0);
  });
});

describe('buildScorecard', () => {
  const feature: TaskInfo = { taskClass: 'feature', size: 'M' };

  function fixture(count: number) {
    const reviews: ReviewLedgerRecord[] = [];
    const calls: ModelCallRecord[] = [];
    const info = new Map<string, TaskInfo>();
    for (let i = 0; i < count; i++) {
      const id = `T-${i}`;
      // Every third task needs a second iteration with a major finding.
      const bad = i % 3 === 0;
      reviews.push(rev(id, 1, 'code', bad ? 'rejected' : 'approved', bad ? ['major'] : []));
      if (bad) reviews.push(rev(id, 2, 'code', 'approved'));
      calls.push(
        call(id, {
          tokens: {
            input: 100 * (i + 1),
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            cacheRead: 0,
            output: 0,
          },
        }),
      );
      info.set(id, feature);
    }
    return { reviews, calls, info };
  }

  it('reports hand-computed rate, iterations and units', () => {
    const f = fixture(6); // tasks 0 and 3 are bad -> 4/6 approved
    const card = buildScorecard({
      records: f.calls,
      outcomes: deriveOutcomes(f.reviews),
      taskInfo: f.info,
      assignments: new Map(),
      weights,
    });
    expect(card.rows).toHaveLength(1);
    const row = card.rows[0];
    expect(row).toMatchObject({
      role: 'developer',
      model: 'model-a',
      taskClass: 'feature',
      tasks: 6,
      approved: 4,
      source: 'usage-majority',
      explored: 0,
      sizes: { M: 6 },
    });
    expect(row.firstPassApprovalRate).toBeCloseTo(4 / 6);
    expect(row.meanIterations).toBeCloseTo(8 / 6);
    expect(row.meanBlockingFindings).toBeCloseTo(2 / 6);
    expect(row.meanUnitsPerTask).toBeCloseTo((100 + 200 + 300 + 400 + 500 + 600) / 6);
    expect(row.dateRange.from).toBe('2026-09-10T00:00:00.000Z');
    expect(row.taskIds).toHaveLength(6);
  });

  it('labels 29 tasks insufficient and 30 not', () => {
    for (const [count, expected] of [
      [29, true],
      [30, false],
    ] as const) {
      const f = fixture(count);
      const card = buildScorecard({
        records: f.calls,
        outcomes: deriveOutcomes(f.reviews),
        taskInfo: f.info,
        assignments: new Map(),
        weights,
      });
      expect(card.rows[0].insufficient).toBe(expected);
    }
  });

  it('honours a configured threshold', () => {
    const f = fixture(5);
    const card = buildScorecard({
      records: f.calls,
      outcomes: deriveOutcomes(f.reviews),
      taskInfo: f.info,
      assignments: new Map(),
      weights,
      minTasks: 5,
    });
    expect(card.rows[0].insufficient).toBe(false);
  });

  it('uses the assignment log model, else the usage majority, and counts explored tasks', () => {
    const reviews = [rev('T-1', 1, 'code', 'approved'), rev('T-2', 1, 'code', 'approved')];
    const calls = [
      call('T-1', { model: 'model-a' }),
      call('T-1', { model: 'model-a' }),
      call('T-1', { model: 'model-b' }),
      call('T-2', { model: 'model-a' }),
      call('T-2', { model: 'model-b' }),
      call('T-2', { model: 'model-b' }),
    ];
    const assignments = new Map<string, AssignmentEntry>([
      [assignmentKey('T-2', 'developer'), { model: 'model-c', explore: true }],
    ]);
    const card = buildScorecard({
      records: calls,
      outcomes: deriveOutcomes(reviews),
      taskInfo: new Map(),
      assignments,
      weights,
    });
    const a = card.rows.find((r) => r.model === 'model-a');
    const c = card.rows.find((r) => r.model === 'model-c');
    expect(a).toMatchObject({ source: 'usage-majority', explored: 0, taskClass: 'uncategorized' });
    expect(c).toMatchObject({ source: 'assignment-log', explored: 1 });
  });

  it('marks mixed sources in one cell', () => {
    const reviews = [rev('T-1', 1, 'code', 'approved'), rev('T-2', 1, 'code', 'approved')];
    const card = buildScorecard({
      records: [call('T-1'), call('T-2')],
      outcomes: deriveOutcomes(reviews),
      taskInfo: new Map(),
      assignments: new Map([
        [assignmentKey('T-1', 'developer'), { model: 'model-a', explore: false }],
      ]),
      weights,
    });
    expect(card.rows[0].source).toBe('mixed');
  });

  it('excludes tasks without review rows and reports the no-outcome total', () => {
    const card = buildScorecard({
      records: [call('T-1'), call('T-9'), call('T-9', { agentRole: 'main-session' })],
      outcomes: deriveOutcomes([rev('T-1', 1, 'code', 'approved')]),
      taskInfo: new Map(),
      assignments: new Map(),
      weights,
    });
    expect(card.noOutcome).toBe(1);
    expect(card.noOutcomeTaskIds).toEqual(['T-9']);
    expect(card.rows.every((r) => !r.taskIds.includes('T-9'))).toBe(true);
    expect(card.rows[0].tasks).toBe(1);
  });

  it('gives conductor and reviewer rows units without an approval rate', () => {
    const card = buildScorecard({
      records: [
        call('T-1', { agentRole: 'main-session' }),
        call('T-1', { agentRole: 'ai-sdlc:code-reviewer' }),
        call('T-5', { agentRole: 'ai-sdlc:code-reviewer' }),
      ],
      outcomes: deriveOutcomes([rev('T-1', 1, 'code', 'approved')]),
      taskInfo: new Map(),
      assignments: new Map(),
      weights,
    });
    const conductor = card.rows.find((r) => r.role === 'main-session');
    expect(conductor).toMatchObject({
      tasks: 1,
      firstPassApprovalRate: null,
      meanUnitsPerTask: 100,
    });
    const reviewer = card.rows.find((r) => r.role === 'code-reviewer');
    expect(reviewer).toMatchObject({ tasks: 2, firstPassApprovalRate: null, approved: null });
  });

  it('filters by role', () => {
    const card = buildScorecard({
      records: [call('T-1'), call('T-1', { agentRole: 'main-session' })],
      outcomes: deriveOutcomes([rev('T-1', 1, 'code', 'approved')]),
      taskInfo: new Map(),
      assignments: new Map(),
      weights,
      role: 'ai-sdlc:developer',
    });
    expect(card.rows.map((r) => r.role)).toEqual(['developer']);
  });

  it('renders text, csv and json', () => {
    const f = fixture(3);
    const card = {
      ...buildScorecard({
        records: f.calls,
        outcomes: deriveOutcomes(f.reviews),
        taskInfo: f.info,
        assignments: new Map(),
        weights,
      }),
      unitsNote: 'note',
    };
    const text = renderScorecardText(card);
    expect(text).toContain('insufficient');
    expect(text).toContain('no review outcome');
    expect(renderScorecardCsv(card).split('\n')[0]).toContain('first_pass');
    const json = JSON.parse(renderScorecardJson(card));
    expect(json.rows[0].taskDetails).toBeUndefined();
    expect(json.unitsNote).toBe('note');
    expect(
      renderScorecardText({ rows: [], noOutcome: 2, noOutcomeTaskIds: [], minTasks: 30 }),
    ).toContain('No scored tasks');
    expect(normalizeRole(' AI-SDLC:Developer ')).toBe('developer');
  });

  it('escapes csv fields', () => {
    const card = buildScorecard({
      records: [call('T-1', { model: 'a,"b"' })],
      outcomes: deriveOutcomes([rev('T-1', 1, 'code', 'approved')]),
      taskInfo: new Map(),
      assignments: new Map(),
      weights,
    });
    expect(renderScorecardCsv(card)).toContain('"a,""b"""');
  });
});

describe('sources', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scorecard-src-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the assignment log defensively, first entry wins', () => {
    const p = join(dir, 'a.jsonl');
    writeFileSync(
      p,
      [
        JSON.stringify({ taskId: 'T-1', role: 'ai-sdlc:developer', model: 'm1', arm: 'explore' }),
        JSON.stringify({ taskId: 'T-1', role: 'developer', model: 'm2' }),
        'not json',
        JSON.stringify({ taskId: 'T-2', role: 'developer', model: 'm3', reason: 'table' }),
        JSON.stringify({ taskId: 'T-3', role: 'developer', model: 'm4', reason: 'explore' }),
        JSON.stringify({ role: 'developer' }),
        'null',
      ].join('\n'),
    );
    const log = readAssignmentLog(p);
    expect(log.get(assignmentKey('T-1', 'developer'))).toEqual({ model: 'm1', explore: true });
    expect(log.get(assignmentKey('T-2', 'developer'))).toEqual({ model: 'm3', explore: false });
    expect(log.get(assignmentKey('T-3', 'developer'))?.explore).toBe(true);
    expect(log.size).toBe(3);
    expect(readAssignmentLog(join(dir, 'missing.jsonl')).size).toBe(0);
  });

  it('reads task class from frontmatter, then the estimate log, else uncategorized', () => {
    mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(dir, 'art', '_estimates'), { recursive: true });
    writeFileSync(
      join(dir, 'backlog', 'tasks', 'aisdlc-1 - a thing.md'),
      '---\nid: AISDLC-1\nclass: bug\n---\n\nclass: feature\n',
    );
    writeFileSync(join(dir, 'backlog', 'tasks', 'aisdlc-4 - nofm.md'), 'class: bug\n');
    writeFileSync(
      join(dir, 'art', '_estimates', 'log.jsonl'),
      [
        JSON.stringify({ taskId: 'AISDLC-1', class: 'chore', finalBucket: 'S' }),
        JSON.stringify({ taskId: 'AISDLC-2', class: 'feature', finalBucket: 'L' }),
        JSON.stringify({ taskId: 'AISDLC-4', class: 'weird' }),
        '{bad',
      ].join('\n'),
    );
    const info = loadTaskInfo(['AISDLC-1', 'AISDLC-2', 'AISDLC-3', 'AISDLC-4'], {
      repoRoot: dir,
      artifactsDir: join(dir, 'art'),
    });
    expect(info.get('AISDLC-1')).toEqual({ taskClass: 'bug', size: 'S' });
    expect(info.get('AISDLC-2')).toEqual({ taskClass: 'feature', size: 'L' });
    expect(info.get('AISDLC-3')).toEqual({ taskClass: 'uncategorized' });
    expect(info.get('AISDLC-4')).toEqual({ taskClass: 'uncategorized' });
  });

  it('counts contract retry events per task', () => {
    const d = join(dir, 'art', '_orchestrator');
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, 'events-2026-09-10.jsonl'),
      [
        JSON.stringify({ ts: 't', type: 'DeveloperContractRetry', taskId: 'T-1' }),
        JSON.stringify({ ts: 't', type: 'DeveloperContractRetry', taskId: 'T-1' }),
        JSON.stringify({ ts: 't', type: 'DeveloperContractRetry' }),
        JSON.stringify({ ts: 't', type: 'OrchestratorIdleNoWork', taskId: 'T-1' }),
      ].join('\n'),
    );
    expect(loadContractRetries(join(dir, 'art')).get('T-1')).toBe(2);
    expect(loadContractRetries(join(dir, 'none')).size).toBe(0);
  });

  it('writes one evidence file per cell with task ids', () => {
    const card = buildScorecard({
      records: [call('T-1'), call('T-2', { model: 'model/b' })],
      outcomes: deriveOutcomes([
        rev('T-1', 1, 'code', 'approved'),
        rev('T-2', 1, 'code', 'approved'),
      ]),
      taskInfo: new Map(),
      assignments: new Map(),
      weights,
    });
    const out = join(dir, 'evidence');
    const paths = writeEvidenceFiles(out, card, { repo: 'repo-a', generatedAt: 'now' });
    expect(paths).toHaveLength(2);
    expect(readdirSync(out).sort()).toEqual([
      'developer.uncategorized.model-a.json',
      'developer.uncategorized.model-b.json',
    ]);
    const doc = JSON.parse(readFileSync(paths[0], 'utf8'));
    expect(doc).toMatchObject({ scope: 'framework', repo: 'repo-a' });
    expect(doc.row.taskIds).toEqual(['T-1']);
    expect(doc.tasks[0].taskId).toBe('T-1');
    expect(evidenceFileName({ role: 'a b', model: 'M/X', taskClass: 'bug' })).toBe(
      'a-b.bug.m-x.json',
    );
  });

  it('keeps colliding cell names as separate files', () => {
    const models = ['Model-B', 'model-b', 'model/b', 'foo:bar', 'foo-bar'];
    const card = buildScorecard({
      records: models.map((m, i) => call(`T-${i}`, { model: m })),
      outcomes: deriveOutcomes(models.map((_, i) => rev(`T-${i}`, 1, 'code', 'approved'))),
      taskInfo: new Map(),
      assignments: new Map(),
      weights,
    });
    const out = join(dir, 'evidence');
    const paths = writeEvidenceFiles(out, card, { repo: 'repo-a', generatedAt: 'now' });
    expect(new Set(paths).size).toBe(5);
    expect(readdirSync(out)).toHaveLength(5);
    const seen = paths.map((p) => JSON.parse(readFileSync(p, 'utf8')).cell.model).sort();
    expect(seen).toEqual([...models].sort());
  });

  it('replaces a symlink at an evidence path instead of following it', () => {
    const card = buildScorecard({
      records: [call('T-1')],
      outcomes: deriveOutcomes([rev('T-1', 1, 'code', 'approved')]),
      taskInfo: new Map(),
      assignments: new Map(),
      weights,
    });
    const out = join(dir, 'evidence');
    mkdirSync(out);
    const target = join(dir, 'outside.txt');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(out, 'developer.uncategorized.model-a.json'));
    writeEvidenceFiles(out, card, { repo: 'repo-a', generatedAt: 'now' });
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(lstatSync(join(out, 'developer.uncategorized.model-a.json')).isSymbolicLink()).toBe(
      false,
    );
  });
});

describe('hostile input', () => {
  it('counts hostile size keys as plain data', () => {
    const sizes = ['__proto__', 'constructor', 'toString'];
    const info = new Map(sizes.map((s, i) => [`T-${i}`, { taskClass: 'bug' as const, size: s }]));
    const card = buildScorecard({
      records: sizes.map((_, i) => call(`T-${i}`)),
      outcomes: deriveOutcomes(sizes.map((_, i) => rev(`T-${i}`, 1, 'code', 'approved'))),
      taskInfo: info,
      assignments: new Map(),
      weights,
    });
    const row = card.rows[0];
    expect(Object.keys(row.sizes).sort()).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.getOwnPropertyDescriptor(row.sizes, '__proto__')?.value).toBe(1);
    expect(JSON.parse(renderScorecardJson(card)).rows[0].sizes.constructor).toBe(1);
  });

  it('skips malformed ledger records and non-finite units', () => {
    const bad = [
      call('T-1', { agentRole: undefined as unknown as string }),
      call('T-1', { model: 5 as unknown as string }),
      call('T-1', { ts: undefined as unknown as string }),
      call('T-1', {
        tokens: { input: Number.NaN, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
      }),
    ];
    const card = buildScorecard({
      records: [...bad, call('T-1')],
      outcomes: deriveOutcomes([rev('T-1', 1, 'code', 'approved')]),
      taskInfo: new Map(),
      assignments: new Map(),
      weights,
    });
    expect(card.rows).toHaveLength(1);
    expect(card.rows[0].meanUnitsPerTask).toBe(100);
    expect(JSON.parse(renderScorecardJson(card)).rows[0].meanUnitsPerTask).toBe(100);
  });
});
