import { describe, expect, it } from 'vitest';
import {
  buildReport,
  parseTranscript,
  projectLabel,
  renderAudit,
  renderDigest,
  runAudit,
  priceFor,
} from './audit.js';
import { buildUsageCli } from '../cli/usage.js';

const TS = '2026-10-09T10:00:00Z';
const user = (text: string): string =>
  JSON.stringify({ type: 'user', message: { content: text }, timestamp: TS });
const asst = (opts: {
  model?: string;
  noop?: boolean;
  input?: number;
  cr?: number;
  out?: number;
  ts?: string;
}): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: opts.ts ?? TS,
    message: {
      model: opts.model ?? 'claude-sonnet-5',
      usage: {
        input_tokens: opts.input ?? 100,
        cache_read_input_tokens: opts.cr ?? 0,
        cache_creation_input_tokens: 0,
        output_tokens: opts.out ?? 10,
      },
      content: opts.noop
        ? [{ type: 'tool_use', name: 'ScheduleWakeup', input: { noop: true } }]
        : [{ type: 'text', text: 'x' }],
    },
  });

const base = { project: 'ai-sdlc', file: '/p/s.jsonl', isSubagent: false, sinceMs: 0 };

describe('parseTranscript', () => {
  it('tolerates blank and malformed lines', () => {
    const r = parseTranscript(['', 'not json', user('hi'), asst({})], base);
    expect(r.turns).toHaveLength(1);
  });

  it('flags a noop wakeup turn as idle and attributes the loop body', () => {
    const lines = [
      user('<command-name>/ai-sdlc:orchestrator-tick</command-name>'),
      asst({ noop: true, cr: 1_000_000 }),
      user('real work'),
      asst({}),
      asst({}),
    ];
    const r = parseTranscript(lines, base);
    expect(r.turns).toHaveLength(2);
    expect(r.turns[0]).toMatchObject({ loop: 'orchestrator-tick', idle: true, role: 'main' });
    expect(r.turns[1].idle).toBe(false);
    expect(r.turns[1].calls).toBe(2);
  });

  it('does not treat a long turn ending in noop as idle', () => {
    const lines = [user('go'), asst({}), asst({}), asst({}), asst({}), asst({ noop: true })];
    expect(parseTranscript(lines, base).turns[0].idle).toBe(false);
  });

  it('does not split a turn on tool results', () => {
    const lines = [user('go'), asst({}), user('[{"type":"tool_result"}]'), asst({})];
    expect(parseTranscript(lines, base).turns).toHaveLength(1);
  });

  it('labels subagent turns by agentType', () => {
    const lines = [JSON.stringify({ agentType: 'developer' }), user('go'), asst({})];
    const r = parseTranscript(lines, { ...base, isSubagent: true });
    expect(r.turns[0]).toMatchObject({ role: 'developer', loop: '(subagent)' });
  });

  it('skips calls before the window and picks the dominant model', () => {
    const lines = [
      user('go'),
      asst({ ts: '2020-01-01T00:00:00Z' }),
      asst({ model: 'claude-opus-5' }),
      asst({ model: 'claude-opus-5' }),
      asst({ model: 'claude-haiku-5' }),
    ];
    const r = parseTranscript(lines, { ...base, sinceMs: Date.parse('2026-01-01') });
    expect(r.turns[0].model).toBe('claude-opus-5');
    expect(r.turns[0].calls).toBe(3);
  });

  it('records peak context and clears', () => {
    const r = parseTranscript([user('go'), asst({ cr: 300_000 }), asst({ cr: 100 })], base);
    expect(r.session.maxContext).toBe(300_100);
    expect(r.session.hadClear).toBe(false);
    const c = parseTranscript(
      [user('<command-name>/clear</command-name>'), asst({ cr: 300_000 })],
      base,
    );
    expect(c.session.hadClear).toBe(true);
  });

  it('prices by model family', () => {
    expect(priceFor('claude-opus-5').out).toBe(75);
    expect(priceFor('claude-haiku-5').out).toBe(5);
    expect(priceFor('claude-sonnet-5').out).toBe(15);
  });
});

describe('report', () => {
  const parsed = [
    parseTranscript(
      [
        user('<command-name>/loop</command-name>'),
        asst({ noop: true, cr: 500_000, model: 'claude-opus-5' }),
        user('x'),
        asst({ cr: 100_000 }),
      ],
      base,
    ),
    parseTranscript([user('y'), asst({ cr: 250_000 })], {
      ...base,
      project: 'other',
      file: '/p/o.jsonl',
    }),
  ];
  const report = buildReport(parsed, 7);

  it('groups by project, loop, role and model', () => {
    expect(report.groups.project.map((r) => r.key).sort()).toEqual(['ai-sdlc', 'other']);
    expect(report.groups.loop.map((r) => r.key)).toContain('loop');
    expect(report.groups.role[0].key).toBe('main');
    expect(report.groups.model.map((r) => r.key)).toContain('claude-opus-5');
    expect(report.idleTurns).toBe(1);
    expect(report.idleCost).toBeGreaterThan(0);
  });

  it('flags large no-clear sessions', () => {
    expect(report.bigContextSessions.map((s) => s.project)).toEqual(['ai-sdlc', 'other']);
  });

  it('renders audit and paste-ready digest', () => {
    const audit = renderAudit(report);
    expect(audit).toContain('By project');
    expect(audit).toContain('By model');
    expect(audit).toContain('no clear');
    const digest = renderDigest(report);
    expect(digest).toContain('Weekly usage digest');
    expect(digest).toContain('Worst idle loops');
    expect(digest).not.toMatch(/[|#*`]/);
    expect(renderDigest(buildReport([], 7))).toContain('No idle polling loops found.');
  });

  it('projectLabel strips the home prefix', () => {
    expect(projectLabel('-Users-bob-Documents-dev-foo')).toBe('foo');
  });
});

describe('runAudit and the cli', () => {
  const deps = {
    projectsDir: '/p',
    now: () => new Date('2026-10-10T00:00:00Z'),
    listTranscripts: () => [
      { path: '/p/a/s.jsonl', project: 'a', isSubagent: false },
      { path: '/p/a/bad.jsonl', project: 'a', isSubagent: false },
    ],
    readTranscript: (p: string): string => {
      if (p.endsWith('bad.jsonl')) throw new Error('nope');
      return [user('go'), asst({ noop: true })].join('\n');
    },
  };

  it('skips unreadable transcripts', () => {
    expect(runAudit(7, 200_000, deps).turns).toBe(1);
  });

  it('drives `audit` through cli-usage', async () => {
    for (const flag of [[], ['--digest'], ['--json']]) {
      let out = '';
      await buildUsageCli(['audit', '--days', '7', ...flag], {
        audit: deps,
        now: deps.now,
        stdout: (t) => (out += t),
      }).parseAsync();
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
