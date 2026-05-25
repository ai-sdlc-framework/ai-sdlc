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
  it('list degrades open with stderr notice when flag is opt-out (off)', async () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off'; // AISDLC-392 default-on; opt-out explicit
    setArgv('list', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ ok: boolean; enabled: boolean; decisions: unknown[] }>();
    expect(r.ok).toBe(true);
    expect(r.enabled).toBe(false);
    expect(r.decisions).toEqual([]);
    expect(stderrText()).toMatch(/AI_SDLC_DECISION_CATALOG/);
  });

  it('show degrades open with stderr notice when flag is opt-out (off)', async () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off'; // AISDLC-392 default-on; opt-out explicit
    setArgv('show', 'DEC-0001', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ ok: boolean; enabled: boolean; decision: null }>();
    expect(r.enabled).toBe(false);
    expect(r.decision).toBeNull();
  });

  it('add refuses to mutate when flag is opt-out (off)', async () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off'; // AISDLC-392 default-on; opt-out explicit
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

  it('degrades open when flag is opt-out (off)', async () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off'; // AISDLC-392 default-on; opt-out explicit
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

  it('degrades open when flag is opt-out (off)', async () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off'; // AISDLC-392 default-on; opt-out explicit
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

// ── RFC-0035 Phase 5 / AISDLC-289 — score-c, answer, override, corpus subcommands

describe('score-c subcommand (RFC-0035 Phase 5 / AISDLC-289)', () => {
  beforeEach(async () => {
    // Seed one decision for every test in this block.
    setArgv(
      'add',
      '--summary',
      'mid-band decision',
      '--scope',
      'workspace',
      '--option',
      'opt-a:Option A',
      '--option',
      'opt-b:Option B',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];
  });

  it('without an invoker, falls open + reports llm-answer-eligible: false', async () => {
    // The CLI doesn't wire a production invoker — the fall-open path
    // means stdoutJson reports `metBehindThreshold: false` and the
    // event is NOT auto-applied even with --auto-apply.
    setArgv('score-c', 'DEC-0001', '--force', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ fired: boolean; stageC: { llmAnswerEligible: boolean } }>();
    expect(r.fired).toBe(true);
    expect(r.stageC.llmAnswerEligible).toBe(false);
  });

  it('refuses an invalid decision id', async () => {
    setArgv('score-c', 'NOT-A-DECISION', '--format', 'json');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/invalid decision id/);
  });

  it('refuses a decision id that is not in the log', async () => {
    setArgv('score-c', 'DEC-9999', '--force', '--format', 'json');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/decision not found/);
  });

  it('degrades open when the feature flag is off', async () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off';
    setArgv('score-c', 'DEC-0001', '--force', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ enabled: boolean; stageC: null }>();
    expect(r.enabled).toBe(false);
    expect(r.stageC).toBeNull();
  });

  it('skips when Stage B is high-band (without --force)', async () => {
    // The decision Stage A produces a low blast-radius reversible → Stage B
    // composite is low (low-band). We don't get high-band without crafting
    // the decision differently; test the low-band skip path here as a
    // proxy for "mid-band guard works".
    setArgv('score-c', 'DEC-0001', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{
      fired: boolean;
      skipReason?: string;
      stageBCompositeScore: number;
    }>();
    expect(r.fired).toBe(false);
    expect(r.skipReason).toMatch(/stage-b-/);
  });

  it('--store persists the stage-c-completed event even on fall-open', async () => {
    setArgv('score-c', 'DEC-0001', '--force', '--store', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const logPath = resolveEventLogPath(tmp);
    const raw = readFileSync(logPath, 'utf8');
    expect(raw).toMatch(/"type":"stage-c-completed"/);
    // Fall-open path does NOT also emit operator-answered (because
    // isStageCAutoApplyEligible returned false).
    expect(raw).not.toMatch(/"by":"framework"/);
  });

  it('prints text output by default', async () => {
    setArgv('score-c', 'DEC-0001', '--force');
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/Stage C result/);
    expect(out).toMatch(/recommendation:/);
  });
});

describe('answer subcommand (RFC-0035 Phase 5 / AISDLC-289)', () => {
  beforeEach(async () => {
    setArgv(
      'add',
      '--summary',
      'to be answered',
      '--scope',
      'workspace',
      '--option',
      'opt-a:Option A',
      '--option',
      'opt-b:Option B',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];
  });

  it('resolves the decision when given a valid option id', async () => {
    setArgv('answer', 'DEC-0001', 'opt-b', '--by', 'op@test', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ ok: boolean; chosenOptionId: string }>();
    expect(r.ok).toBe(true);
    expect(r.chosenOptionId).toBe('opt-b');
  });

  it('refuses an option id that is not declared on the decision', async () => {
    setArgv('answer', 'DEC-0001', 'opt-zzz', '--format', 'json');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/not declared/);
  });

  it('refuses an unknown decision id', async () => {
    setArgv('answer', 'DEC-9999', 'opt-a', '--format', 'json');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
  });

  it('refuses to mutate when the feature flag is opt-out', async () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off';
    setArgv('answer', 'DEC-0001', 'opt-a', '--format', 'json');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/refusing to mutate/);
  });
});

