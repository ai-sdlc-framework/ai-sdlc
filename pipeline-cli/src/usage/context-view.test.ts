/**
 * `cli-usage context`: turns since clear, budget status and the largest
 * single-turn context growths with the tool that produced each (AISDLC-651.4).
 * Everything lives in a temp directory; no real ledger or transcript is read.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendModelCalls, type ModelCallRecord } from '@ai-sdlc/reference';
import { buildUsageCli } from '../cli/usage.js';
import { buildContextView, renderContextText } from './report.js';
import { inspectTranscript } from './transcript-inspect.js';
import { defaultUsageConfig, parseUsageConfig, roleFromSessionName } from './usage-config.js';

const T0 = Date.parse('2026-09-10T00:00:00Z');
const MIN = 60_000;

let root: string;
let transcript: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'context-view-'));
  transcript = join(root, 'session.jsonl');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function call(
  i: number,
  over: Partial<ModelCallRecord> & { write?: number; read?: number } = {},
): ModelCallRecord {
  const { write, read, ...rest } = over;
  return {
    schemaVersion: 'v1',
    callId: `msg-${i}`,
    ts: new Date(T0 + i * MIN).toISOString(),
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'model-sonnet-a',
    tokens: {
      input: 10,
      cacheWrite5m: write ?? 100,
      cacheWrite1h: 0,
      cacheRead: read ?? 1000,
      output: 20,
    },
    billingPool: 'subscription-interactive',
    sessionId: 'sess-1',
    agentRole: 'main-session',
    scope: 'framework',
    source: { file: transcript, offset: 0 },
    ...rest,
  };
}

/** Writes the transcript: a title, tool calls per message id, and a clear after call `clearAfter`. */
function writeTranscript(opts: {
  tools: Record<string, string[]>;
  clearAfter?: number;
  title?: string;
}) {
  const lines: string[] = [];
  if (opts.title) lines.push(JSON.stringify({ type: 'custom-title', customTitle: opts.title }));
  for (const [id, names] of Object.entries(opts.tools)) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          id,
          content: [
            { type: 'text', text: 'ignored' },
            ...names.map((name) => ({ type: 'tool_use', name, input: {} })),
          ],
        },
      }),
    );
  }
  if (opts.clearAfter !== undefined) {
    lines.push(
      JSON.stringify({
        type: 'attachment',
        timestamp: new Date(T0 + opts.clearAfter * MIN + 30_000).toISOString(),
        attachment: {
          type: 'hook_success',
          hookName: 'SessionStart:clear',
          hookEvent: 'SessionStart',
        },
      }),
    );
  }
  lines.push('not json at all "tool_use"', '');
  writeFileSync(transcript, lines.join('\n'));
}

const roles = defaultUsageConfig().roles;

