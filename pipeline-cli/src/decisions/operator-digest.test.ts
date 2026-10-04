import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
  resolveDecisionsDir,
} from './event-log.js';
import type { DecisionEvent } from './decision-record.js';
import {
  buildOperatorDigest,
  gitProvenanceResolver,
  classifyDecision,
  renderOperatorDigestMarkdown,
  runOperatorDigest,
} from './operator-digest.js';

const opened = (id: string, extra: Record<string, unknown> = {}): DecisionEvent =>
  ({
    eventVersion: 'v1',
    type: 'decision-opened',
    ts: '2026-10-04T00:00:00.000Z',
    decisionId: id,
    source: 'ad-hoc',
    scope: 'workspace',
    summary: `summary ${id}`,
    options: [
      { id: 'opt-a', description: 'first' },
      { id: 'opt-b', description: 'second' },
    ],
    ...extra,
  }) as unknown as DecisionEvent;

const answered = (id: string, ts: string, type = 'operator-answered'): DecisionEvent =>
  ({
    eventVersion: 'v1',
    type,
    ts,
    decisionId: id,
    chosenOptionId: 'opt-b',
    rationale: 'because',
    by: 'planner',
  }) as unknown as DecisionEvent;

const NOW = new Date('2026-10-05T00:00:00.000Z');

describe('classifyDecision', () => {
  it('derives (a) without a timebox and (b) with one', () => {
    expect(classifyDecision(opened('DEC-1') as never)).toBe('a');
    expect(classifyDecision(opened('DEC-2', { timebox: 'P1D' }) as never)).toBe('b');
  });
  it('honours an explicit Class line, including (c)', () => {
    expect(classifyDecision(opened('DEC-3', { body: 'x\nClass: (c)\n' }) as never)).toBe('c');
  });
});

describe('buildOperatorDigest', () => {
  it('lists only decisions answered after the cutoff, with reverse hints', () => {
    const d = buildOperatorDigest(
      [
        opened('DEC-1'),
        answered('DEC-1', '2026-10-04T12:00:00.000Z'),
        opened('DEC-2'),
        answered('DEC-2', '2026-10-01T12:00:00.000Z'),
      ],
      '2026-10-03T00:00:00.000Z',
      NOW,
    );
    expect(d.answered.map((a) => a.decisionId)).toEqual(['DEC-1']);
    expect(d.answered[0]!.reverse).toContain('cli-decisions answer DEC-1 opt-a');
  });

  it('marks auto-expired answers and lists unexpired timeboxed decisions', () => {
    const d = buildOperatorDigest(
      [
        opened('DEC-1', { timeboxExpiresAt: '2026-10-04T06:00:00.000Z' }),
        answered('DEC-1', '2026-10-04T06:00:01.000Z', 'auto-expired'),
        opened('DEC-2', {
          timeboxExpiresAt: '2026-10-05T10:00:00.000Z',
          autonomousFallbackOptionId: 'opt-a',
        }),
        opened('DEC-3', { timeboxExpiresAt: '2026-10-04T10:00:00.000Z' }),
      ],
      '2026-10-03T00:00:00.000Z',
      NOW,
    );
    expect(d.answered[0]!.answeredBy).toBe('auto-expired');
    expect(d.pending.map((p) => p.decisionId)).toEqual(['DEC-2']);
    expect(renderOperatorDigestMarkdown(d)).toContain('applies `opt-a` in about 10h');
  });

  it('extends a window via timebox-extended', () => {
    const d = buildOperatorDigest(
      [
        opened('DEC-1', { timeboxExpiresAt: '2026-10-04T10:00:00.000Z' }),
        {
          eventVersion: 'v1',
          type: 'timebox-extended',
          ts: '2026-10-04T09:00:00.000Z',
          decisionId: 'DEC-1',
          newTimebox: 'P2D',
          newTimeboxExpiresAt: '2026-10-06T00:00:00.000Z',
          previousTimeboxExpiresAt: '2026-10-04T10:00:00.000Z',
        } as unknown as DecisionEvent,
      ],
      '2026-10-03T00:00:00.000Z',
      NOW,
    );
    expect(d.pending).toHaveLength(1);
  });

  it('renders empty sections', () => {
    const md = renderOperatorDigestMarkdown(buildOperatorDigest([], '2026-10-03T00:00:00Z', NOW));
    expect(md).toContain('## Decided (0)');
    expect(md).toContain('None.');
  });
});

