/**
 * cli-decisions router tests — drive the yargs program in-process and
 * assert on stdout/stderr.
 *
 * Pattern mirrors cli/capture.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDecisionsCli } from './decisions.js';
import { resolveEventLogPath } from '../decisions/event-log.js';
import type { Decision } from '../decisions/decision-record.js';

// ── Test infrastructure ───────────────────────────────────────────────────────

let tmp: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;
let savedFlag: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-decisions-'));
  savedArgv = process.argv;
  stdoutChunks = [];
  stderrChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  savedFlag = process.env.AI_SDLC_DECISION_CATALOG;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;

  process.env.AI_SDLC_DECISION_CATALOG = 'experimental';
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;

  if (savedFlag === undefined) delete process.env.AI_SDLC_DECISION_CATALOG;
  else process.env.AI_SDLC_DECISION_CATALOG = savedFlag;

  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'cli-decisions', '--work-dir', tmp, ...args];
}

function stdoutJson<T = unknown>(): T {
  const text = stdoutChunks.join('');
  const trimmed = text.trim();
  // Find the first JSON object/array boundary and parse the trailing payload.
  const idx = trimmed.search(/[{[]/);
  if (idx < 0) throw new Error(`no JSON found in stdout: ${text}`);
  return JSON.parse(trimmed.slice(idx)) as T;
}

function stdoutText(): string {
  return stdoutChunks.join('');
}

function stderrText(): string {
  return stderrChunks.join('');
}

// ── Feature flag (AC#6) ───────────────────────────────────────────────────────

describe('AC#6 — AI_SDLC_DECISION_CATALOG feature flag', () => {
  it('list degrades open with stderr notice when flag is unset', async () => {
    delete process.env.AI_SDLC_DECISION_CATALOG;
    setArgv('list', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ ok: boolean; enabled: boolean; decisions: unknown[] }>();
    expect(r.ok).toBe(true);
    expect(r.enabled).toBe(false);
    expect(r.decisions).toEqual([]);
    expect(stderrText()).toMatch(/AI_SDLC_DECISION_CATALOG/);
  });

  it('show degrades open with stderr notice when flag is unset', async () => {
    delete process.env.AI_SDLC_DECISION_CATALOG;
    setArgv('show', 'DEC-0001', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ ok: boolean; enabled: boolean; decision: null }>();
    expect(r.enabled).toBe(false);
    expect(r.decision).toBeNull();
  });

  it('add refuses to mutate when flag is unset', async () => {
    delete process.env.AI_SDLC_DECISION_CATALOG;
    setArgv('add', '--summary', 'x', '--scope', 'workspace', '--option', 'opt-a:Yes');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/refusing to mutate/);
  });
});

// ── add subcommand (AC#4) ────────────────────────────────────────────────────

describe('AC#4 — add subcommand (flag-driven path)', () => {
  it('writes a decision-opened event to the log and assigns DEC-0001', async () => {
    setArgv(
      'add',
      '--summary',
      'Pick a routing strategy',
      '--scope',
      'rfc:RFC-0035',
      '--source',
      'rfc-open-question',
      '--option',
      'opt-a:Keep existing',
      '--option',
      'opt-b:Switch to new',
      '--assigned-actor',
      'dominique@reliablegenius.io',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ ok: boolean; decisionId: string; decision: Decision }>();
    expect(r.ok).toBe(true);
    expect(r.decisionId).toBe('DEC-0001');
    expect(r.decision.spec.summary).toBe('Pick a routing strategy');
    expect(r.decision.spec.options).toHaveLength(2);
    expect(r.decision.status.routing?.assignedActor).toBe('dominique@reliablegenius.io');

    // AC#5 — verify event-log file landed at the documented path.
    const logPath = resolveEventLogPath(tmp);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const evt = JSON.parse(lines[0]);
    expect(evt.type).toBe('decision-opened');
    expect(evt.decisionId).toBe('DEC-0001');
  });

  it('allocates sequential ids across multiple invocations', async () => {
    setArgv(
      'add',
      '--summary',
      'first',
      '--scope',
      'workspace',
      '--option',
      'opt-a:A',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    expect(stdoutJson<{ decisionId: string }>().decisionId).toBe('DEC-0001');

    stdoutChunks = [];
    setArgv(
      'add',
      '--summary',
      'second',
      '--scope',
      'workspace',
      '--option',
      'opt-a:A',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    expect(stdoutJson<{ decisionId: string }>().decisionId).toBe('DEC-0002');
  });

  it('rejects --option without a colon separator', async () => {
    setArgv(
      'add',
      '--summary',
      'bad',
      '--scope',
      'workspace',
      '--option',
      'opt-a-no-colon',
      '--format',
      'json',
    );
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/--option must be 'id:description'/);
  });

  it('rejects an uppercase option id', async () => {
    setArgv(
      'add',
      '--summary',
      'bad',
      '--scope',
      'workspace',
      '--option',
      'OPT-A:Yes',
      '--format',
      'json',
    );
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/lowercase slug/);
  });

  it('refuses when --summary is omitted in flag mode', async () => {
    setArgv('add', '--scope', 'workspace', '--option', 'opt-a:A', '--format', 'json');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/--summary is required/);
  });
});

// ── list subcommand (AC#2) ───────────────────────────────────────────────────

describe('AC#2 — list subcommand', () => {
  it('returns empty when the catalog is empty', async () => {
    setArgv('list', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ decisions: unknown[] }>();
    expect(r.decisions).toEqual([]);
  });

  it('renders table format with the seeded decision', async () => {
    setArgv(
      'add',
      '--summary',
      'list-me',
      '--scope',
      'workspace',
      '--option',
      'opt-a:A',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];

    setArgv('list', '--format', 'table');
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/DEC-0001/);
    expect(out).toMatch(/list-me/);
    expect(out).toMatch(/open/);
  });

  it('lists every decision sorted by created asc (JSON mode)', async () => {
    for (let i = 1; i <= 3; i += 1) {
      stdoutChunks = [];
      setArgv(
        'add',
        '--summary',
        `decision ${i}`,
        '--scope',
        'workspace',
        '--option',
        'opt-a:A',
        '--format',
        'json',
      );
      await buildDecisionsCli().parseAsync();
    }
    stdoutChunks = [];
    setArgv('list', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ decisions: Decision[] }>();
    expect(r.decisions.map((d) => d.metadata.id)).toEqual(['DEC-0001', 'DEC-0002', 'DEC-0003']);
  });
});

// ── show subcommand (AC#3) ───────────────────────────────────────────────────

describe('AC#3 — show subcommand', () => {
  it('renders the decision + its event history in text mode', async () => {
    setArgv(
      'add',
      '--summary',
      'show me',
      '--scope',
      'workspace',
      '--option',
      'opt-a:Keep',
      '--option',
      'opt-b:Switch',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];

    setArgv('show', 'DEC-0001');
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/DEC-0001 — show me/);
    expect(out).toMatch(/lifecycle:\s+open/);
    expect(out).toMatch(/Options:/);
    expect(out).toMatch(/opt-a: Keep/);
    expect(out).toMatch(/opt-b: Switch/);
    expect(out).toMatch(/Event history \(1 event\)/);
    expect(out).toMatch(/decision-opened/);
  });

  it('exits 1 with not-found marker when id is unknown', async () => {
    setArgv('show', 'DEC-9999', '--format', 'json');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    const r = stdoutJson<{ ok: boolean; reason: string }>();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-found');
  });

  it('rejects malformed decision ids', async () => {
    setArgv('show', 'not-an-id');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/invalid decision id/);
  });
});

// ── log-path helper ──────────────────────────────────────────────────────────

describe('log-path subcommand', () => {
  it('prints the resolved event-log path even when nothing has been written', async () => {
    setArgv('log-path');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ ok: boolean; path: string; exists: boolean }>();
    expect(r.path).toBe(resolveEventLogPath(tmp));
    expect(r.exists).toBe(false);
  });
});

// ── score-a subcommand (AC#1, AC#2, AC#3, AC#4) ──────────────────────────────

describe('score-a subcommand (Phase 2 AC#1 AC#2 AC#3 AC#4)', () => {
  async function seedAndScore(
    summary: string,
    extra: string[] = [],
  ): Promise<Record<string, unknown>> {
    setArgv(
      'add',
      '--summary',
      summary,
      '--scope',
      'workspace',
      '--option',
      'opt-a:A',
      '--option',
      'opt-b:B',
      '--reversible',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    const addResult = stdoutJson<{ decisionId: string }>();
    const id = addResult.decisionId;

    stdoutChunks = [];
    setArgv('score-a', id, '--format', 'json', ...extra);
    await buildDecisionsCli().parseAsync();
    return stdoutJson<Record<string, unknown>>();
  }

  it('returns a Stage A result with all required fields', async () => {
    const r = await seedAndScore('choose a deployment strategy');
    expect(r.ok).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.stageA).toBeTruthy();
    const stageA = r.stageA as Record<string, unknown>;
    expect(typeof stageA.prioritySignal).toBe('number');
    expect(typeof stageA.resolvedByStageA).toBe('boolean');
    expect(stageA.schemaValidity).toBeTruthy();
    expect(stageA.blastRadius).toBeTruthy();
    expect(stageA.reversibility).toBeTruthy();
    expect(stageA.duplicateDetection).toBeTruthy();
  });

  it('stores the result when --store is passed (AC#4)', async () => {
    const r = await seedAndScore('a reversible decision to store', ['--store']);
    expect(r.stored).toBe(true);

    // The decision should now have stageA in its evaluation
    stdoutChunks = [];
    const id = r.decisionId as string;
    setArgv('show', id, '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const showResult = stdoutJson<{
      decision: { status: { evaluation: Record<string, unknown> } };
    }>();
    expect(showResult.decision.status.evaluation?.stageA).toBeTruthy();
  });

  it('degrades open when flag is unset', async () => {
    delete process.env.AI_SDLC_DECISION_CATALOG;
    setArgv('score-a', 'DEC-0001', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ enabled: boolean }>();
    expect(r.enabled).toBe(false);
  });

  it('fails for unknown decision id', async () => {
    setArgv('score-a', 'DEC-9999', '--format', 'json');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
  });

  it('rejects malformed decision ids', async () => {
    setArgv('score-a', 'not-an-id', '--format', 'json');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/invalid decision id/);
  });
});

// ── coverage subcommand (AC#6) ────────────────────────────────────────────────

describe('coverage subcommand (Phase 2 AC#6)', () => {
  it('returns coverage=0 for an empty catalog', async () => {
    setArgv('coverage', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{
      ok: boolean;
      coverage: { totalDecisions: number; coverageRate: number };
      target: number;
    }>();
    expect(r.ok).toBe(true);
    expect(r.coverage.totalDecisions).toBe(0);
    expect(r.coverage.coverageRate).toBe(0);
    expect(r.target).toBe(0.4);
  });

  it('reports non-zero coverage when reversible decisions exist', async () => {
    // Seed one reversible decision
    setArgv(
      'add',
      '--summary',
      'reversible-decision',
      '--scope',
      'workspace',
      '--option',
      'opt-a:A',
      '--reversible',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();

    stdoutChunks = [];
    setArgv('coverage', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{
      coverage: {
        totalDecisions: number;
        resolvedByStageA: number;
        coverageRate: number;
        meetsTarget: boolean;
      };
    }>();
    expect(r.coverage.totalDecisions).toBe(1);
    // Reversible + valid schema + no broken refs + no dups → resolvedByStageA=true
    expect(r.coverage.resolvedByStageA).toBe(1);
    expect(r.coverage.coverageRate).toBe(1);
    expect(r.coverage.meetsTarget).toBe(true);
  });

  it('degrades open when flag is unset', async () => {
    delete process.env.AI_SDLC_DECISION_CATALOG;
    setArgv('coverage', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ enabled: boolean }>();
    expect(r.enabled).toBe(false);
  });

  it('prints text output by default', async () => {
    setArgv('coverage');
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/Stage A coverage/);
    expect(out).toMatch(/target/);
  });
});