describe('buildContextView', () => {
  it('counts turns since the last clear, not since session start', () => {
    writeTranscript({ tools: {}, clearAfter: 5, title: 'planner' });
    const records = Array.from({ length: 9 }, (_, i) => call(i));
    const [row] = buildContextView(records, { roles, inspect: inspectTranscript });
    expect(row.turns).toBe(9);
    expect(row.turnsSinceClear).toBe(3);
    expect(row.role).toBe('planner');
    expect(row.overBudget).toBe(false);
  });

  it('flags a session over its role context budget, and over its turn budget', () => {
    writeTranscript({ tools: {}, title: 'executor-aisdlc-1' });
    const big = [call(0), call(1, { read: 130_000 })];
    expect(buildContextView(big, { roles, inspect: inspectTranscript })[0].overBudget).toBe(true);
    const tight = { ...roles, executor: { contextBudgetTokens: 10 ** 9, turnBudget: 1 } };
    expect(
      buildContextView([call(0), call(1)], { roles: tight, inspect: inspectTranscript })[0]
        .overBudget,
    ).toBe(true);
  });

  it('reports overBudget null when the role is unknown, and honours a default role', () => {
    writeTranscript({ tools: {} });
    const records = [call(0, { read: 500_000 })];
    expect(
      buildContextView(records, { roles, inspect: inspectTranscript })[0].overBudget,
    ).toBeNull();
    const row = buildContextView(records, {
      roles,
      defaultRole: 'planner',
      inspect: inspectTranscript,
    })[0];
    expect(row.role).toBe('planner');
    expect(row.overBudget).toBe(true);
  });

  it('never assigns a role to a subagent', () => {
    writeTranscript({ tools: {}, title: 'planner' });
    const row = buildContextView([call(0, { agentId: 'a1' })], {
      roles,
      defaultRole: 'planner',
      inspect: inspectTranscript,
    })[0];
    expect(row.role).toBeUndefined();
    expect(row.overBudget).toBeNull();
  });

  it('lists the ten largest growths with the tool of the preceding call', () => {
    const tools: Record<string, string[]> = {};
    const records: ModelCallRecord[] = [];
    for (let i = 0; i < 14; i++) {
      tools[`msg-${i}`] = i % 2 === 0 ? ['Read'] : i === 5 ? [] : ['Bash', 'Grep'];
      records.push(call(i, { write: (i + 1) * 100 }));
    }
    writeTranscript({ tools });
    const [row] = buildContextView(records, { roles, inspect: inspectTranscript });
    expect(row.topGrowths).toHaveLength(10);
    expect(row.topGrowths.map((g) => g.tokens)).toEqual([
      1400, 1300, 1200, 1100, 1000, 900, 800, 700, 600, 500,
    ]);
    // msg-13 grew after msg-12 (Read); msg-12 after msg-11 (Bash,Grep); msg-5 had no tool.
    expect(row.topGrowths[0].tool).toBe('Read');
    expect(row.topGrowths[1].tool).toBe('Bash,Grep');
    expect(row.topGrowths.find((g) => g.callId === 'msg-6')?.tool).toBe('(no tool)');
  });

  it('marks the first call as the session start and an unreadable transcript as unknown', () => {
    writeTranscript({ tools: {} });
    const first = buildContextView([call(0, { write: 9999 })], {
      roles,
      inspect: inspectTranscript,
    });
    expect(first[0].topGrowths[0].tool).toBe('(session start)');
    const gone = { file: join(root, 'gone.jsonl'), offset: 0 };
    const missing = buildContextView(
      [call(0, { source: gone }), call(1, { write: 5000, source: gone })],
      { roles, inspect: inspectTranscript },
    );
    expect(missing[0].topGrowths[0].tool).toBe('-');
    expect(missing[0].turnsSinceClear).toBe(2);
  });

  it('skips calls that wrote nothing to the cache and works without an inspector', () => {
    const [row] = buildContextView([call(0, { write: 0 }), call(1, { write: 0 })]);
    expect(row.topGrowths).toEqual([]);
    expect(row.overBudget).toBeNull();
    expect(row.turnsSinceClear).toBe(2);
  });

  it('renders turnsSinceClear, overBudget and the growth list as text', () => {
    writeTranscript({ tools: { 'msg-0': ['Read'] }, title: 'planner' });
    const text = renderContextText(
      buildContextView([call(0), call(1, { write: 777 })], { roles, inspect: inspectTranscript }),
    );
    expect(text).toContain('turnsSinceClear');
    expect(text).toContain('overBudget');
    expect(text).toContain('+777 tokens  Read');
  });
});

describe('inspectTranscript', () => {
  it('returns empty, unreadable facts for a missing file', () => {
    const facts = inspectTranscript(join(root, 'nope.jsonl'), new Set(['x']));
    expect(facts).toEqual({ readable: false, clearTimes: [], toolsByCallId: new Map() });
  });

  it('keeps only safe tool names and an agent-name title', () => {
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'agent-name', agentName: 'planner' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'm1',
            content: [
              { type: 'tool_use', name: 'Read' },
              { type: 'tool_use', name: 'Read' },
              { type: 'tool_use', name: 'bad name\nwith newline' },
              { type: 'tool_use', name: 7 },
            ],
          },
        }),
        JSON.stringify({
          type: 'attachment',
          timestamp: 'garbage',
          attachment: { hookName: 'SessionStart:clear' },
        }),
      ].join('\n'),
    );
    const facts = inspectTranscript(transcript, new Set(['m1']));
    expect(facts.sessionName).toBe('planner');
    expect(facts.toolsByCallId.get('m1')).toEqual(['Read']);
    expect(facts.clearTimes).toEqual([]);
  });
});

