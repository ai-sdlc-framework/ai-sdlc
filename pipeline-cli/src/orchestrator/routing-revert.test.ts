import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAll } from '../decisions/index.js';
import type { RoutingTable } from '../routing/default-table.js';
import { overridesPath, writeOverride } from '../routing/overrides.js';
import type { Collected } from '../usage/route-commands.js';
import type { OrchestratorEvent } from './events.js';
import {
  ROUTING_REVERT_SCOPE,
  escapeForDecision,
  readEvidenceBenchmark,
  runRoutingReverts,
  type RoutingRevertOptions,
  type RoutingRevertResult,
} from './routing-revert.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const REPO_ID = 'repo-id-1';
const SINCE = '2026-09-10T00:00:00.000Z';
const EVIDENCE_REF = 'evidence/developer.chore.sonnet.json';

let root: string;
let artifacts: string;
let decisions: string;
let events: Array<Omit<OrchestratorEvent, 'ts'>>;
let warnings: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'routing-revert-'));
  artifacts = join(root, '.ai-sdlc', 'artifacts');
  decisions = join(root, 'decisions');
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(decisions, { recursive: true });
  events = [];
  warnings = [];
});
afterEach(() => removeFixtureDir(root));

function table(over: Partial<RoutingTable['cells']['developer']['*']> = {}): RoutingTable {
  return {
    strength: ['sonnet', 'opus'],
    exploreShare: 0,
    salt: '',
    cells: {
      developer: {
        '*': { model: 'sonnet', previousModel: 'opus', evidence: EVIDENCE_REF, ...over },
      },
      'security-reviewer': { '*': { model: 'opus' } },
    },
  };
}

function writeEvidence(over: Record<string, unknown> = {}, ref = EVIDENCE_REF): void {
  const file = join(artifacts, ref);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 'v1',
      repoId: REPO_ID,
      generatedAt: SINCE,
      cell: { role: 'developer', model: 'sonnet', taskClass: 'chore' },
      row: { tasks: 40, approved: 32 }, // 80%
      ...over,
    }),
  );
}

function collected(
  tasks: number,
  approved: number,
  over: Partial<Pick<Collected, 'repoId' | 'legacyRecords' | 'unavailableRecords'>> = {},
): Collected {
  return {
    card: {
      rows: [{ role: 'developer', model: 'sonnet', taskClass: 'chore', tasks, approved }],
      noOutcome: 0,
      noOutcomeTaskIds: [],
      minTasks: 30,
    },
    weights: {},
    minTasks: 30,
    replay: [],
    replayFiles: new Map(),
    warnings: [],
    repo: 'repo',
    repoId: REPO_ID,
    legacyRecords: 0,
    unavailableRecords: 0,
    ...over,
  } as unknown as Collected;
}

function run(
  t: RoutingTable | undefined,
  data: Collected | NonNullable<RoutingRevertOptions['collectEvidence']>,
  extra: Partial<RoutingRevertOptions> = {},
): Promise<RoutingRevertResult | 'skipped' | 'error'> {
  return runRoutingReverts({
    workDir: root,
    artifactsDir: artifacts,
    now: () => new Date('2026-10-10T12:00:00Z'),
    emit: (e) => void events.push(e),
    warn: (m) => void warnings.push(m),
    deps: {
      decisionsWorkDir: decisions,
      loadTable: () =>
        t ? { source: 'repo', table: t } : { source: 'default', reason: 'no-table' },
    },
    collectEvidence: typeof data === 'function' ? data : async () => data,
    env: {},
    ...extra,
  });
}

function decisionList() {
  return [...projectAll({ workDir: decisions }).decisions.values()];
}

