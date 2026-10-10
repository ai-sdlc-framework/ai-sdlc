/**
 * The tree-sitter {@link StructuralProvider}: Stage 1 facts for the staged review, and the
 * dependency query behind a `trace` probe.
 *
 * For changed files and line ranges at a commit it reports the declarations whose range
 * intersects a changed range, their callers and callees found BY NAME in the tracked files of
 * the same language family, and the test files that reference them.
 *
 * Trust and bounds:
 *   - File content is read from the git object at the commit (`git ls-tree` then
 *     `git cat-file blob`), and candidate files are found with `git grep` at that commit. A
 *     file that is not tracked at the commit (a gitignored `.env`, say) is never opened.
 *   - There are caps on files parsed, bytes per file and results per symbol, and a wall-clock
 *     budget per operation. Each is recorded when it bites (see {@link ProviderReport}).
 *   - A changed file whose facts cannot be produced is `unavailable` with one distinct
 *     reason: `not-tracked`, `no-grammar`, `file-too-large`, `parse-error`, `budget-exceeded`,
 *     `file-cap` or `git-error`. Nothing is thrown out of the provider.
 *
 * @module review-risk-map/tree-sitter-provider
 */

import { Parser } from 'web-tree-sitter';
import type { Language } from 'web-tree-sitter';
import {
  FULL_SHA,
  resolvePinnedHead,
  runGit,
  type GitRunner,
} from '../review-plan/executor-git.js';
import { extractFileFacts, type FileFacts } from './tree-sitter-extract.js';
import {
  GrammarLoader,
  isTestPath,
  languageForPath,
  type GrammarId,
  type LanguageFamily,
  type LanguageSpec,
} from './tree-sitter-languages.js';
import type { HunkStructuralFacts, StructuralHunkRef, StructuralProvider } from './structural.js';

/** Why a file's structural facts are unavailable. Each value is distinct. */
export type UnavailableReason =
  | 'not-tracked'
  | 'no-grammar'
  | 'file-too-large'
  | 'parse-error'
  | 'budget-exceeded'
  | 'file-cap'
  | 'git-error';

export interface StructuralLimits {
  /** Most files parsed over the provider's life (changed files and candidate files). */
  maxFilesParsed: number;
  /** A file larger than this is not read. */
  maxBytesPerFile: number;
  /** Most callers, callees or referencing tests listed per symbol. */
  maxResultsPerSymbol: number;
  /** Wall-clock budget for one operation (one hunk, or one dependency query). */
  parseBudgetMs: number;
  /** Most names handed to one `git grep`. */
  maxSearchNames: number;
}

export const DEFAULT_STRUCTURAL_LIMITS: StructuralLimits = {
  maxFilesParsed: 200,
  maxBytesPerFile: 512 * 1024,
  maxResultsPerSymbol: 50,
  parseBudgetMs: 10_000,
  maxSearchNames: 100,
};

export interface TreeSitterProviderOptions {
  repoRoot: string;
  /** Commit the facts describe. Defaults to the repository's `HEAD`, resolved on first use. */
  commit?: string;
  limits?: Partial<StructuralLimits>;
  /** Points a grammar at a WASM file other than the installed one. */
  grammarPaths?: Partial<Record<GrammarId, string>>;
  /** Runs git. Default: `execFile` with a scrubbed environment. */
  git?: GitRunner;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
}

export interface LineRange {
  /** 1-based, inclusive. */
  start: number;
  end: number;
}

export interface ChangedFile {
  file: string;
  /** Changed line ranges. Absent means every declaration in the file. */
  ranges?: readonly LineRange[];
  /** Only declarations with these bare names. */
  names?: readonly string[];
}

export interface SymbolFacts {
  name: string;
  qualified: string;
  kind: string;
  startLine: number;
  endLine: number;
  callers: string[];
  callees: string[];
  referencingTests: string[];
  /** What was cut: `callers`, `callees` or `referencingTests` hit the per-symbol cap. */
  truncated: string[];
}

export type FileAnalysis =
  | { file: string; status: 'available'; symbols: SymbolFacts[] }
  | { file: string; status: 'unavailable'; reason: UnavailableReason };

