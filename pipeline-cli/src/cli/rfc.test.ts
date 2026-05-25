/**
 * cli-rfc router tests — RFC-0036 Phase 9 (AISDLC-334).
 *
 * Pattern mirrors cli/decisions.test.ts: drive the yargs program
 * in-process with stubbed stdout/stderr/exit and assert on captured
 * output.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildRfcCli,
  buildRfcIndex,
  extractRfcIdFromFilename,
  extractRfcIdFromScope,
  extractRfcTitle,
  groupDecisionsByRfc,
  renderIndexTable,
  resolveRfcDir,
} from './rfc.js';
import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
  projectDecision,
  type Decision,
} from '../decisions/index.js';

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
  tmp = mkdtempSync(join(tmpdir(), 'cli-rfc-'));
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

  process.env.AI_SDLC_DECISION_CATALOG = 'on';
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;

  if (savedFlag === undefined) delete process.env.AI_SDLC_DECISION_CATALOG;
  else process.env.AI_SDLC_DECISION_CATALOG = savedFlag;

  rmSync(tmp, { recursive: true, force: true });
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'cli-rfc', '--work-dir', tmp, ...args];
}

function stdoutJson<T = unknown>(): T {
  const text = stdoutChunks.join('');
  const trimmed = text.trim();
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

function writeRfc(path: string, body: string): void {
  const dir = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, body, 'utf8');
}

function rfcBody(opts: { id?: string; title?: string; lifecycle?: string }): string {
  const lines = ['---'];
  if (opts.id) lines.push(`id: ${opts.id}`);
  if (opts.title) lines.push(`title: '${opts.title}'`);
  if (opts.lifecycle) lines.push(`lifecycle: ${opts.lifecycle}`);
  lines.push('---', '', `# ${opts.title ?? opts.id ?? 'Untitled'}`, '', 'Body.', '');
  return lines.join('\n');
}

// ── Pure helper tests ─────────────────────────────────────────────────────────

describe('extractRfcIdFromFilename', () => {
  it('matches RFC-NNNN-*.md', () => {
    expect(extractRfcIdFromFilename('RFC-0035-decision-catalog.md')).toBe('RFC-0035');
    expect(extractRfcIdFromFilename('RFC-0036-foo.md')).toBe('RFC-0036');
  });
  it('returns null for non-RFC filenames', () => {
    expect(extractRfcIdFromFilename('not-an-rfc.md')).toBeNull();
    expect(extractRfcIdFromFilename('README.md')).toBeNull();
  });
  it('uppercases case-insensitive prefix', () => {
    expect(extractRfcIdFromFilename('rfc-0099-lowercase.md')).toBe('RFC-0099');
  });
});

describe('extractRfcTitle', () => {
  it('reads title: from frontmatter', () => {
    const body = rfcBody({ id: 'RFC-0001', title: 'My Test RFC', lifecycle: 'Draft' });
    expect(extractRfcTitle(body)).toBe('My Test RFC');
  });
  it('falls back to first H1 when frontmatter has no title', () => {
    const body = '---\nlifecycle: Draft\n---\n\n# H1 Title\n\nbody\n';
    expect(extractRfcTitle(body)).toBe('H1 Title');
  });
  it('handles no frontmatter (adopter RFC without frontmatter)', () => {
    const body = '# Just an H1\n\nNo frontmatter at all.\n';
    expect(extractRfcTitle(body)).toBe('Just an H1');
  });
  it('returns null when neither title: nor H1 present', () => {
    expect(extractRfcTitle('No headings here.\n')).toBeNull();
  });
});

describe('extractRfcIdFromScope', () => {
  it('matches rfc:RFC-NNNN', () => {
    expect(extractRfcIdFromScope('rfc:RFC-0035')).toBe('RFC-0035');
  });
  it('matches bare RFC-NNNN', () => {
    expect(extractRfcIdFromScope('RFC-0029')).toBe('RFC-0029');
  });
  it('returns null for non-RFC scopes', () => {
    expect(extractRfcIdFromScope('workspace')).toBeNull();
    expect(extractRfcIdFromScope('issue:AISDLC-285')).toBeNull();
  });
});

describe('groupDecisionsByRfc', () => {
  it('groups decisions by extracted RFC id', () => {
    const mkDecision = (id: string, scope: string): Decision =>
      ({
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'Decision',
        metadata: {
          id,
          source: 'ad-hoc',
          scope,
          created: '2026-05-25T00:00:00Z',
          updated: '2026-05-25T00:00:00Z',
        },
        spec: { summary: 's', options: [{ id: 'a', description: 'A' }] },
        status: { lifecycle: 'open' },
        decisionLog: [],
      }) as unknown as Decision;
    const decisions = [
      mkDecision('DEC-0001', 'rfc:RFC-0035'),
      mkDecision('DEC-0002', 'rfc:RFC-0035'),
      mkDecision('DEC-0003', 'rfc:RFC-0036'),
      mkDecision('DEC-0004', 'workspace'),
    ];
    const grouped = groupDecisionsByRfc(decisions);
    expect(grouped.get('RFC-0035')).toHaveLength(2);
    expect(grouped.get('RFC-0036')).toHaveLength(1);
    expect(grouped.has('workspace')).toBe(false);
  });
});

// ── resolveRfcDir tests ───────────────────────────────────────────────────────

describe('resolveRfcDir', () => {
  it('returns rfcs/ as default and labels source=default when it exists', () => {
    mkdirSync(join(tmp, 'rfcs'), { recursive: true });
    const r = resolveRfcDir(tmp);
    // join() preserves the trailing slash from DEFAULTS.rfcScaffold.rfcDir.
    expect(r.rfcDir).toBe(join(tmp, 'rfcs/'));
    expect(r.source).toBe('default');
  });
  it('falls back to spec/rfcs/ when rfcs/ is absent', () => {
    mkdirSync(join(tmp, 'spec', 'rfcs'), { recursive: true });
    const r = resolveRfcDir(tmp);
    expect(r.rfcDir).toBe(join(tmp, 'spec', 'rfcs'));
    expect(r.source).toBe('spec-rfcs-fallback');
  });
  it('honors --rfc-dir flag override', () => {
    mkdirSync(join(tmp, 'rfcs'), { recursive: true });
    mkdirSync(join(tmp, 'company-rfcs'), { recursive: true });
    const r = resolveRfcDir(tmp, { rfcDir: 'company-rfcs' });
    expect(r.rfcDir).toBe(join(tmp, 'company-rfcs'));
    expect(r.source).toBe('cli-flag');
  });
  it('honors adopter-authoring.yaml rfc-scaffold.rfcDir override', () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    mkdirSync(join(tmp, 'my-rfcs'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'adopter-authoring.yaml'),
      ['adopter-authoring:', '  rfc-scaffold:', '    rfcDir: my-rfcs/', ''].join('\n'),
      'utf8',
    );
    const r = resolveRfcDir(tmp);
    expect(r.rfcDir).toBe(join(tmp, 'my-rfcs/'));
    expect(r.source).toBe('config');
  });
  it('returns the configured candidate even when missing so callers can report "no rfcs"', () => {
    // No rfcs/ and no spec/rfcs/ — resolver returns the default candidate path.
    const r = resolveRfcDir(tmp);
    expect(r.rfcDir).toBe(join(tmp, 'rfcs/'));
    expect(r.source).toBe('default');
  });
});

// ── buildRfcIndex tests ───────────────────────────────────────────────────────

describe('buildRfcIndex (composes with RFC-0035 Phase 1 — AC #5)', () => {
  it('returns empty array when rfcDir does not exist', () => {
    expect(buildRfcIndex({ rfcDir: join(tmp, 'missing'), decisions: [] })).toEqual([]);
  });
  it('reads filenames + frontmatter + lifecycle for each .md', () => {
    const rfcDir = join(tmp, 'rfcs');
    writeRfc(
      join(rfcDir, 'RFC-0001-foo.md'),
      rfcBody({ id: 'RFC-0001', title: 'Foo', lifecycle: 'Draft' }),
    );
    writeRfc(
      join(rfcDir, 'RFC-0002-bar.md'),
      rfcBody({ id: 'RFC-0002', title: 'Bar', lifecycle: 'Signed Off' }),
    );
    const entries = buildRfcIndex({ rfcDir, decisions: [] });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.rfcId).toBe('RFC-0001');
    expect(entries[0]!.title).toBe('Foo');
    expect(entries[0]!.lifecycle).toBe('Draft');
    expect(entries[1]!.lifecycle).toBe('Signed Off');
  });
  it('counts resolved + pending decisions per RFC (AC #3)', () => {
    const rfcDir = join(tmp, 'rfcs');
    writeRfc(
      join(rfcDir, 'RFC-0099-test.md'),
      rfcBody({ id: 'RFC-0099', title: 'T', lifecycle: 'Draft' }),
    );

    // Three decisions scoped to RFC-0099: one answered, two open.
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'rfc-open-question',
        scope: 'rfc:RFC-0099',
        summary: 'one',
        options: [
          { id: 'a', description: 'A' },
          { id: 'b', description: 'B' },
        ],
      }),
      { workDir: tmp },
    );
    appendDecisionEvent(
      makeOperatorAnsweredEvent({ decisionId: 'DEC-0001', chosenOptionId: 'a' }),
      { workDir: tmp },
    );
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0002',
        source: 'rfc-open-question',
        scope: 'rfc:RFC-0099',
        summary: 'two',
        options: [{ id: 'a', description: 'A' }],
      }),
      { workDir: tmp },
    );
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0003',
        source: 'rfc-open-question',
        scope: 'rfc:RFC-0099',
        summary: 'three',
        options: [{ id: 'a', description: 'A' }],
      }),
      { workDir: tmp },
    );

    const d1 = projectDecision('DEC-0001', { workDir: tmp })!;
    const d2 = projectDecision('DEC-0002', { workDir: tmp })!;
    const d3 = projectDecision('DEC-0003', { workDir: tmp })!;
    const entries = buildRfcIndex({ rfcDir, decisions: [d1, d2, d3] });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.decisionsResolved).toBe(1);
    expect(entries[0]!.decisionsPending).toBe(2);
    expect(entries[0]!.decisionIds.sort()).toEqual(['DEC-0001', 'DEC-0002', 'DEC-0003']);
  });
  it('skips non-markdown files', () => {
    const rfcDir = join(tmp, 'rfcs');
    writeRfc(join(rfcDir, 'RFC-0001-foo.md'), rfcBody({ id: 'RFC-0001', lifecycle: 'Draft' }));
    writeRfc(join(rfcDir, 'notes.txt'), 'not an rfc');
    const entries = buildRfcIndex({ rfcDir, decisions: [] });
    expect(entries).toHaveLength(1);
  });
  it('skips non-RFC markdown (README.md, index.md, etc.)', () => {
    const rfcDir = join(tmp, 'rfcs');
    writeRfc(join(rfcDir, 'README.md'), '# Registry\n\nList of RFCs.\n');
    writeRfc(join(rfcDir, 'CONTRIBUTING.md'), '# How to contribute\n');
    writeRfc(join(rfcDir, 'RFC-0001-foo.md'), rfcBody({ id: 'RFC-0001', lifecycle: 'Draft' }));
    const entries = buildRfcIndex({ rfcDir, decisions: [] });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.rfcId).toBe('RFC-0001');
  });
});

describe('renderIndexTable', () => {
  it('renders an empty marker when no entries', () => {
    expect(renderIndexTable([])).toMatch(/no RFCs found/);
  });
  it('contains a header row and one row per entry', () => {
    const out = renderIndexTable([
      {
        rfcId: 'RFC-0001',
        title: 'Hello',
        lifecycle: 'Draft',
        filePath: '/tmp/x.md',
        decisionsResolved: 1,
        decisionsPending: 2,
        decisionIds: ['DEC-0001'],
      },
    ]);
    expect(out).toContain('rfc');
    expect(out).toContain('lifecycle');
    expect(out).toContain('resolved');
    expect(out).toContain('pending');
    expect(out).toContain('RFC-0001');
    expect(out).toContain('Hello');
  });
});

// ── End-to-end CLI tests ──────────────────────────────────────────────────────

describe('cli-rfc index — yargs router (AC #1, #2, #3, #4, #5)', () => {
  it('AC #1: scans <rfcDir>/*.md and lists each RFC (text mode)', async () => {
    const rfcDir = join(tmp, 'rfcs');
    writeRfc(
      join(rfcDir, 'RFC-0001-alpha.md'),
      rfcBody({ id: 'RFC-0001', title: 'Alpha', lifecycle: 'Draft' }),
    );
    writeRfc(
      join(rfcDir, 'RFC-0002-beta.md'),
      rfcBody({ id: 'RFC-0002', title: 'Beta', lifecycle: 'Signed Off' }),
    );
    setArgv('index');
    await buildRfcCli().parseAsync();
    const out = stdoutText();
    expect(out).toContain('RFC index — scanned');
    expect(out).toContain('RFC-0001');
    expect(out).toContain('Alpha');
    expect(out).toContain('RFC-0002');
    expect(out).toContain('Beta');
  });

  it('AC #4: --format json emits a structured envelope', async () => {
    const rfcDir = join(tmp, 'rfcs');
    writeRfc(
      join(rfcDir, 'RFC-0001-alpha.md'),
      rfcBody({ id: 'RFC-0001', title: 'Alpha', lifecycle: 'Draft' }),
    );
    setArgv('index', '--format', 'json');
    await buildRfcCli().parseAsync();
    const json = stdoutJson<{
      ok: boolean;
      rfcDir: string;
      rfcDirSource: string;
      catalogEnabled: boolean;
      count: number;
      entries: Array<{
        rfcId: string;
        title: string;
        lifecycle: string;
        decisionsResolved: number;
        decisionsPending: number;
      }>;
    }>();
    expect(json.ok).toBe(true);
    expect(json.count).toBe(1);
    expect(json.entries[0]!.rfcId).toBe('RFC-0001');
    expect(json.entries[0]!.lifecycle).toBe('Draft');
    expect(json.entries[0]!.decisionsResolved).toBe(0);
    expect(json.entries[0]!.decisionsPending).toBe(0);
    expect(json.catalogEnabled).toBe(true);
  });

  it('AC #2 + #3: cross-references Decision Catalog and emits per-RFC counts', async () => {
    const rfcDir = join(tmp, 'rfcs');
    writeRfc(
      join(rfcDir, 'RFC-0099-cross.md'),
      rfcBody({ id: 'RFC-0099', title: 'Cross', lifecycle: 'Draft' }),
    );

    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-1001',
        source: 'rfc-open-question',
        scope: 'rfc:RFC-0099',
        summary: 'a',
        options: [
          { id: 'a', description: 'A' },
          { id: 'b', description: 'B' },
        ],
      }),
      { workDir: tmp },
    );
    appendDecisionEvent(
      makeOperatorAnsweredEvent({ decisionId: 'DEC-1001', chosenOptionId: 'a' }),
      { workDir: tmp },
    );
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-1002',
        source: 'rfc-open-question',
        scope: 'rfc:RFC-0099',
        summary: 'b',
        options: [{ id: 'a', description: 'A' }],
      }),
      { workDir: tmp },
    );

    setArgv('index', '--format', 'json');
    await buildRfcCli().parseAsync();
    const json = stdoutJson<{
      entries: Array<{
        rfcId: string;
        decisionsResolved: number;
        decisionsPending: number;
        decisionIds: string[];
      }>;
    }>();
    const rfc = json.entries.find((e) => e.rfcId === 'RFC-0099');
    expect(rfc).toBeDefined();
    expect(rfc!.decisionsResolved).toBe(1);
    expect(rfc!.decisionsPending).toBe(1);
    expect(rfc!.decisionIds.sort()).toEqual(['DEC-1001', 'DEC-1002']);
  });

  it('AC #6 (degrade-open): when AI_SDLC_DECISION_CATALOG=off, lists RFCs with zero counts', async () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off';
    const rfcDir = join(tmp, 'rfcs');
    writeRfc(
      join(rfcDir, 'RFC-0001-alpha.md'),
      rfcBody({ id: 'RFC-0001', title: 'Alpha', lifecycle: 'Draft' }),
    );
    setArgv('index', '--format', 'json');
    await buildRfcCli().parseAsync();
    const json = stdoutJson<{
      catalogEnabled: boolean;
      entries: Array<{ decisionsResolved: number; decisionsPending: number }>;
    }>();
    expect(json.catalogEnabled).toBe(false);
    expect(json.entries[0]!.decisionsResolved).toBe(0);
    expect(json.entries[0]!.decisionsPending).toBe(0);
    expect(stderrText()).toMatch(/AI_SDLC_DECISION_CATALOG|decision catalog/i);
  });

  it('falls back to spec/rfcs/ when rfcs/ is absent', async () => {
    const rfcDir = join(tmp, 'spec', 'rfcs');
    writeRfc(
      join(rfcDir, 'RFC-0050-spec.md'),
      rfcBody({ id: 'RFC-0050', title: 'Spec only', lifecycle: 'Implemented' }),
    );
    setArgv('index', '--format', 'json');
    await buildRfcCli().parseAsync();
    const json = stdoutJson<{
      rfcDirSource: string;
      entries: Array<{ rfcId: string }>;
    }>();
    expect(json.rfcDirSource).toBe('spec-rfcs-fallback');
    expect(json.entries.map((e) => e.rfcId)).toContain('RFC-0050');
  });

  it('handles an empty rfcs/ dir (json mode)', async () => {
    mkdirSync(join(tmp, 'rfcs'), { recursive: true });
    setArgv('index', '--format', 'json');
    await buildRfcCli().parseAsync();
    const json = stdoutJson<{ count: number; entries: unknown[] }>();
    expect(json.count).toBe(0);
    expect(json.entries).toEqual([]);
  });
});
