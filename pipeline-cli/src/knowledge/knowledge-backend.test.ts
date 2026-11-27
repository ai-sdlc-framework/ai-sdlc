/**
 * DEC-0427: the `knowledge.backend` registration seam fails closed.
 * The fixture packages are written into a temp project's node_modules and resolved from
 * the project root, the way an adopter's installed package would be.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  backendSelection,
  FilesKnowledgeStore,
  KnowledgeBackendError,
  openKnowledgeStore,
  registerKnowledgeBackend,
  type KnowledgeBackendContext,
  type KnowledgeStore,
  type KnowledgeStoreRoots,
} from './knowledge-store.js';
import { loadKnowledgeConfig } from './config.js';
import { ingestSource } from './ingest-sources.js';
import { promoteEntry, refuteEntry, reobserveEntry } from './promote.js';
import { confirmEntry, correctEntry, supersedeEntry } from './human.js';
import { captureFactForProject } from './data-room.js';
import { DEFAULT_ONTOLOGY, ONTOLOGY_FILE, type Ontology } from './ontology.js';
import { hashValue } from './entry.js';
import { validateKnowledge } from './store.js';
import { ingestMemoryForProject } from './ingest-memory.js';
import { serializeNote } from '../memory-dream/notes.js';
import { buildContextCli } from '../cli/context.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let project: string;

function pkg(name: string, source: string, type?: 'module'): void {
  const dir = join(project, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js', type }));
  writeFileSync(join(dir, 'index.js'), source);
}

const STORE = `{ kind: 'fixture', get: () => null, put: () => ({ path: 'x', created: true }), update: () => null, list: () => [] }`;

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'knowledge-backend-'));
  writeFileSync(join(project, 'package.json'), '{"name":"adopter","private":true}');
  pkg(
    'ai-sdlc-fixture-backend',
    `exports.seen = [];\nexports.registerKnowledgeBackends = (r) => r.registerKnowledgeBackend('fixture', (cfg, ctx) => { exports.seen.push({ cfg, ctx }); return (${STORE}); });\n`,
  );
  pkg(
    'ai-sdlc-fixture-duplicate',
    `exports.registerKnowledgeBackends = (r) => r.registerKnowledgeBackend('fixture', () => (${STORE}));\n`,
  );
  // AISDLC-1427: an ES-module backend loads through require(esm) (Node >=22.12.0).
  pkg(
    'ai-sdlc-fixture-esm-backend',
    `export function registerKnowledgeBackends(r) { r.registerKnowledgeBackend('fixture-esm', () => (${STORE.replace("'fixture'", "'fixture-esm'")})); }\n`,
    'module',
  );
  pkg('ai-sdlc-fixture-throws', `throw new Error('boom at load');\n`);
  pkg('ai-sdlc-fixture-noexport', `exports.other = 1;\n`);
  pkg(
    'ai-sdlc-fixture-register-throws',
    `exports.registerKnowledgeBackends = () => { throw new Error('register boom'); };\n`,
  );
});
afterAll(() => removeFixtureDir(project));

const open = (backend: string, backendModule: string | null): KnowledgeStore =>
  openKnowledgeStore({ trackedRoot: 'kb', backend, backendModule }, project);

describe('openKnowledgeStore backend selection (DEC-0427)', () => {
  it('returns the files store for backend files', () => {
    expect(open('files', null)).toBeInstanceOf(FilesKnowledgeStore);
  });

  it('refuses a missing backend rather than assuming files', () => {
    const unset = { trackedRoot: 'kb' } as unknown as KnowledgeStoreRoots;
    expect(() => openKnowledgeStore(unset, project)).toThrow(KnowledgeBackendError);
    expect(() => open('', null)).toThrow(/no knowledge backend selected/);
  });

  it('returns the backend a fixture package registers', () => {
    const store = open('fixture', 'ai-sdlc-fixture-backend');
    expect(store).not.toBeInstanceOf(FilesKnowledgeStore);
    expect(store.kind).toBe('fixture');
    // Loading the module again does not re-register (no duplicate error).
    expect(open('fixture', 'ai-sdlc-fixture-backend').kind).toBe('fixture');
  });

  it('returns the backend an ES-module fixture package registers (AISDLC-1427)', () => {
    const store = open('fixture-esm', 'ai-sdlc-fixture-esm-backend');
    expect(store).not.toBeInstanceOf(FilesKnowledgeStore);
    expect(store.kind).toBe('fixture-esm');
  });

  it('passes the factory the config and { projectRoot, options } (AISDLC-1432)', () => {
    const cfg = { trackedRoot: 'kb', backend: 'fixture', backendModule: 'ai-sdlc-fixture-backend' };
    openKnowledgeStore(cfg, project);
    const req = createRequire(join(project, 'package.json'));
    const seen = (req('ai-sdlc-fixture-backend') as { seen: { cfg: unknown; ctx: unknown }[] })
      .seen;
    expect(seen.at(-1)).toEqual({ cfg, ctx: { projectRoot: project, options: null } });
  });

  it('throws for an unregistered name, naming backend and module', () => {
    expect(() => open('remote', null)).toThrow(KnowledgeBackendError);
    expect(() => open('remote', null)).toThrow(/'remote' is not registered.*unset/);
    expect(() => open('remote', 'ai-sdlc-fixture-backend')).toThrow(
      /'remote' is not registered.*'ai-sdlc-fixture-backend'/,
    );
  });

  it.each([
    ['a missing package', 'ai-sdlc-fixture-missing', /failed to load/],
    ['a module that throws on load', 'ai-sdlc-fixture-throws', /boom at load/],
    ['a module without registerKnowledgeBackends', 'ai-sdlc-fixture-noexport', /does not export/],
    ['a register function that throws', 'ai-sdlc-fixture-register-throws', /register boom/],
  ])('throws when the module fails to load: %s', (_label, spec, msg) => {
    expect(() => open('other', spec)).toThrow(KnowledgeBackendError);
    expect(() => open('other2', spec)).toThrow(msg);
  });

  it.each([
    ['relative path', './node_modules/ai-sdlc-fixture-backend'],
    ['parent path', '../evil'],
    ['absolute path', '/tmp/evil.js'],
    ['file URL', 'file:///tmp/evil.js'],
    ['data URL', 'data:text/javascript,export default 1'],
    ['https URL', 'https://example.com/evil.js'],
    ['node builtin', 'node:fs'],
    ['dot-dot subpath', 'x/../../evil.js'],
    ['scoped dot-dot subpath', '@scope/pkg/../../../evil.js'],
    ['dot subpath', 'pkg/./evil.js'],
    ['backslash path', 'pkg\\..\\evil.js'],
  ])('refuses a %s specifier, naming the key', (_label, spec) => {
    expect(() => open('fixture', spec)).toThrow(KnowledgeBackendError);
    expect(() => open('fixture', spec)).toThrow(/knowledge\.backendModule/);
  });

  it('refuses to override the built-in files backend', () => {
    expect(() => registerKnowledgeBackend('files', () => open('files', null))).toThrow(
      KnowledgeBackendError,
    );
  });

  it('refuses a duplicate registration, in process and from a second module', () => {
    registerKnowledgeBackend('dup-in-process', () => open('files', null));
    expect(() => registerKnowledgeBackend('dup-in-process', () => open('files', null))).toThrow(
      /already registered/,
    );
    open('fixture', 'ai-sdlc-fixture-backend');
    expect(() => open('fixture', 'ai-sdlc-fixture-duplicate')).toThrow(KnowledgeBackendError);
  });
});

/** A registered in-process backend that records every `{ projectRoot, options }` it receives. */
const recorded: KnowledgeBackendContext[] = [];
registerKnowledgeBackend('recording', (_cfg, ctx) => {
  recorded.push(ctx);
  return {
    kind: 'recording',
    get: () => null,
    put: () => ({ path: 'memory/x.md', created: true }),
    update: () => null,
    list: () => [],
    listRaw: () => [],
    create: () => Promise.resolve({ id: 'x', path: '', created: false, status: 'rejected' }),
    write: () => Promise.resolve({ id: 'x', path: '', created: false, status: 'rejected' }),
  };
});