describe('runOperatorDigest', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-digest-'));
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 's',
        options: [
          { id: 'opt-a', description: 'a' },
          { id: 'opt-b', description: 'b' },
        ],
      }),
      { workDir: dir },
    );
    appendDecisionEvent(
      makeOperatorAnsweredEvent({ decisionId: 'DEC-0001', chosenOptionId: 'opt-a' }),
      { workDir: dir },
    );
    return dir;
  };

  it('defaults to 24h, --since wins, an invalid --since errors', () => {
    const dir = setup();
    try {
      const now = new Date(Date.now() + 3 * 3_600_000);
      expect(runOperatorDigest({ workDir: dir, now }).answered).toHaveLength(1);
      const far = new Date(Date.now() + 72 * 3_600_000);
      expect(runOperatorDigest({ workDir: dir, now: far }).answered).toHaveLength(0);
      expect(
        runOperatorDigest({ workDir: dir, now: far, since: '2020-01-01T00:00:00Z' }).answered,
      ).toHaveLength(1);
      expect(() => runOperatorDigest({ workDir: dir, since: 'nope' })).toThrow(/ISO timestamp/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--mark records the cutoff, the next run uses it, and no --mark writes nothing', () => {
    const dir = setup();
    try {
      const marker = join(resolveDecisionsDir(dir), 'last-digest.json');
      const t1 = new Date(Date.now() + 1000);
      runOperatorDigest({ workDir: dir, now: t1 });
      expect(existsSync(marker)).toBe(false);
      runOperatorDigest({ workDir: dir, now: t1, mark: true });
      expect(JSON.parse(readFileSync(marker, 'utf8')).at).toBe(t1.toISOString());
      const next = runOperatorDigest({ workDir: dir, now: new Date(t1.getTime() + 1000) });
      expect(next.since).toBe(t1.toISOString());
      expect(next.answered).toHaveLength(0);
      writeFileSync(marker, 'not json');
      expect(runOperatorDigest({ workDir: dir, now: t1 }).answered).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the decisions directory when marking on an empty repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-digest-empty-'));
    try {
      runOperatorDigest({ workDir: dir, mark: true });
      expect(existsSync(join(resolveDecisionsDir(dir), 'last-digest.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildOperatorDigest edges', () => {
  it('skips answers without an opened event, ignores the exact cutoff, flags hard-to-reverse', () => {
    const d = buildOperatorDigest(
      [
        answered('DEC-9', '2026-10-04T12:00:00.000Z'),
        opened('DEC-1', { reversible: false }),
        answered('DEC-1', '2026-10-03T00:00:00.000Z'),
        opened('DEC-2', { reversible: false }),
        answered('DEC-2', '2026-10-04T00:00:00.000Z'),
        opened('DEC-3', { body: 'Class: a' }),
      ],
      '2026-10-03T00:00:00.000Z',
      NOW,
    );
    expect(d.answered.map((a) => a.decisionId)).toEqual(['DEC-2']);
    expect(d.answered[0]!.reverse).toContain('marked hard to reverse');
    expect(classifyDecision(opened('DEC-3', { body: 'Class: a' }) as never)).toBe('a');
  });

  it('says so when a pending decision has no fallback', () => {
    const md = renderOperatorDigestMarkdown(
      buildOperatorDigest(
        [opened('DEC-1', { timeboxExpiresAt: '2026-10-05T10:00:00.000Z' })],
        '2026-10-03T00:00:00.000Z',
        NOW,
      ),
    );
    expect(md).toContain('nothing (no fallback)');
  });
});

describe('digest flags and marker safety', () => {
  it('flags control-surface class (a) decisions and unrecognised authors, without blocking', () => {
    const d = buildOperatorDigest(
      [
        opened('DEC-1', { summary: 'Loosen the pre-push hook for executors' }),
        { ...answered('DEC-1', '2026-10-04T12:00:00.000Z'), by: 'some-executor' } as DecisionEvent,
      ],
      '2026-10-03T00:00:00.000Z',
      NOW,
    );
    expect(d.answered).toHaveLength(1);
    expect(d.answered[0]!.flags).toHaveLength(2);
    expect(renderOperatorDigestMarkdown(d)).toContain('FLAG: names a governance');
  });

  it('does not flag a planner-authored routine decision', () => {
    const d = buildOperatorDigest(
      [opened('DEC-1'), answered('DEC-1', '2026-10-04T12:00:00.000Z')],
      '2026-10-03T00:00:00.000Z',
      NOW,
    );
    expect(d.answered[0]!.flags).toEqual([]);
  });

  it('ignores a marker dated in the future', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-digest-future-'));
    try {
      mkdirSync(resolveDecisionsDir(dir), { recursive: true });
      writeFileSync(
        join(resolveDecisionsDir(dir), 'last-digest.json'),
        JSON.stringify({ at: '2999-01-01T00:00:00Z' }),
      );
      const now = new Date('2026-10-05T00:00:00Z');
      expect(runOperatorDigest({ workDir: dir, now }).since).toBe('2026-10-04T00:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('provenance and DEC-0053 flags', () => {
  const events = [
    opened('DEC-1', { summary: 'Plain choice', by: 'planner' }),
    { ...answered('DEC-1', '2026-10-04T12:00:00.000Z'), by: 'planner' } as DecisionEvent,
  ];
  const since = '2026-10-03T00:00:00.000Z';

  it('shows PR and merge commit next to the claimed author, and says --by is not authentication', () => {
    const md = renderOperatorDigestMarkdown(
      buildOperatorDigest(events, since, NOW, () => ({ commit: 'abcdef1234567890', pr: 1234 })),
    );
    expect(md).toContain('PR #1234, commit abcdef12, claimed author planner');
    expect(md).toContain('--by is not authentication');
  });

  it('flags a record that is not on main', () => {
    const d = buildOperatorDigest(events, since, NOW, () => null);
    expect(d.answered[0]!.flags).toContain('record is not on main, so it is not authority yet');
    expect(renderOperatorDigestMarkdown(d)).toContain('NOT on main');
  });

  it('flags an untagged control-surface decision whatever its Class line says', () => {
    const d = buildOperatorDigest(
      [
        opened('DEC-1', {
          summary: 'Relax the required checks ruleset',
          body: 'Class: (b)',
          by: 'planner',
        }),
        { ...answered('DEC-1', '2026-10-04T12:00:00.000Z'), by: 'planner' } as DecisionEvent,
      ],
      since,
      NOW,
    );
    expect(d.answered[0]!.flags.join(' ')).toContain('carries no --governance-change tag');
  });

  it('does not flag a tagged decision, and checks the opener of an auto-expired one', () => {
    const d = buildOperatorDigest(
      [
        opened('DEC-1', {
          summary: 'Relax a hook',
          by: 'some-executor',
          governanceChange: { kind: 'weakening', weakeningOptionIds: ['opt-a'] },
          timeboxExpiresAt: '2026-10-04T06:00:00.000Z',
        }),
        answered('DEC-1', '2026-10-04T06:00:01.000Z', 'auto-expired'),
      ],
      since,
      NOW,
    );
    expect(d.answered[0]!.flags).toEqual([
      'author "some-executor" is not a recognised planner or operator identity',
    ]);
  });

  it('does not accept a prefix-only author name', () => {
    const d = buildOperatorDigest(
      [
        opened('DEC-1', { by: 'planner-impersonator' }),
        {
          ...answered('DEC-1', '2026-10-04T12:00:00.000Z'),
          by: 'planner-impersonator',
        } as DecisionEvent,
      ],
      since,
      NOW,
    );
    expect(d.answered[0]!.flags.join(' ')).toContain('not a recognised');
  });
});

describe('gitProvenanceResolver', () => {
  it('returns null outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-digest-git-'));
    try {
      expect(gitProvenanceResolver(dir)('DEC-0001')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitProvenanceResolver in a real repo', () => {
  it('finds the oldest commit that added the id and parses the PR number', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'op-digest-repo-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 't');
      git('config', 'commit.gpgsign', 'false');
      const logDir = join(dir, '.ai-sdlc', '_decisions');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'events.jsonl'), '{"decisionId":"DEC-0001"}\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'docs: file a decision (#77)');
      writeFileSync(
        join(logDir, 'events.jsonl'),
        '{"decisionId":"DEC-0001"}\n{"decisionId":"DEC-0002"}\n',
      );
      git('commit', '-qam', 'docs: later');
      const found = gitProvenanceResolver(dir, 'HEAD')('DEC-0001');
      expect(found?.pr).toBe(77);
      expect(found?.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(gitProvenanceResolver(dir, 'HEAD')('DEC-0002')?.pr).toBeNull();
      expect(gitProvenanceResolver(dir, 'HEAD')('DEC-0009')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
