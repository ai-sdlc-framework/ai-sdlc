/**
 * The knowledge-store seam (AISDLC-1418): every entry write goes through `KnowledgeStore`.
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
import { parseEntryFile } from './entry.js';

/** The two RFC-0053 roots: the git-tracked root and the git-ignored protected root. */
export type StoreScope = 'tracked' | 'protected';

export interface StoredEntry {
  fields: Record<string, unknown>;
  /** Everything after the closing `---` line, written back verbatim. */
  body: string;
  scope: StoreScope;
  /** Location of the entry inside its root (files: path relative to the root). */
  path: string;
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
  /** Parseable entries stored directly under one trunk of a root. */
  list(opts: { scope: StoreScope; trunk: string }): StoredEntry[];
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

  list(opts: { scope: StoreScope; trunk: string }): StoredEntry[] {
    const dir = join(this.root(opts.scope), opts.trunk);
    if (!existsSync(dir)) return [];
    const out: StoredEntry[] = [];
    for (const name of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const e = this.read(opts.scope, join(opts.trunk, name));
      if (e) out.push(e);
    }
    return out;
  }
}

/**
 * Open the knowledge store for a `KnowledgeConfig` (or just the roots a caller writes to).
 * Files are the only implementation (RFC-0053 OQ-2); relative roots resolve against
 * `projectRoot`, else the working directory.
 */
export function openKnowledgeStore(cfg: KnowledgeStoreRoots, projectRoot?: string): KnowledgeStore {
  return new FilesKnowledgeStore(cfg, projectRoot);
}