function writeContext(dir: string, knowledge: string): string {
  mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
  writeFileSync(join(dir, '.ai-sdlc/context.yaml'), `knowledge:\n${knowledge}`);
  return dir;
}

describe('backend options from context.yaml (AISDLC-1432)', () => {
  let dir: string;
  afterEach(() => removeFixtureDir(dir));

  it('hands the factory the exact knowledge.<backend> mapping, unvalidated', () => {
    dir = writeContext(
      mkdtempSync(join(tmpdir(), 'knowledge-opts-')),
      [
        '  backend: recording',
        '  recording:',
        '    endpoint: https://kb.example.com',
        '    credentialsRef: env:KB_TOKEN',
        '    unknownKey: 7',
        '    nested:',
        '      deep: [a, { b: true }]',
        '',
      ].join('\n'),
    );
    const config = loadKnowledgeConfig(dir);
    const expected = {
      endpoint: 'https://kb.example.com',
      credentialsRef: 'env:KB_TOKEN',
      unknownKey: 7,
      nested: { deep: ['a', { b: true }] },
    };
    expect(config.backendOptions).toEqual(expected);
    recorded.length = 0;
    openKnowledgeStore({ ...backendSelection(config), trackedRoot: 'kb' }, dir);
    expect(recorded).toEqual([{ projectRoot: dir, options: expected }]);
  });

  it('passes null options when the block is absent', () => {
    dir = writeContext(mkdtempSync(join(tmpdir(), 'knowledge-opts-')), '  backend: recording\n');
    const config = loadKnowledgeConfig(dir);
    expect(config.backendOptions).toBeNull();
    recorded.length = 0;
    openKnowledgeStore({ ...backendSelection(config), trackedRoot: 'kb' }, dir);
    expect(recorded).toEqual([{ projectRoot: dir, options: null }]);
  });

  it('carries no options for files, even when a knowledge.files block exists', () => {
    dir = writeContext(
      mkdtempSync(join(tmpdir(), 'knowledge-opts-')),
      '  backend: files\n  files:\n    x: 1\n',
    );
    const config = loadKnowledgeConfig(dir);
    expect(config.backendOptions).toBeNull();
    expect(
      openKnowledgeStore({ ...backendSelection(config), trackedRoot: 'kb' }, dir),
    ).toBeInstanceOf(FilesKnowledgeStore);
  });
});