/** What the provider has recorded: per-file outcomes, skipped candidates, truncations. */
export interface ProviderReport {
  /** Latest outcome per changed file. */
  files: Record<
    string,
    { status: 'available' } | { status: 'unavailable'; reason: UnavailableReason }
  >;
  /** Candidate files that could not be searched for callers, with the reason. */
  skippedCandidates: { file: string; reason: UnavailableReason }[];
  /** Markers for every cap that cut results: `callers-truncated:<symbol>`, `files-parsed-cap`, ... */
  truncations: string[];
}

type Parsed =
  | { ok: true; facts: FileFacts }
  | { ok: false; reason: Exclude<UnavailableReason, 'not-tracked' | 'file-cap' | 'git-error'> };

interface TreeEntry {
  oid: string;
  size: number;
}

interface Operation {
  deadline: number;
}

const GIT_TIMEOUT_MS = 30_000;
const TREE_LIST_MAX_BYTES = 64 * 1024 * 1024;
const GREP_MAX_BYTES = 8 * 1024 * 1024;

/** Keeps only the innermost declarations among those that intersect a change. */
function innermost<T extends { startLine: number; endLine: number }>(items: T[]): T[] {
  return items.filter(
    (d) =>
      !items.some(
        (e) =>
          e !== d &&
          e.startLine >= d.startLine &&
          e.endLine <= d.endLine &&
          (e.startLine > d.startLine || e.endLine < d.endLine),
      ),
  );
}

export class TreeSitterStructuralProvider implements StructuralProvider {
  private readonly limits: StructuralLimits;
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly grammars: GrammarLoader;
  private commit: string | undefined;
  private tree: Promise<Map<string, TreeEntry> | undefined> | undefined;
  private readonly parsed = new Map<string, Parsed>();
  private filesParsed = 0;
  private readonly rep: ProviderReport = { files: {}, skippedCandidates: [], truncations: [] };

  constructor(private readonly opts: TreeSitterProviderOptions) {
    this.limits = { ...DEFAULT_STRUCTURAL_LIMITS, ...opts.limits };
    this.git = opts.git ?? runGit;
    this.now = opts.now ?? Date.now;
    this.grammars = new GrammarLoader(opts.grammarPaths);
    this.commit = opts.commit;
  }

  /** What the provider recorded so far. */
  report(): ProviderReport {
    return {
      files: { ...this.rep.files },
      skippedCandidates: [...this.rep.skippedCandidates],
      truncations: [...this.rep.truncations],
    };
  }

  async factsFor(hunk: StructuralHunkRef): Promise<HunkStructuralFacts | undefined> {
    const [analysis] = await this.analyzeChanges([
      { file: hunk.file, ranges: [{ start: hunk.startLine, end: hunk.endLine }] },
    ]);
    if (!analysis || analysis.status !== 'available') return undefined;
    const uniq = (xs: string[]): string[] => [...new Set(xs)];
    const symbols = analysis.symbols;
    return {
      symbols: uniq(symbols.map((s) => s.qualified)),
      callers: uniq(symbols.flatMap((s) => s.callers)),
      callees: uniq(symbols.flatMap((s) => s.callees)),
      referencingTests: uniq(symbols.flatMap((s) => s.referencingTests)),
      coverageLines: [],
      schemaConsumers: [],
    };
  }

  /**
   * Facts for changed files and line ranges at the commit. Never throws: a file whose facts
   * cannot be produced comes back `unavailable` with a reason.
   */
  async analyzeChanges(changes: readonly ChangedFile[]): Promise<FileAnalysis[]> {
    const op: Operation = { deadline: this.now() + this.limits.parseBudgetMs };
    const out: FileAnalysis[] = [];
    try {
      const tree = await this.treeAtCommit();
      for (const change of changes) {
        const a = await this.analyzeOne(change, tree, op);
        this.rep.files[change.file] =
          a.status === 'available'
            ? { status: 'available' }
            : { status: 'unavailable', reason: a.reason };
        out.push(a);
      }
    } catch {
      // Defensive: nothing may escape the provider.
      return changes.map((c) => ({
        file: c.file,
        status: 'unavailable' as const,
        reason: 'git-error' as const,
      }));
    }
    return out;
  }