describe('runRoutingReverts', () => {
  it('reverts a cell 6.7 points below its evidence over 30 tasks: override, event, Decision', async () => {
    writeEvidence();
    const result = (await run(table(), collected(30, 22))) as RoutingRevertResult;

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.override).toEqual({
      role: 'developer',
      taskClass: '*',
      model: 'opus',
      tableModel: 'sonnet',
    });
    const file = JSON.parse(readFileSync(overridesPath(artifacts), 'utf8'));
    expect(file.overrides).toEqual([result.applied[0]?.override]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'ModelRoutingOverrideApplied',
      role: 'developer',
      taskClass: '*',
      model: 'opus',
      tableModel: 'sonnet',
      tasks: 30,
      evidenceRate: 0.8,
      decisionId: result.applied[0]?.decisionId,
    });
    expect(events[0]?.observedRate).toBeCloseTo(22 / 30);

    const decs = decisionList();
    expect(decs).toHaveLength(1);
    expect(decs[0]?.metadata.scope).toBe(ROUTING_REVERT_SCOPE);
    expect(decs[0]?.metadata.id).toBe(result.applied[0]?.decisionId);
    expect(decs[0]?.spec.options.map((o) => o.id)).toEqual(['acknowledge']);
  });

  it('does nothing with 29 tasks', async () => {
    writeEvidence();
    const result = (await run(table(), collected(29, 10))) as RoutingRevertResult;
    expect(result.applied).toEqual([]);
    expect(result.evaluations[0]?.reason).toContain('29 tasks');
    expect(events).toEqual([]);
    expect(decisionList()).toEqual([]);
  });

  it('does nothing at exactly 5 points below', async () => {
    writeEvidence(); // 80%
    // 30 tasks, 75% would be 22.5: use 40 tasks at 75% = 30 approved.
    const result = (await run(table(), collected(40, 30))) as RoutingRevertResult;
    expect(result.applied).toEqual([]);
    expect(events).toEqual([]);
  });

  it('is idempotent: a second tick neither rewrites the override nor files another Decision', async () => {
    writeEvidence();
    await run(table(), collected(30, 22));
    const second = (await run(table(), collected(30, 22))) as RoutingRevertResult;
    expect(second.applied).toEqual([]);
    expect(second.evaluations[0]?.reason).toBe('an override already covers this cell');
    expect(events).toHaveLength(1);
    expect(decisionList()).toHaveLength(1);
  });

  it('drops the override on the next tick once the table cell changes', async () => {
    writeEvidence();
    await run(table(), collected(30, 22));
    expect(JSON.parse(readFileSync(overridesPath(artifacts), 'utf8')).overrides).toHaveLength(1);

    // The proposal path moved the cell to a different model (no revert data to judge).
    const moved = table({ model: 'opus', previousModel: undefined, evidence: undefined });
    const result = (await run(moved, collected(0, 0))) as RoutingRevertResult;
    expect(result.dropped).toHaveLength(1);
    expect(JSON.parse(readFileSync(overridesPath(artifacts), 'utf8')).overrides).toEqual([]);
  });

  it('files no Decision when the catalog is off, but still writes the override and event', async () => {
    writeEvidence();
    const result = (await run(table(), collected(30, 22), {
      env: { AI_SDLC_DECISION_CATALOG: 'off' },
    })) as RoutingRevertResult;
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.decisionId).toBeUndefined();
    expect(events[0]?.decisionId).toBeUndefined();
    expect(decisionList()).toEqual([]);
  });

  it('keeps the override when the Decision cannot be filed or the event sink throws', async () => {
    writeEvidence();
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'x');
    const result = (await run(table(), collected(30, 22), {
      deps: {
        decisionsWorkDir: join(blocker, 'sub'),
        loadTable: () => ({ source: 'repo', table: table() }),
      },
      emit: () => {
        throw new Error('sink');
      },
    })) as RoutingRevertResult;
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.decisionId).toBeUndefined();
    expect(warnings.some((w) => w.includes('Decision not filed'))).toBe(true);
    expect(JSON.parse(readFileSync(overridesPath(artifacts), 'utf8')).overrides).toHaveLength(1);
  });

  it('refuses the revert when _routing is a symlink that leaves the artifacts directory', async () => {
    writeEvidence();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(artifacts, '_routing'));
    const result = (await run(table(), collected(30, 22))) as RoutingRevertResult;
    expect(result.applied).toEqual([]);
    expect(warnings.some((w) => w.includes('refused: path leaves the artifacts directory'))).toBe(
      true,
    );
    expect(events).toEqual([]);
    expect(decisionList()).toEqual([]);
  });

  it('skips evidence that is not attributable to this repository', async () => {
    writeEvidence();
    for (const data of [
      collected(30, 22, { repoId: undefined }),
      collected(30, 22, { repoId: 'someone-else' }),
      collected(30, 22, { legacyRecords: 2 }),
      collected(30, 22, { unavailableRecords: 1 }),
    ]) {
      const result = (await run(table(), data)) as RoutingRevertResult;
      expect(result.evaluations).toEqual([]);
    }
    expect(events).toEqual([]);
  });

  it('skips a cell whose previous model is not stronger, or that lacks evidence or a previous model', async () => {
    writeEvidence();
    for (const t of [
      table({ previousModel: 'sonnet' }),
      table({ model: 'opus', previousModel: 'sonnet' }),
      table({ previousModel: 'mystery' }),
      table({ evidence: undefined }),
      table({ previousModel: undefined }),
    ]) {
      const result = (await run(t, collected(30, 22))) as RoutingRevertResult;
      expect(result.applied).toEqual([]);
      expect(result.evaluations).toEqual([]);
    }
  });

  it('skips a cell whose evidence file is unusable', async () => {
    // Missing file.
    expect(((await run(table(), collected(30, 22))) as RoutingRevertResult).evaluations).toEqual(
      [],
    );
    // Wrong cell.
    writeEvidence({ cell: { role: 'developer', model: 'opus', taskClass: 'chore' } });
    expect(((await run(table(), collected(30, 22))) as RoutingRevertResult).evaluations).toEqual(
      [],
    );
  });

  it('reports observed rows with malformed counts as no candidate', async () => {
    writeEvidence();
    const result = (await run(table(), collected(30, 40))) as RoutingRevertResult;
    expect(result.evaluations).toEqual([]);
  });

  it('groups cells by evidence time: one collection per start time', async () => {
    writeEvidence();
    const t = table();
    t.cells['code-reviewer'] = {
      '*': { model: 'sonnet', previousModel: 'opus', evidence: 'evidence/code.json' },
    };
    writeEvidence(
      { cell: { role: 'code-reviewer', model: 'sonnet', taskClass: 'x' } },
      'evidence/code.json',
    );
    const collect = vi.fn(async (_deps: unknown, _opts: { since: string }) => collected(30, 22));
    await run(t, collect);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0]?.[1]).toEqual({ since: SINCE });
  });

  it('skips when there is no repo table', async () => {
    expect(await run(undefined, collected(30, 22))).toBe('skipped');
  });

  it('returns early with only the dropped list when no cell was changed by a proposal', async () => {
    const plain = table({ previousModel: undefined, evidence: undefined });
    writeOverride(artifacts, table(), { role: 'developer', taskClass: '*', model: 'opus' });
    const collect = vi.fn(async () => collected(0, 0));
    const result = (await run(plain, collect)) as RoutingRevertResult;
    expect(collect).not.toHaveBeenCalled();
    expect(result.dropped).toHaveLength(0);
    expect(result.evaluations).toEqual([]);
  });

  it('never throws: a failing collection returns "error" and warns', async () => {
    writeEvidence();
    const result = await run(table(), async () => {
      throw new Error('usage unreadable');
    });
    expect(result).toBe('error');
    expect(warnings.some((w) => w.includes('routing revert failed: usage unreadable'))).toBe(true);
  });

  it('does not throw when the warning sink itself fails', async () => {
    writeEvidence();
    const result = await run(
      table(),
      async () => {
        throw new Error('x');
      },
      {
        warn: () => {
          throw new Error('sink');
        },
      },
    );
    expect(result).toBe('error');
  });

  it('runs without an event sink or warning sink', async () => {
    writeEvidence();
    const result = (await run(table(), collected(30, 22), {
      emit: undefined,
      warn: undefined,
    })) as RoutingRevertResult;
    expect(result.applied).toHaveLength(1);
  });

  it('honours a custom margin', async () => {
    writeEvidence();
    const result = (await run(table(), collected(30, 22), {
      marginPoints: 10,
    })) as RoutingRevertResult;
    expect(result.applied).toEqual([]);
  });
});

