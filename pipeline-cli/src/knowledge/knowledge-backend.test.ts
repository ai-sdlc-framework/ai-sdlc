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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FilesKnowledgeStore,
  KnowledgeBackendError,
  openKnowledgeStore,
  registerKnowledgeBackend,
  type KnowledgeStore,
  type KnowledgeStoreRoots,
} from './knowledge-store.js';
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
    `exports.seen = [];\nexports.registerKnowledgeBackends = (r) => r.registerKnowledgeBackend('fixture', (cfg, root) => { exports.seen.push({ cfg, root }); return (${STORE}); });\n`,
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

  it('passes the factory the config and the project root it was opened with', () => {
    const cfg = { trackedRoot: 'kb', backend: 'fixture', backendModule: 'ai-sdlc-fixture-backend' };
    openKnowledgeStore(cfg, project);
    const req = createRequire(join(project, 'package.json'));
    const seen = (req('ai-sdlc-fixture-backend') as { seen: { cfg: unknown; root: string }[] })
      .seen;
    expect(seen.at(-1)).toEqual({ cfg, root: project });
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