  /**
   * The dependency query a `trace` probe calls: callers, callees and referencing tests for the
   * named symbols (in the named files, or wherever the symbols are declared), as plain text.
   */
  async queryDependencies(q: {
    symbols: readonly string[];
    files: readonly string[];
  }): Promise<string> {
    try {
      const names = [...new Set(q.symbols)].slice(0, this.limits.maxSearchNames);
      let files = [...new Set(q.files)];
      const notes: string[] = [];
      if (files.length === 0 && names.length > 0) {
        files = await this.findDefiningFiles(names, notes);
      }
      if (files.length === 0) {
        return ['No tracked file declares the requested symbols.', ...notes].join('\n');
      }
      const analyses = await this.analyzeChanges(
        files.map((file) => ({ file, ...(names.length > 0 ? { names } : {}) })),
      );
      return [...renderAnalyses(analyses), ...notes].join('\n');
    } catch {
      return 'The dependency query failed; no dependency data is available.';
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private treeAtCommit(): Promise<Map<string, TreeEntry> | undefined> {
    this.tree ??= this.loadTree();
    return this.tree;
  }

  private async loadTree(): Promise<Map<string, TreeEntry> | undefined> {
    try {
      const commit = this.commit ?? (await resolvePinnedHead(this.git, this.opts.repoRoot));
      if (!commit || !FULL_SHA.test(commit)) return undefined;
      this.commit = commit;
      const r = await this.git(['ls-tree', '-r', '-l', '-z', commit], {
        cwd: this.opts.repoRoot,
        maxBytes: TREE_LIST_MAX_BYTES,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (r.truncated) return undefined;
      const map = new Map<string, TreeEntry>();
      for (const entry of r.stdout.toString('utf8').split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab < 0) continue;
        const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
        // Regular files only: symlinks (120000) and gitlinks (160000) are left out.
        if ((mode === '100644' || mode === '100755') && type === 'blob' && oid && size) {
          map.set(entry.slice(tab + 1), { oid, size: Number(size) });
        }
      }
      return map;
    } catch {
      return undefined;
    }
  }

  private overBudget(op: Operation): boolean {
    return this.now() >= op.deadline;
  }

  private note(marker: string): void {
    if (!this.rep.truncations.includes(marker)) this.rep.truncations.push(marker);
  }

  /** Parse a tracked file, caching the result. `undefined` entry means it is not tracked. */
  private async parseFile(
    path: string,
    entry: TreeEntry,
    spec: LanguageSpec,
    op: Operation,
  ): Promise<Parsed | 'file-cap' | 'git-error'> {
    const cached = this.parsed.get(path);
    if (cached) return cached;
    if (this.overBudget(op)) return { ok: false, reason: 'budget-exceeded' };
    if (!(entry.size <= this.limits.maxBytesPerFile))
      return { ok: false, reason: 'file-too-large' };
    if (this.filesParsed >= this.limits.maxFilesParsed) {
      this.note('files-parsed-cap');
      return 'file-cap';
    }
    const language = await this.grammars.load(spec);
    if (!language) return { ok: false, reason: 'no-grammar' };

    let source: string;
    try {
      const blob = await this.git(['cat-file', 'blob', entry.oid], {
        cwd: this.opts.repoRoot,
        maxBytes: this.limits.maxBytesPerFile + 1,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (blob.truncated) return { ok: false, reason: 'file-too-large' };
      source = blob.stdout.toString('utf8');
    } catch {
      return 'git-error';
    }

    this.filesParsed++;
    const result = this.parseSource(source, language, spec.family, op);
    // A budget cut is a property of this operation, not of the file: do not cache it.
    if (!result.ok && result.reason === 'budget-exceeded') return result;
    this.parsed.set(path, result);
    return result;
  }

  private parseSource(
    source: string,
    language: Language,
    family: LanguageFamily,
    op: Operation,
  ): Parsed {
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const tree = parser.parse(source, null, {
        // Returning true cancels the parse; the cast is because the type says void.
        progressCallback: (() => this.overBudget(op)) as unknown as () => void,
      });
      if (!tree) {
        return { ok: false, reason: this.overBudget(op) ? 'budget-exceeded' : 'parse-error' };
      }
      try {
        if (tree.rootNode.hasError) return { ok: false, reason: 'parse-error' };
        return { ok: true, facts: extractFileFacts(tree.rootNode, family) };
      } finally {
        tree.delete();
      }
    } catch {
      return { ok: false, reason: 'parse-error' };
    } finally {
      parser.delete();
    }
  }

  /** Tracked files at the commit that mention any of `names` as a whole word. */
  private async grep(names: readonly string[]): Promise<string[] | undefined> {
    const commit = this.commit;
    if (!commit || names.length === 0) return [];
    const args = ['grep', '-l', '-z', '-I', '-F', '-w'];
    for (const n of names) args.push('-e', n);
    args.push(commit, '--');
    try {
      const r = await this.git(args, {
        cwd: this.opts.repoRoot,
        maxBytes: GREP_MAX_BYTES,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (r.truncated) this.note('grep-output-cap');
      const prefix = `${commit}:`;
      return r.stdout
        .toString('utf8')
        .split('\0')
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length))
        .sort();
    } catch (err) {
      // `git grep` exits 1 when nothing matches, which is an answer, not a failure.
      const code = (err as { code?: unknown }).code;
      return code === 1 ? [] : undefined;
    }
  }

  private async findDefiningFiles(names: readonly string[], notes: string[]): Promise<string[]> {
    await this.treeAtCommit();
    const hits = await this.grep(names);
    if (hits === undefined) {
      notes.push('The repository search failed.');
      return [];
    }
    const out: string[] = [];
    for (const f of hits) {
      if (isTestPath(f) || !languageForPath(f)) continue;
      out.push(f);
      if (out.length >= this.limits.maxFilesParsed) {
        this.note('files-parsed-cap');
        break;
      }
    }
    return out;
  }

  private async analyzeOne(
    change: ChangedFile,
    tree: Map<string, TreeEntry> | undefined,
    op: Operation,
  ): Promise<FileAnalysis> {
    const file = change.file;
    const bad = (reason: UnavailableReason): FileAnalysis => ({
      file,
      status: 'unavailable',
      reason,
    });
    if (!tree) return bad('git-error');
    const entry = tree.get(file);
    if (!entry) return bad('not-tracked');
    const spec = languageForPath(file);
    if (!spec) return bad('no-grammar');

    const parsed = await this.parseFile(file, entry, spec, op);
    if (parsed === 'file-cap') return bad('file-cap');
    if (parsed === 'git-error') return bad('git-error');
    if (!parsed.ok) return bad(parsed.reason);

    const names = change.names ? new Set(change.names) : undefined;
    const inRange = parsed.facts.declarations.filter((d) => {
      if (names && !names.has(d.name)) return false;
      if (!change.ranges) return true;
      return change.ranges.some((r) => d.startLine <= r.end && d.endLine >= r.start);
    });
    // A change inside a method is a change to the method, not to its whole class.
    const decls = change.ranges ? innermost(inRange) : inRange;
    if (decls.length === 0) return { file, status: 'available', symbols: [] };

    // Names to search the rest of the repository for: the symbols, and what they call.
    const calleesByDecl = decls.map((d) => {
      const seen = new Set<string>();
      for (const c of parsed.facts.calls) {
        if (c.line >= d.startLine && c.line <= d.endLine && c.name !== d.name) seen.add(c.name);
      }
      return [...seen].sort();
    });
    const searchNames = [...new Set([...decls.map((d) => d.name), ...calleesByDecl.flat()])].slice(
      0,
      this.limits.maxSearchNames,
    );
    if (searchNames.length >= this.limits.maxSearchNames) this.note('search-names-cap');

    const hits = await this.grep(searchNames);
    if (hits === undefined) return bad('git-error');
    const candidates = new Map<string, FileFacts>();
    candidates.set(file, parsed.facts);
    const tests = new Set<string>();
    for (const hit of hits) {
      if (hit === file) continue;
      if (isTestPath(hit)) {
        tests.add(hit);
        continue;
      }
      const hitSpec = languageForPath(hit);
      const hitEntry = tree.get(hit);
      if (!hitSpec || hitSpec.family !== spec.family || !hitEntry) continue;
      const p = await this.parseFile(hit, hitEntry, hitSpec, op);
      if (p === 'file-cap' || p === 'git-error') {
        this.rep.skippedCandidates.push({
          file: hit,
          reason: p === 'file-cap' ? 'file-cap' : 'git-error',
        });
      } else if (p.ok) {
        candidates.set(hit, p.facts);
      } else {
        this.rep.skippedCandidates.push({ file: hit, reason: p.reason });
      }
    }

    const cap = this.limits.maxResultsPerSymbol;
    const symbols: SymbolFacts[] = decls.map((d, i) => {
      const truncated: string[] = [];
      const callers = new Set<string>();
      for (const [path, facts] of candidates) {
        for (const c of facts.calls) {
          if (c.name !== d.name) continue;
          // Recursion inside the symbol itself is not a caller.
          if (path === file && c.line >= d.startLine && c.line <= d.endLine) continue;
          callers.add(`${path}#${c.enclosing}`);
        }
      }
      const callees = resolveCallees(calleesByDecl[i] ?? [], candidates);
      const referencing = [...tests].sort();
      const fit = (label: string, xs: string[]): string[] => {
        if (xs.length <= cap) return xs;
        truncated.push(label);
        this.note(`${label}-truncated:${d.qualified}`);
        return xs.slice(0, cap);
      };
      return {
        name: d.name,
        qualified: d.qualified,
        kind: d.kind,
        startLine: d.startLine,
        endLine: d.endLine,
        callers: fit('callers', [...callers].sort()),
        callees: fit('callees', callees),
        referencingTests: fit('referencingTests', referencing),
        truncated,
      };
    });
    return { file, status: 'available', symbols };
  }
}

/** Callees that resolve to a declaration in a searched file come first, as `path#name`. */
function resolveCallees(names: readonly string[], files: ReadonlyMap<string, FileFacts>): string[] {
  const resolved: string[] = [];
  const bare: string[] = [];
  for (const name of names) {
    let where: string | undefined;
    for (const [path, facts] of files) {
      if (facts.declarations.some((d) => d.name === name && d.kind !== 'const')) {
        where = path;
        break;
      }
    }
    if (where) resolved.push(`${where}#${name}`);
    else bare.push(name);
  }
  return [...resolved, ...bare];
}

function renderAnalyses(analyses: readonly FileAnalysis[]): string[] {
  const lines: string[] = [];
  for (const a of analyses) {
    if (a.status === 'unavailable') {
      lines.push(`${a.file}: unavailable (${a.reason})`);
      continue;
    }
    if (a.symbols.length === 0) lines.push(`${a.file}: no matching declarations`);
    for (const s of a.symbols) {
      lines.push(`symbol ${s.qualified} (${s.kind}, ${a.file}:${s.startLine}-${s.endLine})`);
      const section = (label: string, xs: string[]): void => {
        lines.push(`  ${label}:${xs.length === 0 ? ' none' : ''}`);
        for (const x of xs) lines.push(`    ${x}`);
      };
      section('callers', s.callers);
      section('callees', s.callees);
      section('tests referencing it', s.referencingTests);
      for (const t of s.truncated) lines.push(`  [${t} truncated at the per-symbol cap]`);
    }
  }
  lines.push('Callers and callees are matched by name, not by type; some may be false positives.');
  return lines;
}

/**
 * The `dependencyQuery` hook for the review executor (`ExecutorHooks.dependencyQuery`).
 * With it wired, a `trace` probe is executed and receives callers and callees as fenced
 * data. Each query reads the repository's current `HEAD` (or `base.commit`) afresh, so a
 * long-lived hook never answers from a stale commit.
 */
export function createTreeSitterDependencyQuery(
  base: Omit<TreeSitterProviderOptions, 'repoRoot'> = {},
): (query: {
  symbols: readonly string[];
  files: readonly string[];
  repoRoot: string;
}) => Promise<string> {
  return (query) =>
    new TreeSitterStructuralProvider({ ...base, repoRoot: query.repoRoot }).queryDependencies({
      symbols: query.symbols,
      files: query.files,
    });
}