describe('Decision text', () => {
  it('escapes model names that carry control characters, backticks or markdown', async () => {
    const evil = 'opus`\n## injected\u001b[2J';
    writeEvidence({ cell: { role: 'developer', model: 'sonnet', taskClass: 'chore' } });
    const t = table({ previousModel: evil });
    t.strength = ['sonnet', evil];
    const result = (await run(t, collected(30, 22))) as RoutingRevertResult;
    expect(result.applied).toHaveLength(1);
    const dec = decisionList()[0];
    const text = `${dec?.spec.summary}\n${dec?.spec.body ?? ''}`;
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('## injected');
    expect(text).toContain('opus??');
  });

  it('escapeForDecision keeps ordinary ids and replaces everything else', () => {
    expect(escapeForDecision('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(escapeForDecision('a b`c\nd')).toBe('a?b?c?d');
    expect(escapeForDecision('x'.repeat(100)).length).toBeLessThanOrEqual(64);
    expect(escapeForDecision(undefined)).toBe('');
  });
});

describe('readEvidenceBenchmark', () => {
  const cell = { role: 'developer', taskClass: '*', model: 'sonnet' };

  it('reads the rate, time and repository identity', () => {
    writeEvidence();
    expect(readEvidenceBenchmark(artifacts, EVIDENCE_REF, cell)).toEqual({
      rate: 0.8,
      since: SINCE,
      repoId: REPO_ID,
    });
  });

  it('requires an exact task class unless the cell is the wildcard', () => {
    writeEvidence();
    expect(
      readEvidenceBenchmark(artifacts, EVIDENCE_REF, { ...cell, taskClass: 'chore' }),
    ).toBeDefined();
    expect(
      readEvidenceBenchmark(artifacts, EVIDENCE_REF, { ...cell, taskClass: 'bug' }),
    ).toBeUndefined();
  });

  it('rejects unsafe references, escapes and symlinks that leave the directory', () => {
    writeEvidence();
    expect(readEvidenceBenchmark(artifacts, '../x.json', cell)).toBeUndefined();
    expect(readEvidenceBenchmark(artifacts, 'a b.json', cell)).toBeUndefined();
    expect(readEvidenceBenchmark(artifacts, '/etc/passwd', cell)).toBeUndefined();

    const outsideFile = join(root, 'outside.json');
    writeFileSync(outsideFile, readFileSync(join(artifacts, EVIDENCE_REF)));
    symlinkSync(outsideFile, join(artifacts, 'evidence', 'link.json'));
    expect(readEvidenceBenchmark(artifacts, 'evidence/link.json', cell)).toBeUndefined();
  });

  it('rejects malformed evidence', () => {
    const bad: Array<Record<string, unknown>> = [
      { schemaVersion: 'v2' },
      { row: { tasks: 0, approved: 0 } },
      { row: { tasks: 10, approved: 11 } },
      { row: { tasks: 10, approved: -1 } },
      { row: { tasks: 10.5, approved: 1 } },
      { row: { tasks: 10, approved: null } },
      { generatedAt: 'not a date' },
      { generatedAt: 5 },
      { cell: { role: 'other', model: 'sonnet', taskClass: 'x' } },
    ];
    for (const b of bad) {
      writeEvidence(b);
      expect(readEvidenceBenchmark(artifacts, EVIDENCE_REF, cell)).toBeUndefined();
    }
    writeFileSync(join(artifacts, EVIDENCE_REF), '{not json');
    expect(readEvidenceBenchmark(artifacts, EVIDENCE_REF, cell)).toBeUndefined();
  });

  it('reports a null repoId when the evidence carries none', () => {
    writeEvidence({ repoId: undefined });
    expect(readEvidenceBenchmark(artifacts, EVIDENCE_REF, cell)?.repoId).toBeNull();
  });
});