describe('override subcommand (RFC-0035 Phase 5 / AISDLC-289)', () => {
  beforeEach(async () => {
    setArgv(
      'add',
      '--summary',
      'auto-applied decision',
      '--scope',
      'workspace',
      '--option',
      'opt-a:Option A',
      '--option',
      'opt-b:Option B',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];
  });

  it('refuses when no auto-applied stage-c-completed event exists', async () => {
    setArgv('override', 'DEC-0001', 'opt-b', '--format', 'json');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/no auto-applied/);
  });

  it('refuses an unknown option id', async () => {
    setArgv('override', 'DEC-0001', 'opt-zzz', '--format', 'json');
    await expect(buildDecisionsCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/not declared/);
  });
});

describe('corpus aggregate subcommand (RFC-0035 Phase 5 / AISDLC-289)', () => {
  it('returns empty metrics when the corpus is empty', async () => {
    setArgv('corpus', 'aggregate', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{
      perTaskType: Array<{ taskType: string; total: number }>;
      aggregate: { total: number };
      anchorCandidates: unknown[];
    }>();
    expect(r.perTaskType.length).toBe(5);
    expect(r.aggregate.total).toBe(0);
    expect(r.anchorCandidates).toEqual([]);
  });

  it('text mode prints the per-task-type table', async () => {
    setArgv('corpus', 'aggregate');
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/Substrate calibration corpus aggregate/);
    expect(out).toMatch(/decision-recommendation/);
    expect(out).toMatch(/anchor candidates/);
  });

  it('honours --anchor-threshold override', async () => {
    setArgv('corpus', 'aggregate', '--anchor-threshold', '5', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ anchorPromotionThreshold: number }>();
    expect(r.anchorPromotionThreshold).toBe(5);
  });
});

// ── RFC-0035 Phase 9 — exemplars subcommand (AISDLC-293) ────────────────────

