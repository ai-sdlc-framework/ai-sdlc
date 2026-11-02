/** Outward-action ledger of the handoff (AISDLC-1049): note, render, append-only. */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type HandoffOptions,
  LEDGER_RENDER_LIMIT,
  ledgerPath,
  noteLedger,
  readHandoff,
  readLedger,
  writeHandoff,
} from './handoff.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let repo: string;
let board: string;
let opts: HandoffOptions;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 22, 12, 0, tick++));

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'ledger-'));
  board = path.join(repo, '.ai-sdlc', 'dispatch');
  mkdirSync(board, { recursive: true });
  tick = 0;
  opts = { role: 'planner', boardDir: board, now };
});
afterEach(() => removeFixtureDir(repo));

describe('handoff note', () => {
  it('appends a timestamped JSON line next to the handoff', () => {
    const r = noteLedger(opts, { kind: 'filed', url: 'https://x/1', summary: 'issue' });
    expect(r.file).toBe(path.join(repo, '.claude', 'memory', 'handoff_ledger_planner.jsonl'));
    const line = JSON.parse(readFileSync(r.file, 'utf-8').trim());
    expect(line).toMatchObject({ role: 'planner', kind: 'filed', url: 'https://x/1' });
    expect(line.summary).toBe('issue');
    expect(line.at).toBe('2026-10-22T12:00:00.000Z');
  });

  it('refuses an invalid kind with the allowed list and an empty url', () => {
    expect(() => noteLedger(opts, { kind: 'bogus', url: 'u' })).toThrow(
      /filed, commented, opened, closed, sent/,
    );
    expect(() => noteLedger(opts, { kind: 'sent', url: ' ' })).toThrow(/url/);
  });

  it('places a dispatch ledger under the board handoff dir', () => {
    expect(ledgerPath({ role: 'operator-dispatch', boardDir: board })).toBe(
      path.join(board, 'handoff', 'handoff_ledger_operator-dispatch.jsonl'),
    );
  });
});

describe('ledger rendering', () => {
  it('renders the newest 20 newest-first and read shows a fresh note', () => {
    expect(writeHandoff(opts).content).toContain('## Outward actions\n- (none)');
    for (let i = 0; i < 25; i++) noteLedger(opts, { kind: 'commented', url: `https://x/${i}` });
    const { content } = writeHandoff(opts);
    const section = content.split('## Outward actions')[1]!.split('<!--')[0]!;
    const rows = section.trim().split('\n');
    expect(rows).toHaveLength(LEDGER_RENDER_LIMIT);
    expect(rows[0]).toContain('https://x/24');
    expect(rows.at(-1)).toContain('https://x/5');
    noteLedger(opts, { kind: 'filed', url: 'https://x/new', summary: 'why' });
    const r = readHandoff(opts);
    expect(r.regenerated).toBe(true);
    expect(r.content).toContain('filed https://x/new (why)');
  });
});

describe('pending asks (AISDLC-1163)', () => {
  const section = (content: string) =>
    content.split('## Pending asks')[1]!.split('## Outward actions')[0]!.trim();

  it('shows (none) when empty and refuses an ask without ref or summary', () => {
    expect(section(writeHandoff(opts).content)).toBe('- (none)');
    expect(() => noteLedger(opts, { kind: 'asked', summary: 's' })).toThrow(/--ref/);
    expect(() => noteLedger(opts, { kind: 'settled' })).toThrow(/--ref/);
    expect(() => noteLedger(opts, { kind: 'asked', ref: 'r' })).toThrow(/--summary/);
    expect(noteLedger(opts, { kind: 'asked', ref: 'r', summary: 's' }).entry).toMatchObject({
      kind: 'asked',
      ref: 'r',
      url: '',
    });
  });

  it('drops an ask once settled', () => {
    noteLedger(opts, { kind: 'asked', ref: 'DEC-1', summary: 'ok?' });
    expect(section(writeHandoff(opts).content)).toContain('DEC-1 (ok?)');
    noteLedger(opts, { kind: 'settled', ref: 'DEC-1' });
    expect(section(writeHandoff(opts).content)).toBe('- (none)');
  });

  it('keeps two asks on different refs and settles only the named one', () => {
    noteLedger(opts, { kind: 'asked', ref: 'a', summary: 'first' });
    noteLedger(opts, { kind: 'asked', ref: 'b', summary: 'second' });
    noteLedger(opts, { kind: 'settled', ref: 'a' });
    const s = section(writeHandoff(opts).content);
    expect(s).toContain('b (second)');
    expect(s).not.toContain('first');
  });

  it('lists an ask older than the 20-entry render window', () => {
    noteLedger(opts, { kind: 'asked', ref: 'old', summary: 'still open' });
    for (let i = 0; i < 25; i++) noteLedger(opts, { kind: 'commented', url: `https://x/${i}` });
    const { content } = writeHandoff(opts);
    expect(section(content)).toContain('old (still open)');
    expect(content.split('## Outward actions')[1]).not.toContain('asked');
  });
});

describe('append-only guarantee', () => {
  it('a rewrite never drops, reorders or rewrites ledger lines', () => {
    noteLedger(opts, { kind: 'filed', url: 'https://x/a' });
    const file = ledgerPath(opts);
    appendFileSync(file, 'not json\n');
    noteLedger(opts, { kind: 'opened', url: 'https://x/b' });
    const before = readFileSync(file, 'utf-8');
    writeHandoff(opts);
    writeHandoff(opts);
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(readLedger(file, 20).map((e) => e.url)).toEqual(['https://x/b', 'https://x/a']);
    expect(readLedger(path.join(repo, 'missing.jsonl'), 5)).toEqual([]);
  });
});
