/**
 * The knowledge-store seam (AISDLC-1418, AISDLC-1419): every entry read and write goes through
 * `KnowledgeStore`.
 *
 * RFC-0053 OQ-2 stands as the open-source default: the entries on disk are the source of truth
 * and `FilesKnowledgeStore` is the only implementation open source ships. The RFC-0053
 * amendment of 2026-11-26 (DEC-0427) adds a registration seam: `knowledge.backend` names a
 * backend that an installed package (`knowledge.backendModule`) registers. Selection fails
 * closed, like `retrieval/registry.ts`: an unregistered backend throws `KnowledgeBackendError`
 * and never falls back to files. The interface is synchronous because every caller is.
 * Modelled on the `RetrievalIndex` contract (`retrieval/types.ts`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { dump } from '../util/yaml.js';
import { DEFAULT_KNOWLEDGE_BACKEND, type KnowledgeConfig } from './config.js';
import { parseEntryFile, toEntry, type KnowledgeEntry } from './entry.js';

/** The two RFC-0053 roots: the git-tracked root and the git-ignored protected root. */
export type StoreScope = 'tracked' | 'protected';

/** A root to list, or every configured root (tracked first). */
export type ListScope = StoreScope | 'all';

export interface StoredEntry {
  fields: Record<string, unknown>;
  /** Everything after the closing `---` line, written back verbatim. */
  body: string;
  scope: StoreScope;
  /** Location of the entry inside its root (files: path relative to the root). */
  path: string;
}

/** One stored file with its parse result, so a validator can report what does not parse. */
export interface RawStoredEntry {
  scope: StoreScope;
  /** Location of the file inside its root (files: path relative to the root). */
  path: string;
  parsed: { fields: Record<string, unknown>; body: string } | { error: string };
}

export interface GetOptions {
  /** Search only this root. Default: tracked, then protected (each when configured). */
  scope?: StoreScope;
  /** Read this location directly instead of searching by id. Requires `scope`. */
  path?: string;
}

export interface PutOptions {
  scope: StoreScope;
  /** Location inside the root. Default `<trunk>/<id>.md`. */
  path?: string;
}

export interface PutResult {
  /** Location inside the root that was written. */
  path: string;
  /** False when an existing entry location was overwritten. */
  created: boolean;
}

export interface KnowledgeStore {
  readonly kind: string;
  /** The entry with this id, or null when none is found (or the addressed file does not parse). */
  get(id: string, opts?: GetOptions): StoredEntry | null;
  /** Create or overwrite an entry. */
  put(entry: { fields: Record<string, unknown>; body: string }, opts: PutOptions): PutResult;
  /** Edit the fields of an existing entry in place; returns the fields as they were before, or null. */
  update(
    id: string,
    edit: (fields: Record<string, unknown>) => void,
    opts?: { scope?: StoreScope },
  ): Record<string, unknown> | null;
  /**
   * Parseable entries: every entry of a root (or of all configured roots) in path order, or,
   * given a trunk, those stored directly under that trunk of one root.
   */
  list(scope: ListScope | { scope: StoreScope; trunk: string }): StoredEntry[];
  /** Every stored file of a root (or of all configured roots) with its parse result or error. */
  listRaw(scope: ListScope): RawStoredEntry[];
}

/**
 * The backend a caller opens. `backend` is required so that no call site can omit it and
 * end up on the files store while another backend is configured (DEC-0427, fail closed).
 */
export type KnowledgeBackendSelection = Pick<KnowledgeConfig, 'backend'> &
  Partial<Pick<KnowledgeConfig, 'backendModule' | 'backendOptions'>>;

/** The files roots a store is opened on. */
export type KnowledgeRoots = Partial<Pick<KnowledgeConfig, 'trackedRoot' | 'protectedRoot'>>;

export type KnowledgeStoreRoots = KnowledgeRoots & KnowledgeBackendSelection;

/** The backend fields of a loaded config, for callers that open a store on their own roots. */
export function backendSelection(config: KnowledgeBackendSelection): KnowledgeBackendSelection {
  return {
    backend: config.backend,
    backendModule: config.backendModule ?? null,
    backendOptions: config.backendOptions ?? null,
  };
}

/** Entries as markdown files with YAML frontmatter under the tracked and protected roots. */
export class FilesKnowledgeStore implements KnowledgeStore {
  readonly kind = 'files';
  private readonly roots: Partial<Record<StoreScope, string>> = {};

  constructor(roots: KnowledgeRoots, projectRoot?: string) {
    const abs = (p: string): string => (projectRoot ? resolve(projectRoot, p) : resolve(p));
    if (roots.trackedRoot) this.roots.tracked = abs(roots.trackedRoot);
    if (roots.protectedRoot) this.roots.protected = abs(roots.protectedRoot);
  }