describe('exemplars subcommand (RFC-0035 Phase 9 / AISDLC-293)', () => {
  // Helpers to seed substrate corpus + decision events so the exemplars CLI
  // has data to operate on. Keep these inline (small, single-use) rather than
  // pulling them into the test-utils since the surface is one-off.
  async function seedSubstrateNegative(id: string): Promise<void> {
    const { appendCorpusEntry } = await import('../classifier/substrate/index.js');
    appendCorpusEntry(tmp, {
      id,
      timestamp: '2026-05-15T10:00:00Z',
      taskType: 'decision-recommendation',
      input: { text: 'pick an option' },
      model: 'claude-haiku-4-5',
      classification: 'opt-a',
      confidence: 0.82,
      reasoning: 'r',
      threshold: 0.7,
      metBehindThreshold: true,
      polarity: 'negative',
      operatorOverrideClassification: 'opt-b',
      operatorOverrideReason: 'B is better',
      operatorOverrideTimestamp: '2026-05-15T12:00:00Z',
    });
  }

  it('exemplars list returns empty when nothing is mirrored', async () => {
    setArgv('exemplars', 'list', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ exemplars: unknown[] }>();
    expect(r.exemplars).toEqual([]);
  });

  it('exemplars sweep mirrors negatives by default', async () => {
    await seedSubstrateNegative('neg-cli-1');
    setArgv('exemplars', 'sweep', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ mirroredCount: number; mode: string }>();
    expect(r.mirroredCount).toBe(1);
    expect(r.mode).toBe('negatives-only');
  });

  it('exemplars list shows mirrored entries; affirm + promote lands them in decision-exemplars.yaml', async () => {
    await seedSubstrateNegative('neg-cli-2');
    setArgv('exemplars', 'sweep', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];

    setArgv('exemplars', 'list', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const listed = stdoutJson<{
      exemplars: Array<{ id: string; classification: string; disposition: string }>;
    }>();
    expect(listed.exemplars).toHaveLength(1);
    const exId = listed.exemplars[0].id;
    expect(listed.exemplars[0].disposition).toBe('pending');
    stdoutChunks = [];

    setArgv('exemplars', 'affirm', exId);
    await buildDecisionsCli().parseAsync();
    const affirmed = stdoutJson<{ disposition: string; promoted: boolean }>();
    expect(affirmed.disposition).toBe('affirmed');
    expect(affirmed.promoted).toBe(true);
    stdoutChunks = [];

    setArgv('exemplars', 'paths');
    await buildDecisionsCli().parseAsync();
    const paths = stdoutJson<{
      pendingExemplarsPath: string;
      decisionExemplarsPath: string;
      pendingCount: number;
      decisionExemplarsCount: number;
    }>();
    expect(paths.pendingCount).toBe(1);
    expect(paths.decisionExemplarsCount).toBe(1);

    // The promoted file exists on disk.
    const text = readFileSync(paths.decisionExemplarsPath, 'utf8');
    expect(text).toContain('promotedFromCorpusEntryId: neg-cli-2');
  });

  it('reclassify requires --classification and stores it', async () => {
    await seedSubstrateNegative('neg-cli-3');
    setArgv('exemplars', 'sweep');
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];

    setArgv('exemplars', 'list', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const exId = stdoutJson<{ exemplars: Array<{ id: string }> }>().exemplars[0].id;
    stdoutChunks = [];

    setArgv(
      'exemplars',
      'reclassify',
      exId,
      '--classification',
      'opt-c',
      '--rationale',
      'finally settled',
    );
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ disposition: string; promoted: boolean }>();
    expect(r.disposition).toBe('reclassified');
    expect(r.promoted).toBe(true);
  });

  it('reject sets disposition without promoting', async () => {
    await seedSubstrateNegative('neg-cli-4');
    setArgv('exemplars', 'sweep');
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];

    setArgv('exemplars', 'list', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const exId = stdoutJson<{ exemplars: Array<{ id: string }> }>().exemplars[0].id;
    stdoutChunks = [];

    setArgv('exemplars', 'reject', exId, '--rationale', 'duplicate of DEC-0002');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{ disposition: string }>();
    expect(r.disposition).toBe('rejected');
    stdoutChunks = [];

    setArgv('exemplars', 'paths');
    await buildDecisionsCli().parseAsync();
    const paths = stdoutJson<{ pendingCount: number; decisionExemplarsCount: number }>();
    expect(paths.pendingCount).toBe(1);
    expect(paths.decisionExemplarsCount).toBe(0);
  });

  it('digest emits markdown with CLI hints; JSON form is parseable', async () => {
    await seedSubstrateNegative('neg-cli-5');
    setArgv('exemplars', 'sweep');
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];

    setArgv('exemplars', 'digest');
    await buildDecisionsCli().parseAsync();
    const md = stdoutText();
    expect(md).toContain('# Decision calibration weekly digest');
    expect(md).toContain('exemplars affirm');
    stdoutChunks = [];

    setArgv('exemplars', 'digest', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const j = stdoutJson<{ digest: { windowDays: number } }>();
    expect(j.digest.windowDays).toBe(7);
  });

  it('list filters by disposition', async () => {
    await seedSubstrateNegative('neg-cli-6a');
    await seedSubstrateNegative('neg-cli-6b');
    setArgv('exemplars', 'sweep');
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];

    setArgv('exemplars', 'list', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const before = stdoutJson<{ exemplars: Array<{ id: string }> }>();
    expect(before.exemplars).toHaveLength(2);
    const firstId = before.exemplars[0].id;
    stdoutChunks = [];

    setArgv('exemplars', 'affirm', firstId, '--defer-promote');
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];

    setArgv('exemplars', 'list', '--disposition', 'affirmed', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const affirmedList = stdoutJson<{ exemplars: Array<{ disposition: string }> }>();
    expect(affirmedList.exemplars).toHaveLength(1);
    expect(affirmedList.exemplars[0].disposition).toBe('affirmed');
  });
});