describe('roles in the usage config', () => {
  it('defaults to the documented budgets and does not share state', () => {
    const c = defaultUsageConfig();
    expect(c.roles).toEqual({
      planner: { contextBudgetTokens: 150_000, turnBudget: 300 },
      'operator-dispatch': { contextBudgetTokens: 100_000, turnBudget: 200 },
      executor: { contextBudgetTokens: 120_000, turnBudget: 150 },
    });
    c.roles.planner.turnBudget = 1;
    expect(defaultUsageConfig().roles.planner.turnBudget).toBe(300);
  });

  it('reads configured budgets and keeps the default for an unset one', () => {
    const c = parseUsageConfig(
      'apiVersion: ai-sdlc.io/v1alpha1\nkind: UsageConfig\nspec:\n  roles:\n    planner:\n      contextBudgetTokens: 90000\n    executor:\n      turnBudget: 40\n',
      'machine',
    );
    if (typeof c === 'string') throw new Error(c);
    expect(c.roles.planner).toEqual({ contextBudgetTokens: 90_000, turnBudget: 300 });
    expect(c.roles.executor).toEqual({ contextBudgetTokens: 120_000, turnBudget: 40 });
    expect(c.roles['operator-dispatch'].turnBudget).toBe(200);
  });

  it('rejects an unknown role or a non-positive budget', () => {
    const bad = (roles: string) =>
      parseUsageConfig(
        `apiVersion: ai-sdlc.io/v1alpha1\nkind: UsageConfig\nspec:\n  roles:\n${roles}`,
        'machine',
      );
    expect(bad('    reviewer:\n      turnBudget: 5\n')).toEqual(expect.any(String));
    expect(bad('    planner:\n      turnBudget: 0\n')).toEqual(expect.any(String));
  });

  it('resolves a role from a session name', () => {
    expect(roleFromSessionName('planner')).toBe('planner');
    expect(roleFromSessionName('Executor-aisdlc-9')).toBe('executor');
    expect(roleFromSessionName('operator-dispatch')).toBe('operator-dispatch');
    expect(roleFromSessionName('planners')).toBeUndefined();
    expect(roleFromSessionName(undefined)).toBeUndefined();
  });
});

describe('cli-usage context', () => {
  it('prints turnsSinceClear, overBudget and the ten largest growths for a fixture ledger', async () => {
    const tools: Record<string, string[]> = {};
    const records: ModelCallRecord[] = [];
    for (let i = 0; i < 12; i++) {
      tools[`msg-${i}`] = ['WebFetch'];
      records.push(call(i, { write: 100 + i * 10 }));
    }
    writeTranscript({ tools, clearAfter: 3, title: 'planner' });
    const usageDir = join(root, 'usage');
    appendModelCalls(records, { dir: usageDir });
    const out: string[] = [];
    const run = async (...args: string[]) => {
      out.length = 0;
      await buildUsageCli(['context', ...args], {
        usageDir,
        stdout: (t) => void out.push(t),
        stderr: () => {},
        readBaseConfig: () => null,
      }).parseAsync();
      return out.join('');
    };

    const rows = JSON.parse(await run('--format', 'json'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      turns: 12,
      turnsSinceClear: 8,
      overBudget: false,
      role: 'planner',
    });
    expect(rows[0].topGrowths).toHaveLength(10);
    expect(rows[0].topGrowths[0]).toMatchObject({ tokens: 210, tool: 'WebFetch' });

    const text = await run();
    expect(text).toContain('turnsSinceClear');
    expect(text).toContain('Largest single-turn context growths');
    expect(text).toContain('+210 tokens  WebFetch');
  });
});