describe('operations hand a registered backend the project root (AISDLC-1432)', () => {
  let dir: string;
  let elsewhere: string;
  afterEach(() => {
    vi.restoreAllMocks();
    removeFixtureDir(dir);
    removeFixtureDir(elsewhere);
  });

  it('ingest, promote, human and data-room open the store with the project root, not the cwd', async () => {
    dir = writeContext(
      mkdtempSync(join(tmpdir(), 'knowledge-ops-')),
      '  backend: recording\n  recording:\n    endpoint: e\n',
    );
    elsewhere = mkdtempSync(join(tmpdir(), 'knowledge-cwd-'));
    vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);
    const config = loadKnowledgeConfig(dir);
    const sel = backendSelection(config);
    const tracked = join(dir, '.ai-sdlc/knowledge');
    const actor = { by: 'human', principal: 'human:op@example.com' } as const;
    const options = { endpoint: 'e' };
    const opened = async (run: () => Promise<unknown>): Promise<KnowledgeBackendContext[]> => {
      recorded.length = 0;
      await run();
      return [...recorded];
    };
    const once = [{ projectRoot: dir, options }];

    expect(
      await opened(() =>
        ingestSource('tasks', {
          ...sel,
          projectDir: dir,
          trackedRootAbs: tracked,
          ontology: DEFAULT_ONTOLOGY,
          observed: '2026-11-26',
          actor,
        }),
      ),
    ).toEqual(once);
    const verify = { projectDir: dir, config, ontology: DEFAULT_ONTOLOGY } as unknown as Parameters<
      typeof promoteEntry
    >[4];
    expect(
      await opened(() => promoteEntry(sel, tracked, 'a', { to: 'canonical', ...actor }, verify)),
    ).toEqual(once);
    expect(await opened(() => refuteEntry(sel, tracked, 'a', 'wrong', actor, dir))).toEqual(once);
    expect(await opened(() => reobserveEntry(sel, tracked, 'a', 1, actor, undefined, dir))).toEqual(
      once,
    );
    expect(await opened(() => confirmEntry(sel, tracked, 'a', 1, actor, undefined, dir))).toEqual(
      once,
    );
    expect(await opened(() => correctEntry(sel, tracked, 'a', 'v', actor, undefined, dir))).toEqual(
      once,
    );
    expect(
      await opened(() => supersedeEntry(sel, tracked, 'a', 'b', 'v', actor, undefined, dir)),
    ).toEqual(once);
    expect(
      await opened(() =>
        captureFactForProject(dir, {
          id: 'fact-1',
          value: 'v',
          sourceDoc: 'doc.md',
          observed: '2026-11-26',
          principal: actor.principal,
        }),
      ),
    ).toEqual(once);
  });
});

/**
 * A registered backend that supplies the ontology (AISDLC-1435): its trunks come from the
 * `knowledge.supplies-ontology.trunks` option, and every call and write is recorded.
 */
const supplied = { calls: 0, puts: [] as Record<string, unknown>[], tracked: [] as unknown[] };
registerKnowledgeBackend('supplies-ontology', (_cfg, ctx) => {
  const trunks = (ctx.options as { trunks: string[] }).trunks;
  return {
    kind: 'supplies-ontology',
    get: () => null,
    create: (e) => {
      supplied.puts.push(e.fields);
      return Promise.resolve({ id: 'x', path: 'x.md', created: true, status: 'applied' });
    },
    write: () => Promise.resolve({ id: 'x', path: '', created: false, status: 'rejected' }),
    list: () => [],
    listRaw: (scope) =>
      (scope === 'tracked' ? supplied.tracked : []) as ReturnType<KnowledgeStore['listRaw']>,
    ontology: (): Ontology => {
      supplied.calls++;
      return { ...DEFAULT_ONTOLOGY, trunks };
    },
  };
});

