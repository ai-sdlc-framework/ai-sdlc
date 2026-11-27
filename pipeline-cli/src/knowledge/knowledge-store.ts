/**
 * The knowledge-store seam (AISDLC-1418, AISDLC-1419): every entry read and write goes through
 * `KnowledgeStore`.
 *
 * RFC-0053 OQ-2 stands as the open-source default: the entries on disk are the source of truth
 * and `FilesKnowledgeStore` is the only implementation open source ships. The RFC-0053
 * amendment of 2026-11-26 (DEC-0427) adds a registration seam: `knowledge.backend` names a
 * backend that an installed package (`knowledge.backendModule`) registers. Selection fails
 * closed, like `retrieval/registry.ts`: an unregistered backend throws `KnowledgeBackendError`
 * and never falls back to files. Reads (`get`, `list`, `listRaw`) are synchronous; the named
 * writes `create` and `write` are async so a network backend can honour them (AISDLC-1455,
 * DEC-0443). Modelled on the `RetrievalIndex` contract (`retrieval/types.ts`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { dump } from '../util/yaml.js';
import { DEFAULT_KNOWLEDGE_BACKEND, type KnowledgeConfig } from './config.js';
import { parseEntryFile, toEntry, type KnowledgeEntry } from './entry.js';
import { appendKnowledgeEvent, type KnowledgeEventKind } from './log.js';

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

/**
 * The closed set of named write operations (AISDLC-1455, DEC-0443). A server backend
 * authorizes and audits by kind, so adding a kind is an interface change.
 *
 * - `confirm`: a person confirms the entry; `fields` is the patch (confidence, observed).
 * - `correct`: replace the value; `fields` is the patch (value, contentHash, observed).
 * - `supersede`: ONE call. `fields` are the full fields of the new entry; the backend creates
 *   it (linked by `supersedes`) and marks the old entry `status: superseded`.
 * - `promote`: raise authority; `fields` must carry `authority` (the target) and `proof`.
 * - `reobserve`: a fresh observation; `fields` is the patch (confidence, observed).
 * - `refute`: drop authority; `fields` is the patch (normally `authority: inferred`).
 * - `reingest`: a source re-ingest overwrites the entry; `fields` replace all fields.
 * - `excise`: remove the entry outright. The files backend does not support it.
 *
 * `promote`, `supersede`, `confirm` and `excise` are never deferred offline: a backend
 * applies, proposes or rejects them synchronously with the call.
 */
export const WRITE_KINDS = [
  'confirm',
  'correct',
  'supersede',
  'promote',
  'reobserve',
  'refute',
  'reingest',
  'excise',
] as const;

export type WriteKind = (typeof WRITE_KINDS)[number];

export interface WriteOp {
  kind: WriteKind;
  fields: Record<string, unknown>;
  /**
   * Who acted. Recorded in the local knowledge log only; a server backend takes the principal
   * from its own credential and never trusts this value.
   */
  principal: string;
  /** Body of the entry that `supersede` creates or `reingest` writes. Default: kept / empty. */
  body?: string;
}

export interface WriteResult {
  /** The entry written: for `supersede`, the NEW entry. */
  id: string;
  /** Location inside its root; empty when rejected. */
  path: string;
  /** True when a new entry was created (`create`, `supersede`). */
  created: boolean;
  /** `proposed`: queued as a proposal. The files backend returns `applied` or `rejected`. */
  status: 'applied' | 'proposed' | 'rejected';
  /** Why the write was rejected or proposed. */
  reason?: string;
}

export type CreateOptions = PutOptions & { principal: string };

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
  /**
   * Project-relative paths (files or directories) where this backend keeps content locally,
   * such as a replica or cache (AISDLC-1433). `cli-context check-scope` holds each to the
   * protected-root rules: git-ignored, untracked, absent from pushed commits. Optional: the
   * files backend declares none, because its roots are already checked.
   */
  localPaths?(): string[];
  /** Create a new entry; rejected when its location already holds one. Logs `created`. */
  create(
    entry: { fields: Record<string, unknown>; body: string },
    opts: CreateOptions,
  ): Promise<WriteResult>;
  /** Apply a named operation to the entry `id`; logs exactly one event when applied. */
  write(id: string, op: WriteOp, opts?: { scope?: StoreScope }): Promise<WriteResult>;
  /**
   * Refresh the local replica that `list()` reads from the backend's remote source and send
   * queued local writes (AISDLC-1459, DEC-0444). `cli-context sync` calls it, then
   * `rebuildIndex` (the sync contract, DEC-0430). Optional: the files backend has no remote,
   * so it omits it and `cli-context sync` reports `supported: false`.
   */
  sync?(): Promise<{ pulled: number; pushed: number }>;
  /**
   * Writes waiting to reach the remote (`queued`), writes it refused (`rejected`), and the
   * backend's own record of its last sync. `cli-context status` prints it merged with the
   * stamp of the last `cli-context sync`. Optional, like `sync`; the files backend omits it.
   */
  status?(): Promise<{ queued: number; rejected: number; lastSyncAt?: string; lastError?: string }>;
}

const EVENT_OF: Record<WriteKind, KnowledgeEventKind> = {
  confirm: 'confirmed',
  correct: 'corrected',
  supersede: 'superseded',
  promote: 'promoted',
  reobserve: 'reobserved',
  refute: 'refuted',
  reingest: 'reingested',
  excise: 'excised',
};

/** The log `by` role from a principal: `human:<email>` is a human, anything else an agent. */
function roleOf(principal: string): string {
  return principal.startsWith('human:') ? 'human' : 'agent';
}