  private root(scope: StoreScope): string {
    const r = this.roots[scope];
    if (!r) throw new Error(`knowledge store: no ${scope} root configured`);
    return r;
  }

  private scopes(scope?: StoreScope): StoreScope[] {
    if (scope) return [scope];
    return (['tracked', 'protected'] as const).filter((s) => this.roots[s] !== undefined);
  }

  private files(scope: StoreScope, dir: string): string[] {
    const full = join(this.root(scope), dir);
    if (!existsSync(full)) return [];
    const out: string[] = [];
    for (const d of readdirSync(full, { withFileTypes: true })) {
      const rel = dir === '' ? d.name : join(dir, d.name);
      if (d.isDirectory()) out.push(...this.files(scope, rel));
      else if (d.isFile() && d.name.endsWith('.md')) out.push(rel);
    }
    return out;
  }

  private read(scope: StoreScope, path: string): StoredEntry | null {
    const parsed = parseEntryFile(readFileSync(join(this.root(scope), path), 'utf-8'));
    return 'fields' in parsed ? { ...parsed, scope, path } : null;
  }

  private find(scope: StoreScope, dir: string, id: string): StoredEntry | null {
    const full = join(this.root(scope), dir);
    if (!existsSync(full)) return null;
    for (const d of readdirSync(full, { withFileTypes: true })) {
      const rel = dir === '' ? d.name : join(dir, d.name);
      if (d.isDirectory()) {
        const r = this.find(scope, rel, id);
        if (r) return r;
      } else if (d.name.endsWith('.md')) {
        const e = this.read(scope, rel);
        if (e && e.fields.id === id) return e;
      }
    }
    return null;
  }

  private write(scope: StoreScope, path: string, fields: Record<string, unknown>, body: string) {
    const file = join(this.root(scope), path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `---\n${dump(fields)}---\n${body}`);
  }

  get(id: string, opts: GetOptions = {}): StoredEntry | null {
    if (opts.path !== undefined) {
      if (!opts.scope) throw new Error('knowledge store: get by path requires a scope');
      return existsSync(join(this.root(opts.scope), opts.path))
        ? this.read(opts.scope, opts.path)
        : null;
    }
    for (const scope of this.scopes(opts.scope)) {
      const e = this.find(scope, '', id);
      if (e) return e;
    }
    return null;
  }

  put(entry: { fields: Record<string, unknown>; body: string }, opts: PutOptions): PutResult {
    const path = opts.path ?? join(String(entry.fields.trunk), `${String(entry.fields.id)}.md`);
    const created = !existsSync(join(this.root(opts.scope), path));
    this.write(opts.scope, path, entry.fields, entry.body);
    return { path, created };
  }

  update(
    id: string,
    edit: (fields: Record<string, unknown>) => void,
    opts: { scope?: StoreScope } = {},
  ): Record<string, unknown> | null {
    const e = this.get(id, { scope: opts.scope });
    if (!e) return null;
    const before = { ...e.fields };
    edit(e.fields);
    this.write(e.scope, e.path, e.fields, e.body);
    return before;
  }

  list(scope: ListScope | { scope: StoreScope; trunk: string }): StoredEntry[] {
    if (typeof scope === 'string') {
      return this.listRaw(scope).flatMap((r) =>
        'fields' in r.parsed ? [{ ...r.parsed, scope: r.scope, path: r.path }] : [],
      );
    }
    const opts = scope;
    const dir = join(this.root(opts.scope), opts.trunk);
    if (!existsSync(dir)) return [];
    const out: StoredEntry[] = [];
    for (const name of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const e = this.read(opts.scope, join(opts.trunk, name));
      if (e) out.push(e);
    }
    return out;
  }

  listRaw(scope: ListScope): RawStoredEntry[] {
    const scopes = scope === 'all' ? this.scopes() : [scope];
    return scopes.flatMap((s) =>
      this.files(s, '')
        .sort()
        .map((path) => ({
          scope: s,
          path,
          parsed: parseEntryFile(readFileSync(join(this.root(s), path), 'utf-8')),
        })),
    );
  }
}

/** The domain view of stored entries. */
export function toEntries(stored: StoredEntry[]): KnowledgeEntry[] {
  return stored.map((e) => toEntry(e.fields, e.body));
}

/** Raised whenever a non-files backend cannot be selected; never a silent fall-back to files. */
export class KnowledgeBackendError extends Error {
  override name = 'KnowledgeBackendError';
}

/** What a registered factory receives besides the roots (AISDLC-1432). */
export interface KnowledgeBackendContext {
  /** The project the store is opened for; relative roots resolve against it. */
  projectRoot: string;
  /**
   * The raw `knowledge.<backend>` block of `.ai-sdlc/context.yaml`, unvalidated (the backend
   * owns validation); `null` or undefined when the block is absent.
   */
  options: unknown;
}

export type KnowledgeBackendFactory = (
  cfg: KnowledgeStoreRoots,
  ctx: KnowledgeBackendContext,
) => KnowledgeStore;

