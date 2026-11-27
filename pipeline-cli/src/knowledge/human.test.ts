import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildContextCli, reportWrite } from '../cli/context.js';
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
import { loadKnowledgeConfig } from './config.js';
import { DEFAULT_ONTOLOGY } from './ontology.js';
import { openKnowledgeStore, toEntries } from './knowledge-store.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const entriesIn = (trackedRoot: string): KnowledgeEntry[] =>
  toEntries(openKnowledgeStore({ backend: 'files', trackedRoot }, root).list('tracked'));

const HUMAN = { by: 'human', principal: 'human:op@example.com' } as const;

let root: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (root) removeFixtureDir(root);
  process.exitCode = 0;
});

/** Capture stdout/stderr writes; `run` drives the context CLI against the fixture root. */
function captureCli() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
  const run = (a: string[]) => buildContextCli([...a, '--project-dir', root]).parseAsync();
  return { out, err, run };
}

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
  it('confirm moves confidence 30 percent toward the value and keeps authority', async () => {
    const t = repo();
    expect(
      await confirmEntry({ backend: 'files' }, t, 'a', 1, HUMAN, undefined, root),
    ).toMatchObject({ status: 'applied', confidence: 0.65 });
    expect(entryOf(t, 'a').authority).toBe('inferred');
    expect(
      await confirmEntry({ backend: 'files' }, t, 'zz', 1, HUMAN, undefined, root),
    ).toMatchObject({ status: 'rejected', reason: "entry 'zz' not found" });
  });

  it('correct replaces value and hash and logs', async () => {
    const t = repo();
    expect(
      (await correctEntry({ backend: 'files' }, t, 'a', 'new text', HUMAN, undefined, root)).status,
    ).toBe('applied');
    const e = entryOf(t, 'a');
    expect(e.value).toBe('new text');
    expect(e.contentHash).toBe(hashValue('new text'));
    expect(
      (await correctEntry({ backend: 'files' }, t, 'zz', 'x', HUMAN, undefined, root)).status,
    ).toBe('rejected');
  });

  it('correct of a tracked entry logs the changed field names with id, by and principal', async () => {
    const t = repo();
    await correctEntry({ backend: 'files' }, t, 'a', 'new text', HUMAN, undefined, root);
    const [ev] = readKnowledgeLog(t);
    expect(ev).toMatchObject({
      event: 'corrected',
      id: 'a',
      by: 'human',
      principal: HUMAN.principal,
      detail: 'fields: contentHash, value',
    });
  });

  /** A protected entry under `<root>/<protectedRel>/systems/<id>.md`. */
  function protectedEntry(protectedRel: string, id: string, value: string, scope: string): void {
    const p = join(root, protectedRel, 'systems', `${id}.md`);
    mkdirSync(dirname(p), { recursive: true });
    const f = fields(id, { value, scope, contentHash: hashValue(value) });
    writeFileSync(p, `---\n${JSON.stringify(f)}\n---\nbody\n`);
  }

  it.each(['protected', ' Protected ', 'PROTECTED'])(
    'correct of a %j-scoped entry keeps both values and their hashes out of the raw log',
    async (scope) => {
      const t = repo();
      const protectedAbs = join(root, '.ai-sdlc/knowledge-protected');
      writeFileSync(
        join(root, '.ai-sdlc/context.yaml'),
        `knowledge:\n  protectedRoot: ${JSON.stringify(protectedAbs)}\n`,
      );
      const OLD = 'ACME-CLIENT-SECRET-old-7731';
      const NEW = 'ACME-CLIENT-SECRET-new-9184';
      protectedEntry('.ai-sdlc/knowledge-protected', 'p1', OLD, scope);
      // opened as cli/context.ts opens it: the full loaded config is the backend selection
      const config = loadKnowledgeConfig(root);
      expect((await correctEntry(config, t, 'p1', NEW, HUMAN, undefined, root)).status).toBe(
        'applied',
      );
      const raw = readFileSync(join(root, '.ai-sdlc/knowledge-log.jsonl'), 'utf-8');
      for (const needle of [OLD, NEW, hashValue(OLD), hashValue(NEW)]) {
        expect(raw).not.toContain(needle);
      }
      expect(readKnowledgeLog(t)).toEqual([
        expect.objectContaining({
          event: 'corrected',
          id: 'p1',
          by: 'human',
          principal: HUMAN.principal,
          detail: 'fields: contentHash, value (protected; values not logged)',
        }),
      ]);
    },
  );

  it('human edits resolve a relative protectedRoot against the project directory', async () => {
    const t = repo();
    // the test process cwd is the package directory, never the fixture root
    expect(process.cwd()).not.toBe(root);
    writeFileSync(join(root, '.ai-sdlc/context.yaml'), 'knowledge:\n  protectedRoot: secret-kb\n');
    protectedEntry('secret-kb', 'p2', 'CLIENT-VALUE-4410', 'protected');
    const config = loadKnowledgeConfig(root);
    expect(
      (await correctEntry(config, t, 'p2', 'CLIENT-VALUE-5521', HUMAN, undefined, root)).status,
    ).toBe('applied');
    expect((await confirmEntry(config, t, 'p2', 1, HUMAN, undefined, root)).confidence).toBe(0.65);
    expect(readFileSync(join(root, 'secret-kb/systems/p2.md'), 'utf-8')).toContain(
      'CLIENT-VALUE-5521',
    );
    // the CLI passes --project-dir through
    await buildContextCli([
      'correct',
      'p2',
      '--value',
      'CLIENT-VALUE-6632',
      '--project-dir',
      root,
    ]).parseAsync();
    expect(process.exitCode ?? 0).toBe(0);
    expect(readFileSync(join(root, 'secret-kb/systems/p2.md'), 'utf-8')).toContain(
      'CLIENT-VALUE-6632',
    );
    expect(readFileSync(join(root, '.ai-sdlc/knowledge-log.jsonl'), 'utf-8')).not.toContain(
      'CLIENT-VALUE',
    );
  });

  it('supersede is one write: creates the new entry, keeps and marks the old one, moves the chain head', async () => {
    const t = repo(['a']);
    const sup = (o: string, n: string) =>
      supersedeEntry({ backend: 'files' }, t, o, n, 'value of b', HUMAN, '2026-11-27', root);
    expect(await sup('a', 'b')).toEqual({
      id: 'b',
      path: join('systems', 'b.md'),
      created: true,
      status: 'applied',
    });
    const store = openKnowledgeStore({ backend: 'files', trackedRoot: t }, root);
    expect(store.get('a')?.fields.status).toBe('superseded');
    expect(entryOf(t, 'b')).toMatchObject({
      value: 'value of b',
      contentHash: hashValue('value of b'),
      observed: '2026-11-27',
      supersedes: 'a',
      relations: [{ type: 'supersedes', target: 'a' }],
    });
    const all = entriesIn(t);
    expect(chainHead(all, 'a')).toBe('b');
    expect(liveEntries(all).map((e) => e.id)).toEqual(['b']);
    expect((await sup('a', 'a')).status).toBe('rejected');
    expect((await sup('a', 'b')).status).toBe('rejected');
    expect((await sup('nope', 'c')).status).toBe('rejected');
    expect(readKnowledgeLog(t).map((e) => e.event)).toEqual(['superseded']);
  });

  it('every mutation writes a knowledge-log event, promote included', async () => {
    const t = repo(['a', 'b', 'c']);
    await confirmEntry({ backend: 'files' }, t, 'a', 1, HUMAN, undefined, root);
    await correctEntry({ backend: 'files' }, t, 'a', 'v', HUMAN, undefined, root);
    await supersedeEntry({ backend: 'files' }, t, 'a', 'd', 'w', HUMAN, undefined, root);
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
    const d = buildDashboard(entriesIn(t), DEFAULT_ONTOLOGY.trunks, new Date('2026-10-29'));
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

  it('CLI confirm, correct, supersede work end to end and print the status', async () => {
    const t = repo(['a']);
    const { out, err, run } = captureCli();
    await run(['confirm', 'a', '--confidence', '1']);
    await run(['correct', 'a', '--value', 'z']);
    await run(['supersede', 'a', 'b', '--value', 'y']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toEqual([
      'applied: confidence 0.65\n',
      'applied: corrected a\n',
      'applied: b supersedes a\n',
    ]);
    expect(entryOf(t, 'a').value).toBe('z');
    expect(entryOf(t, 'b').value).toBe('y');
    expect(chainHead(entriesIn(t), 'a')).toBe('b');
    await run(['confirm', 'nope']);
    expect(process.exitCode).toBe(1);
    expect(err.at(-1)).toBe("rejected: entry 'nope' not found\n");
    process.exitCode = 0;
    await run(['correct', 'nope', '--value', 'q']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await run(['supersede', 'nope', 'c', '--value', 'q']);
    expect(process.exitCode).toBe(1);
  });

  it('reportWrite reports a proposal as queued, never as done, and exits 0', () => {
    const { out, err } = captureCli();
    reportWrite({ status: 'proposed' }, 'confidence 0.65');
    reportWrite({ status: 'proposed', reason: 'needs a reviewer' }, 'x');
    expect(out).toEqual([
      'proposed: queued as a proposal\n',
      'proposed: queued as a proposal (needs a reviewer)\n',
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    reportWrite({ status: 'rejected' }, 'x');
    expect(err).toEqual(['rejected: no reason given\n']);
    expect(process.exitCode).toBe(1);
  });
});