function isProtected(scope: StoreScope, fields: Record<string, unknown>): boolean {
  const s = typeof fields.scope === 'string' ? fields.scope.trim().toLowerCase() : '';
  return scope === 'protected' || s === 'protected';
}

/** Field names only: the log is committed, so no value (or hash of one) ever enters it. */
function fieldNames(fields: Record<string, unknown>): string {
  const names = Object.keys(fields).sort();
  return names.length === 0 ? 'no fields changed' : `fields: ${names.join(', ')}`;
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

  private writeFile(
    scope: StoreScope,
    path: string,
    fields: Record<string, unknown>,
    body: string,
  ): void {
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
    this.writeFile(opts.scope, path, entry.fields, entry.body);
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
    this.writeFile(e.scope, e.path, e.fields, e.body);
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

  /** The knowledge log sits next to the tracked root; every applied write needs it. */
  private log(
    kind: KnowledgeEventKind,
    id: string,
    principal: string,
    extra: { from?: string; to?: string; proof?: string; detail?: string } = {},
  ): void {
    appendKnowledgeEvent(this.root('tracked'), {
      event: kind,
      id,
      by: roleOf(principal),
      principal,
      ...extra,
    });
  }

  async create(
    entry: { fields: Record<string, unknown>; body: string },
    opts: CreateOptions,
  ): Promise<WriteResult> {
    const id = String(entry.fields.id);
    const path = opts.path ?? join(String(entry.fields.trunk), `${id}.md`);
    if (existsSync(join(this.root(opts.scope), path))) {
      return { id, path: '', created: false, status: 'rejected', reason: `'${path}' exists` };
    }
    this.writeFile(opts.scope, path, entry.fields, entry.body);
    this.log('created', id, opts.principal, {
      detail: isProtected(opts.scope, entry.fields) ? 'protected entry created' : undefined,
    });
    return { id, path, created: true, status: 'applied' };
  }

  async write(id: string, op: WriteOp, opts: { scope?: StoreScope } = {}): Promise<WriteResult> {
    const reject = (reason: string): WriteResult => ({
      id,
      path: '',
      created: false,
      status: 'rejected',
      reason,
    });
    if (!(WRITE_KINDS as readonly string[]).includes(op.kind)) {
      return reject(`unknown write kind '${String(op.kind)}'`);
    }
    if (op.kind === 'excise') return reject('the files backend does not support excise');
    if (op.kind === 'promote' && (!op.fields.authority || !op.fields.proof)) {
      return reject('promote requires the target authority and the proof');
    }
    const e = this.get(id, { scope: opts.scope });
    if (!e) return reject(`entry '${id}' not found`);
    const prot = isProtected(e.scope, e.fields);

    if (op.kind === 'supersede') {
      const newId = String(op.fields.id ?? '');
      if (newId === '') return reject('supersede requires the new entry id');
      if (newId === id) return reject('an entry cannot supersede itself');
      if (typeof op.fields.trunk !== 'string') return reject('supersede requires the new trunk');
      const path = join(op.fields.trunk, `${newId}.md`);
      if (existsSync(join(this.root(e.scope), path))) return reject(`'${path}' exists`);
      const rels = Array.isArray(op.fields.relations)
        ? [...(op.fields.relations as { type: string; target: string }[])]
        : [];
      if (!rels.some((r) => r.type === 'supersedes' && r.target === id)) {
        rels.push({ type: 'supersedes', target: id });
      }
      const fields = { ...op.fields, supersedes: id, relations: rels };
      this.writeFile(e.scope, path, fields, op.body ?? '');
      this.writeFile(e.scope, e.path, { ...e.fields, status: 'superseded' }, e.body);
      this.log('superseded', id, op.principal, { to: newId, detail: `${newId} supersedes ${id}` });
      return { id: newId, path, created: true, status: 'applied' };
    }

    const before = e.fields;
    const fields = op.kind === 'reingest' ? { ...op.fields } : { ...e.fields, ...op.fields };
    this.writeFile(e.scope, e.path, fields, op.kind === 'reingest' ? (op.body ?? e.body) : e.body);
    const extra: { from?: string; to?: string; proof?: string; detail?: string } = {
      detail: `${fieldNames(op.fields)}${prot ? ' (protected; values not logged)' : ''}`,
    };
    if (op.kind === 'promote' || (op.kind === 'refute' && op.fields.authority !== undefined)) {
      extra.from = String(before.authority);
      extra.to = String(op.fields.authority);
    }
    if (op.kind === 'promote') extra.proof = String(op.fields.proof);
    this.log(EVENT_OF[op.kind], id, op.principal, extra);
    return { id, path: e.path, created: false, status: 'applied' };
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
 * The factory of the selected backend, or `null` for the built-in `files` backend. Loads
 * `backendModule` (resolved from `projectRoot`) when set. Throws `KnowledgeBackendError` when
 * no backend is selected, the module fails to load, or the backend is not registered
 * (DEC-0427, fail closed). Does not call the factory.
 */
export function resolveKnowledgeBackend(
  cfg: KnowledgeBackendSelection,
  projectRoot: string,
): KnowledgeBackendFactory | null {
  const backend = (cfg as Partial<KnowledgeBackendSelection>).backend;
  if (typeof backend !== 'string' || backend === '') {
    throw new KnowledgeBackendError(
      'no knowledge backend selected; pass knowledge.backend from the loaded config (refusing to assume files)',
    );
  }
  if (backend === DEFAULT_KNOWLEDGE_BACKEND) return null;
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
  return factory;
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
  const factory = resolveKnowledgeBackend(cfg, projectRoot);
  if (factory === null) return new FilesKnowledgeStore(cfg, projectRoot);
  return factory(cfg, { projectRoot, options: cfg.backendOptions ?? null });
}
