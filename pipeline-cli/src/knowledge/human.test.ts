import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContextCli } from '../cli/context.js';
import { hashValue, parseEntryFile, toEntry, type KnowledgeEntry } from './entry.js';
import {
  buildDashboard,
  chainHead,
  confirmEntry,
  correctEntry,
  coverageScore,
  liveEntries,
  renderDashboard,
  supersedeEntry,
} from './human.js';
import { readKnowledgeLog } from './log.js';
import { DEFAULT_ONTOLOGY } from './ontology.js';
import { readEntries } from './store.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let root: string;
afterEach(() => {
  removeFixtureDir(root);
  process.exitCode = 0;
});

function fields(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const value = `value of ${id}`;
  return {
    id,
    trunk: 'systems',
    type: 'fact',
    value,
    confidence: 0.5,
    authority: 'inferred',
    scope: 'internal',
    source: 'src/x.ts',
    observed: '2026-10-09',
    decay: 'durable',
    relations: [],
    contentHash: hashValue(value),
    ...over,
  };
}

function repo(ids: string[] = ['a', 'b']): string {
  root = mkdtempSync(join(tmpdir(), 'human-'));
  for (const id of ids) {
    const p = join(root, '.ai-sdlc/knowledge/systems', `${id}.md`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `---\n${JSON.stringify(fields(id))}\n---\nbody\n`);
  }
  return join(root, '.ai-sdlc/knowledge');
}

const entryOf = (tracked: string, id: string): KnowledgeEntry => {
  const parsed = parseEntryFile(readFileSync(join(tracked, 'systems', `${id}.md`), 'utf-8'));
  if (!('fields' in parsed)) throw new Error('bad');
  return toEntry(parsed.fields, parsed.body);
};

describe('human surface', () => {
  it('confirm moves confidence 30 percent toward the value and keeps authority', () => {
    const t = repo();
    expect(confirmEntry(t, 'a', 1, 'human')).toBe(0.65);
    expect(entryOf(t, 'a').authority).toBe('inferred');
    expect(confirmEntry(t, 'zz', 1, 'human')).toBeNull();
  });

  it('correct replaces value and hash and logs', () => {
    const t = repo();
    expect(correctEntry(t, 'a', 'new text', 'human')).toBe(true);
    const e = entryOf(t, 'a');
    expect(e.value).toBe('new text');
    expect(e.contentHash).toBe(hashValue('new text'));
    expect(correctEntry(t, 'zz', 'x', 'human')).toBe(false);
  });

  it('supersede links, keeps the old entry and moves the chain head', () => {
    const t = repo();
    expect(supersedeEntry(t, 'a', 'b', 'human').ok).toBe(true);
    expect(entryOf(t, 'a').id).toBe('a');
    expect(entryOf(t, 'b').relations).toEqual([{ type: 'supersedes', target: 'a' }]);
    const all = readEntries(t);
    expect(chainHead(all, 'a')).toBe('b');
    expect(liveEntries(all).map((e) => e.id)).toEqual(['b']);
    expect(supersedeEntry(t, 'a', 'a', 'human').ok).toBe(false);
    expect(supersedeEntry(t, 'a', 'nope', 'human').ok).toBe(false);
    expect(supersedeEntry(t, 'nope', 'a', 'human').ok).toBe(false);
  });

  it('every mutation writes a knowledge-log event, promote included', async () => {
    const t = repo(['a', 'b', 'c']);
    confirmEntry(t, 'a', 1, 'human');
    correctEntry(t, 'a', 'v', 'human');
    supersedeEntry(t, 'a', 'b', 'human');
    // agent caller: refused, no authority change; human path is covered in promote tests
    await buildContextCli([
      'promote',
      'c',
      '--to',
      'canonical',
      '--project-dir',
      root,
    ]).parseAsync();
    expect(process.exitCode).toBe(1);
    expect(entryOf(t, 'c').authority).toBe('inferred');
    expect(readKnowledgeLog(t).map((e) => e.event)).toEqual([
      'confirmed',
      'corrected',
      'superseded',
    ]);
  });

  it('coverage score maps to blocked, draft and ready', () => {
    expect(coverageScore({ required: 0, enriching: 1, count: 1 })).toEqual({
      score: 0.4,
      band: 'draft',
    });
    expect(coverageScore({ required: 0, enriching: 0.5, count: 0.5 }).band).toBe('blocked');
    expect(coverageScore({ required: 1, enriching: 0, count: 0 })).toEqual({
      score: 0.6,
      band: 'draft',
    });
    expect(coverageScore({ required: 1, enriching: 1, count: 1 })).toEqual({
      score: 1,
      band: 'ready',
    });
    expect(coverageScore({ required: 1, enriching: 0.6, count: 0 }).band).toBe('ready');
  });

  it('dashboard lists gaps tagged owner, research and analysis, and the staleness queue', async () => {
    const t = repo(['a']);
    const stale = join(t, 'process/old.md');
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(
      stale,
      `---\n${JSON.stringify(fields('old', { trunk: 'process', decay: 'volatile', observed: '2025-01-01' }))}\n---\n`,
    );
    const d = buildDashboard(readEntries(t), DEFAULT_ONTOLOGY.trunks, new Date('2026-10-29'));
    const text = renderDashboard(d).join('\n');
    expect(text).toContain("[owner] required trunk 'decisions' has no entries");
    expect(text).toContain("[research] enriching trunk 'products' has no entries");
    expect(text).toContain("[analysis] trunk 'systems' holds only inferred entries");
    expect(text).toContain('old freshness');
    expect(renderDashboard(buildDashboard([], [], new Date())).join('\n')).toContain('none');

    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (
      out.push(String(s)),
      true
    )) as typeof process.stdout.write;
    try {
      await buildContextCli(['coverage', '--project-dir', root]).parseAsync();
    } finally {
      process.stdout.write = orig;
    }
    expect(out.join('')).toContain('[owner]');
  });

  it('CLI confirm, correct, supersede work end to end', async () => {
    const t = repo();
    const run = (a: string[]) => buildContextCli([...a, '--project-dir', root]).parseAsync();
    await run(['confirm', 'a', '--confidence', '1']);
    await run(['correct', 'a', '--value', 'z']);
    await run(['supersede', 'a', 'b']);
    expect(entryOf(t, 'a').value).toBe('z');
    expect(chainHead(readEntries(t), 'a')).toBe('b');
    await run(['confirm', 'nope']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await run(['correct', 'nope', '--value', 'q']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await run(['supersede', 'nope', 'a']);
    expect(process.exitCode).toBe(1);
  });
});
