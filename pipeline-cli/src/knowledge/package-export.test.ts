/**
 * AISDLC-1422: `@ai-sdlc/pipeline-cli/knowledge` is the published seam a
 * `knowledge.backendModule` package builds against. The import goes through the package name,
 * so Node resolves it with this package's own `exports` map into the built `dist`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as {
  name: string;
  exports: Record<string, { types: string; import: string }>;
};

const RUNTIME_NAMES = [
  'KnowledgeBackendError',
  'openKnowledgeStore',
  'registerKnowledgeBackend',
  'WRITE_KINDS',
];
const TYPE_NAMES = [
  'KnowledgeStore',
  'KnowledgeEntry',
  'KnowledgeRelation',
  'StoredEntry',
  'RawStoredEntry',
  'StoreScope',
  'ListScope',
  'GetOptions',
  'KnowledgeEvent',
  'KnowledgeEventKind',
  'KnowledgeBackendRegistry',
  'KnowledgeBackendFactory',
  'KnowledgeStoreRoots',
  'WriteKind',
  'WriteOp',
  'WriteResult',
  'CreateOptions',
];
const INTERNAL = /ingest|promot|retriev/i;

describe('@ai-sdlc/pipeline-cli/knowledge', () => {
  it('declares the subpath with types and import entries in dist', () => {
    expect(pkg.exports['./knowledge']).toEqual({
      types: './dist/knowledge/index.d.ts',
      import: './dist/knowledge/index.js',
    });
  });

  it('exports the seam runtime values by package name and no internals', () => {
    const script =
      `const m = await import(${JSON.stringify(`${pkg.name}/knowledge`)});` +
      'console.log(JSON.stringify(Object.keys(m).sort()));';
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: pkgRoot,
      encoding: 'utf-8',
    });
    expect(r.stderr).toBe('');
    const keys = JSON.parse(r.stdout) as string[];
    expect(keys).toEqual([...RUNTIME_NAMES].sort());
    expect(keys.filter((k) => INTERNAL.test(k))).toEqual([]);
  });

  it('declares the seam types and no internals', () => {
    const dts = readFileSync(join(pkgRoot, pkg.exports['./knowledge'].types), 'utf-8');
    const exported = [...dts.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)]
      .flatMap((m) => m[1].split(','))
      .map((s) => s.replace(/^\s*type\s+/, '').trim())
      .filter(Boolean);
    for (const name of [...RUNTIME_NAMES, ...TYPE_NAMES]) expect(exported).toContain(name);
    expect(exported.filter((k) => INTERNAL.test(k))).toEqual([]);
  });
});