describe('a backend may supply the ontology (AISDLC-1435)', () => {
  let dir: string;
  afterEach(() => {
    removeFixtureDir(dir);
    process.exitCode = 0;
  });

  /** A project on the supplying backend whose local ontology.yaml is malformed (unused). */
  function project(trunks: string[]): string {
    dir = writeContext(
      mkdtempSync(join(tmpdir(), 'knowledge-ontology-')),
      `  backend: supplies-ontology\n  supplies-ontology:\n    trunks: [${trunks.join(', ')}]\n`,
    );
    mkdirSync(join(dir, '.ai-sdlc/knowledge'), { recursive: true });
    writeFileSync(join(dir, '.ai-sdlc/knowledge', ONTOLOGY_FILE), 'trunks: nope\n');
    supplied.calls = 0;
    supplied.puts = [];
    supplied.tracked = [];
    return dir;
  }

  it('validateKnowledge checks entries against the supplied ontology, not ontology.yaml', () => {
    project(['shared']);
    const value = 'a shared fact';
    supplied.tracked = [
      {
        scope: 'tracked',
        path: 'shared/a-shared-fact.md',
        parsed: {
          fields: {
            id: 'a-shared-fact',
            trunk: 'shared',
            type: 'fact',
            value,
            confidence: 0.7,
            authority: 'inferred',
            scope: 'internal',
            source: 'NOTES.md#a',
            observed: '2026-11-27',
            decay: 'durable',
            relations: [],
            contentHash: hashValue(value),
          },
          body: '\n',
        },
      },
    ];
    const report = validateKnowledge(dir);
    expect(report.errors).toEqual([]);
    expect(report.entries).toBe(1);
    expect(supplied.calls).toBe(1);
  });

  it('ingest-memory validates notes against the supplied ontology', async () => {
    const mem = join(project(['systems']), 'mem');
    mkdirSync(mem);
    writeFileSync(
      join(mem, 'user_role.md'),
      serializeNote({ name: 'user_role', description: 'role', type: 'user', body: 'b' }),
    );
    await expect(ingestMemoryForProject(dir, mem, '2026-11-27')).rejects.toThrow(
      /unknown trunk 'memory' \(allowed: systems\)/,
    );
    project(['memory']);
    const mem2 = join(dir, 'mem');
    mkdirSync(mem2);
    writeFileSync(
      join(mem2, 'user_role.md'),
      serializeNote({ name: 'user_role', description: 'role', type: 'user', body: 'b' }),
    );
    expect((await ingestMemoryForProject(dir, mem2, '2026-11-27')).created).toBe(1);
    expect(supplied.puts.map((f) => f.trunk)).toEqual(['memory']);
  });

  it('cli-context ingest-sections, ingest and the verify context use the supplied ontology', async () => {
    const cli = (args: string[]) =>
      buildContextCli([...args, '--project-dir', dir])
        .exitProcess(false)
        .fail(false)
        .parseAsync();
    project(['shared']);
    writeFileSync(join(dir, 'NOTES.md'), '# T\n\n## Why\n\nBecause.\n');
    await expect(async () => cli(['ingest-sections', 'NOTES.md'])).rejects.toThrow(
      /unknown trunk 'process' \(allowed: shared\)/,
    );

    project(['process']);
    writeFileSync(join(dir, 'NOTES.md'), '# T\n\n## Why\n\nBecause.\n');
    await cli(['ingest-sections', 'NOTES.md']);
    expect(supplied.puts.map((f) => f.trunk)).toEqual(['process']);
    expect(supplied.calls).toBe(1);

    supplied.calls = 0;
    await cli(['ingest', '--source', 'tasks']);
    expect(supplied.calls).toBe(1);

    supplied.calls = 0;
    await cli(['synthesize']);
    expect(supplied.calls).toBe(1);
  });
});

/** Parse the minimum version out of a `>=X.Y.Z` range. */
function minimumVersion(range: string): [number, number, number] {
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!m) throw new Error(`engines.node '${range}' is not a >=X.Y.Z range`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe('pipeline-cli engines.node (AISDLC-1427)', () => {
  it('declares a minimum of at least 22.12.0, the first Node 22 with unflagged require(esm)', () => {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const { engines } = JSON.parse(readFileSync(manifest, 'utf8')) as {
      engines?: { node?: string };
    };
    expect(engines?.node).toBeDefined();
    const [major, minor] = minimumVersion(engines!.node!);
    expect(major > 22 || (major === 22 && minor >= 12)).toBe(true);
  });

  it('parses only >=X.Y.Z ranges', () => {
    expect(minimumVersion('>=22.12.0')).toEqual([22, 12, 0]);
    expect(() => minimumVersion('^22')).toThrow(/not a >=X.Y.Z range/);
  });
});