// ── show subcommand: RFC-0035 Phase 6 / AISDLC-290 — decision support surface
//    AC#1: per-decision rendering (problem, options, recommendation, confidence,
//          counter-arguments)
//    AC#2: sub-decision graph rendered as Mermaid-style text tree
//    AC#3: integrates with `cli-decisions show <id>` (this block exercises
//          that integration end-to-end)
//    AC#4: Stage A/B/C verdict provenance visible
//    AC#5: backward-compatible — decisions without sub-decisions / Stage B/C
//          render without empty / "(missing)" sections

describe('show subcommand — RFC-0035 Phase 6 support surface (AISDLC-290)', () => {
  async function seedDecisionWithStageA(summary = 'phase-6 reversible decision'): Promise<string> {
    setArgv(
      'add',
      '--summary',
      summary,
      '--scope',
      'workspace',
      '--option',
      'opt-a:Keep',
      '--option',
      'opt-b:Switch',
      '--reversible',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    const id = stdoutJson<{ decisionId: string }>().decisionId;
    stdoutChunks = [];
    setArgv('score-a', id, '--store', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];
    return id;
  }

  it('AC#5 — Phase-1 decision (no Stage A/B/C) renders surface without empty sections', async () => {
    setArgv(
      'add',
      '--summary',
      'minimal decision',
      '--scope',
      'workspace',
      '--option',
      'opt-a:A',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];

    setArgv('show', 'DEC-0001');
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    // Audit-style header preserved (existing behavior)
    expect(out).toMatch(/DEC-0001 — minimal decision/);
    expect(out).toMatch(/Event history/);
    // Phase 6 surface — problem + options sections appear
    expect(out).toMatch(/## Problem/);
    expect(out).toMatch(/## Options/);
    // Backward-compat — sections without data are suppressed (no Mermaid /
    // Recommendation / Counter-arguments / Verdict provenance)
    expect(out).not.toMatch(/## Recommendation/);
    expect(out).not.toMatch(/## Counter-arguments/);
    expect(out).not.toMatch(/```mermaid/);
    expect(out).not.toMatch(/## Verdict provenance/);
  });

  it('AC#4 — show surfaces Stage A verdict provenance after score-a --store', async () => {
    await seedDecisionWithStageA('decision with stage-a stored');
    setArgv('show', 'DEC-0001');
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/## Verdict provenance/);
    expect(out).toMatch(/### Stage A/);
    expect(out).toMatch(/priority signal:/);
    expect(out).toMatch(/reversibility:/);
    // Stage B and Stage C not present until those tiers run
    expect(out).not.toMatch(/### Stage B/);
    expect(out).not.toMatch(/### Stage C/);
  });

  it('AC#3 — JSON mode emits both decision and supportSurface payloads', async () => {
    await seedDecisionWithStageA('decision-with-json');
    setArgv('show', 'DEC-0001', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const r = stdoutJson<{
      ok: boolean;
      decision: Decision;
      supportSurface: {
        decisionId: string;
        problemSummary: string;
        options: Array<{ id: string }>;
        counterArguments: string[];
        subDecisionGraph: Array<{ optionId: string }>;
        stageAProvenance?: { prioritySignal: number };
      };
    }>();
    expect(r.ok).toBe(true);
    expect(r.supportSurface.decisionId).toBe('DEC-0001');
    expect(r.supportSurface.problemSummary).toMatch(/decision-with-json/);
    expect(r.supportSurface.options.map((o) => o.id)).toEqual(['opt-a', 'opt-b']);
    // Stage A stored — provenance surfaces in JSON too
    expect(r.supportSurface.stageAProvenance).toBeDefined();
    expect(typeof r.supportSurface.stageAProvenance!.prioritySignal).toBe('number');
  });

  it('AC#1 + #2 + #4 — score-c --store --force surfaces recommendation / Mermaid / Stage A-B-C', async () => {
    setArgv(
      'add',
      '--summary',
      'mid-band phase-6 decision',
      '--scope',
      'workspace',
      '--option',
      'opt-a:Keep',
      '--option',
      'opt-b:Switch',
      '--reversible',
      '--format',
      'json',
    );
    await buildDecisionsCli().parseAsync();
    const id = stdoutJson<{ decisionId: string }>().decisionId;
    stdoutChunks = [];

    // --force bypasses the mid-band guard; --store persists Stage C output
    setArgv('score-c', id, '--force', '--store', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    stdoutChunks = [];

    setArgv('show', id);
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    // AC#1 — recommendation + confidence rendered
    expect(out).toMatch(/## Recommendation/);
    expect(out).toMatch(/\*\*option:\*\*/);
    expect(out).toMatch(/\*\*confidence:\*\*/);
    // AC#4 — Stage C provenance surfaces (model + threshold + meets-threshold)
    expect(out).toMatch(/### Stage C/);
    expect(out).toMatch(/threshold:/);
    expect(out).toMatch(/model:/);
  });

  it('AC#2 — option-declared subDecisions render as Mermaid flowchart in show output', async () => {
    // The `cli-decisions add` flag-mode doesn't accept subDecisions, so this
    // test seeds via the event log directly to exercise the declared-source
    // graph path (Stage C-implied path is exercised in the unit tests).
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const logPath = resolveEventLogPath(tmp);
    mkdirSync(dirname(logPath), { recursive: true });
    const opened = {
      eventVersion: 'v1',
      type: 'decision-opened',
      ts: '2026-05-15T10:00:00.000Z',
      decisionId: 'DEC-0001',
      source: 'rfc-open-question',
      scope: 'rfc:RFC-0035',
      summary: 'with declared sub-decisions',
      reversible: true,
      options: [
        {
          id: 'opt-a',
          description: 'Keep existing routing',
          subDecisions: ['how does the back-off behave?', 'what about cold-start?'],
        },
        { id: 'opt-b', description: 'Switch to new' },
      ],
    };
    writeFileSync(logPath, JSON.stringify(opened) + '\n', 'utf8');

    setArgv('show', 'DEC-0001');
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/## Sub-decision graph/);
    // Extract just the Mermaid fence so we can assert opt-b is skipped from
    // the Mermaid diagram itself (it still appears in the audit Options:
    // listing higher up in the same `show` output — that is intentional).
    const mermaidMatch = out.match(/```mermaid\n([\s\S]*?)```/);
    expect(mermaidMatch).not.toBeNull();
    const mermaid = mermaidMatch![1];
    expect(mermaid).toMatch(/flowchart TD/);
    expect(mermaid).toMatch(/D\["DEC-0001"\]/);
    expect(mermaid).toMatch(/opt-a: Keep existing routing/);
    expect(mermaid).toMatch(/how does the back-off behave\?/);
    // AC#5: opt-b has no sub-decisions → skipped from the Mermaid diagram
    expect(mermaid).not.toMatch(/Switch to new/);
    // Text outline fallback for TUI consumers
    expect(out).toMatch(/Text outline \(TUI fallback\)/);
  });

  it('--support-surface-only suppresses the audit header and event history', async () => {
    await seedDecisionWithStageA('surface-only decision');
    setArgv('show', 'DEC-0001', '--support-surface-only');
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    // The audit-style header lines + event history are SUPPRESSED
    expect(out).not.toMatch(/Event history/);
    expect(out).not.toMatch(/^DEC-0001 — /m); // the audit-summary header
    // The Phase 6 surface is rendered
    expect(out).toMatch(/## Problem/);
    expect(out).toMatch(/## Options/);
    expect(out).toMatch(/## Verdict provenance/);
  });
});

// ── RFC-0035 Phase 7 — fatigue subcommand (AISDLC-291) ───────────────────────

describe('fatigue subcommand (Phase 7 / AISDLC-291)', () => {
  it('status reports inactive when no operator-state.yaml exists', async () => {
    setArgv('fatigue', 'status', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const out = stdoutJson<{
      ok: boolean;
      active: boolean;
      explicit: boolean;
      inferred: boolean;
    }>();
    expect(out.ok).toBe(true);
    expect(out.active).toBe(false);
    expect(out.explicit).toBe(false);
    expect(out.inferred).toBe(false);
  });

  it('set declares fatigue and persists the reason', async () => {
    setArgv('fatigue', 'set', '--reason', 'long walkthrough day', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const out = stdoutJson<{
      ok: boolean;
      path: string;
      state: { fatigueActive: boolean; fatigueReason: string; fatigueDeclaredAt: string };
    }>();
    expect(out.ok).toBe(true);
    expect(out.state.fatigueActive).toBe(true);
    expect(out.state.fatigueReason).toBe('long walkthrough day');
    expect(out.state.fatigueDeclaredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The on-disk file should now exist where the path field points.
    expect(readFileSync(out.path, 'utf8')).toMatch(/fatigueActive: true/);
  });

  it('status reflects the just-set fatigue (round-trip)', async () => {
    setArgv('fatigue', 'set', '--reason', 'too many decisions');
    await buildDecisionsCli().parseAsync();
    stdoutChunks.length = 0; // clear set output

    setArgv('fatigue', 'status', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const out = stdoutJson<{
      active: boolean;
      explicit: boolean;
      reason: string;
    }>();
    expect(out.active).toBe(true);
    expect(out.explicit).toBe(true);
    expect(out.reason).toBe('too many decisions');
  });

  it('clear flips active=false but preserves audit fields', async () => {
    setArgv('fatigue', 'set', '--reason', 'first');
    await buildDecisionsCli().parseAsync();
    stdoutChunks.length = 0;

    setArgv('fatigue', 'clear', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const out = stdoutJson<{
      ok: boolean;
      state: { fatigueActive: boolean; fatigueReason: string };
    }>();
    expect(out.ok).toBe(true);
    expect(out.state.fatigueActive).toBe(false);
    // Audit field preserved for retrospective auditing
    expect(out.state.fatigueReason).toBe('first');
  });

  it('text mode emits a human-readable status line', async () => {
    setArgv('fatigue', 'status');
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/^fatigue active:\s+false/m);
    expect(out).toMatch(/inferFromBehavior: false/);
  });

  it('text mode set output mentions the §7.2 dispatch policy', async () => {
    setArgv('fatigue', 'set');
    await buildDecisionsCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/fatigue set: active/);
    expect(out).toMatch(/m\/l\/xl decisions deferred/);
  });

  it('works regardless of AI_SDLC_DECISION_CATALOG flag (session state ≠ decision data)', async () => {
    // Operator-state is independent of the catalog flag — fatigue is a
    // session-state concern, not a Decision mutation.
    process.env.AI_SDLC_DECISION_CATALOG = 'off';
    setArgv('fatigue', 'set', '--reason', 'flag off check', '--format', 'json');
    await buildDecisionsCli().parseAsync();
    const out = stdoutJson<{ ok: boolean; state: { fatigueActive: boolean } }>();
    expect(out.ok).toBe(true);
    expect(out.state.fatigueActive).toBe(true);
  });
});
