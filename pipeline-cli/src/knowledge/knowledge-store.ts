/**
 * The knowledge-store seam (AISDLC-1418, AISDLC-1419): every entry read and write goes through
 * `KnowledgeStore`.
 *
 * RFC-0053 OQ-2 stands: the entries on disk remain the source of truth. `FilesKnowledgeStore`
 * is therefore the only implementation, and `openKnowledgeStore` returns it unconditionally;
 * there is no backend key and no adapter registry. The interface is synchronous because every
 * caller is; whether it becomes asynchronous is part of a separate RFC-0053 amendment decision.
 * Modelled on the `RetrievalIndex` contract (`retrieval/types.ts`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dump } from '../util/yaml.js';
import type { KnowledgeConfig } from './config.js';
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

export type KnowledgeStoreRoots = Partial<Pick<KnowledgeConfig, 'trackedRoot' | 'protectedRoot'>>;

/** Entries as markdown files with YAML frontmatter under the tracked and protected roots. */
export class FilesKnowledgeStore implements KnowledgeStore {
  readonly kind = 'files';
  private readonly roots: Partial<Record<StoreScope, string>> = {};

  constructor(roots: KnowledgeStoreRoots, projectRoot?: string) {
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

/**
 * Open the knowledge store for a `KnowledgeConfig` (or just the roots a caller writes to).
 * Files are the only implementation (RFC-0053 OQ-2); relative roots resolve against
 * `projectRoot`, else the working directory.
 */
export function openKnowledgeStore(cfg: KnowledgeStoreRoots, projectRoot?: string): KnowledgeStore {
  return new FilesKnowledgeStore(cfg, projectRoot);
}