/** What a `knowledge.backendModule` package receives in `registerKnowledgeBackends(registry)`. */
export interface KnowledgeBackendRegistry {
  registerKnowledgeBackend(name: string, factory: KnowledgeBackendFactory): void;
}

const backends = new Map<string, KnowledgeBackendFactory>();
/**
 * `backendModule` specifiers whose `registerKnowledgeBackends` already ran in this process.
 * Keyed by specifier, so a library call that resolves from the working directory reuses the
 * module the CLI loaded from the project root.
 */
const loadedModules = new Set<string>();

/** Register a store backend by name. `files` is built in; a name registered twice is an error. */
export function registerKnowledgeBackend(name: string, factory: KnowledgeBackendFactory): void {
  if (name === DEFAULT_KNOWLEDGE_BACKEND) {
    throw new KnowledgeBackendError(
      `knowledge backend '${DEFAULT_KNOWLEDGE_BACKEND}' is built in and cannot be overridden`,
    );
  }
  if (backends.has(name)) {
    throw new KnowledgeBackendError(`knowledge backend '${name}' is already registered`);
  }
  backends.set(name, factory);
}

/**
 * Refuse anything but a bare npm package specifier: no relative or absolute path, no
 * `file:`/`data:` or other URL scheme (a colon also rules out `node:` and drive letters).
 */
/** An npm package name (optionally scoped) with an optional subpath; `.`/`..` segments refused. */
const BARE_SPECIFIER = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.-]+)*$/i;

function assertBareSpecifier(spec: string, backend: string): void {
  const dotSegment = spec.split('/').some((seg) => seg === '.' || seg === '..');
  if (!BARE_SPECIFIER.test(spec) || dotSegment) {
    throw new KnowledgeBackendError(
      `knowledge.backendModule '${spec}' (backend '${backend}') must be a bare npm package specifier; ` +
        'relative paths, absolute paths and URL specifiers are refused',
    );
  }
}

function loadBackendModule(spec: string, backend: string, projectRoot: string): void {
  assertBareSpecifier(spec, backend);
  if (loadedModules.has(spec)) return;
  let mod: { registerKnowledgeBackends?: unknown };
  try {
    const req = createRequire(join(projectRoot, 'package.json'));
    mod = req(req.resolve(spec)) as { registerKnowledgeBackends?: unknown };
  } catch (err) {
    throw new KnowledgeBackendError(
      `knowledge backend '${backend}': knowledge.backendModule '${spec}' failed to load: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (typeof mod.registerKnowledgeBackends !== 'function') {
    throw new KnowledgeBackendError(
      `knowledge backend '${backend}': knowledge.backendModule '${spec}' does not export registerKnowledgeBackends(registry)`,
    );
  }
  const registry: KnowledgeBackendRegistry = { registerKnowledgeBackend };
  try {
    (mod.registerKnowledgeBackends as (r: KnowledgeBackendRegistry) => void)(registry);
  } catch (err) {
    if (err instanceof KnowledgeBackendError) throw err;
    throw new KnowledgeBackendError(
      `knowledge backend '${backend}': registerKnowledgeBackends in '${spec}' threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  loadedModules.add(spec);
}

/**
 * Open the knowledge store for a `KnowledgeConfig` (or the roots a caller writes to plus the
 * configured backend). `backend` is required: a missing one throws rather than picking files.
 * `files` gives `FilesKnowledgeStore` (no backend options); relative roots resolve against
 * `projectRoot`. Any other backend must be registered, by `backendModule` (resolved from
 * `projectRoot`) or in process, and its factory receives `{ projectRoot, options }`;
 * otherwise this throws `KnowledgeBackendError` naming the backend and the module
 * (DEC-0427, fail closed). `projectRoot` is required: no store opens without its project.
 */
export function openKnowledgeStore(cfg: KnowledgeStoreRoots, projectRoot: string): KnowledgeStore {
  const backend = (cfg as Partial<KnowledgeStoreRoots>).backend;
  if (typeof backend !== 'string' || backend === '') {
    throw new KnowledgeBackendError(
      'no knowledge backend selected; pass knowledge.backend from the loaded config (refusing to assume files)',
    );
  }
  if (backend === DEFAULT_KNOWLEDGE_BACKEND) return new FilesKnowledgeStore(cfg, projectRoot);
  const spec = cfg.backendModule ?? null;
  if (spec !== null) loadBackendModule(spec, backend, projectRoot);
  const factory = backends.get(backend);
  if (!factory) {
    throw new KnowledgeBackendError(
      `knowledge backend '${backend}' is not registered (knowledge.backendModule: ${
        spec === null ? 'unset' : `'${spec}'`
      }); refusing to fall back to files`,
    );
  }
  return factory(cfg, { projectRoot, options: cfg.backendOptions ?? null });
}
