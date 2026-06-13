/**
 * RFC-0014 Phase 1 — dependency-graph snapshot artifact.
 *
 * The snapshot is the bridge from AISDLC-117's in-memory graph to the
 * downstream composition layers (PPA priority, DoR blast-radius surfacing,
 * Slack/dashboard digests). Each tick the orchestrator (or an operator
 * running `cli-deps snapshot`) can serialise the current graph as JSONL —
 * one line per task — under `$ARTIFACTS_DIR/_deps/snapshot.<iso>.<tag>.jsonl`.
 *
 * The artifact is **derived** (rebuildable from `backlog/` at any time);
 * snapshots only exist as a stable, append-only record consumers can diff
 * over time without re-walking the on-disk graph.
 *
 * Per RFC-0014 §12 Q6 the writer follows a "best-effort consistency,
 * validated by consumer" contract — `buildDependencyGraph` walks
 * `backlog/tasks/` + `backlog/completed/` sequentially and reads each file
 * atomically. If an edit lands mid-walk, the resulting snapshot may include
 * a dangling edge; consumers (`cli-deps validate`) catch this rather than
 * the writer trying to enforce it with a cross-process lock.
 *
 * Per RFC-0014 §12 Q2 retention is split:
 *  - `tag === 'rolling'`  → trimmed by mtime > 30d via `gcRollingSnapshots`.
 *  - other tags (`dispatch`, `calibration`, `lifecycle-transition`) →
 *     kept indefinitely; `inspectSnapshots` enumerates them per tag.
 *
 * @module deps/snapshot
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  buildDependencyGraph,
  type DependencyGraph,
  type ExternalDependency,
} from './dependency-graph.js';
import { computeEffectivePriorities } from './effective-priority.js';

/**
 * Tag identifying the event that prompted a snapshot. Per RFC-0014 §12 Q2:
 *  - `rolling`              — pipeline-tick snapshots, eligible for GC
 *  - `dispatch`             — a `/ai-sdlc execute` decision
 *  - `calibration`          — a DoR rubric calibration revision
 *  - `lifecycle-transition` — an RFC `Lifecycle:` field change
 */
export type SnapshotTag = 'rolling' | 'dispatch' | 'calibration' | 'lifecycle-transition';

export const SNAPSHOT_TAGS: readonly SnapshotTag[] = [
  'rolling',
  'dispatch',
  'calibration',
  'lifecycle-transition',
] as const;

/** One JSONL record per task — the canonical snapshot row. */
export interface SnapshotRecord {
  /** Canonical task ID (case preserved from the file). */
  id: string;
  /** IDs this task depends on (forward edges). */
  dependencies: string[];
  /** IDs that depend on this task (reverse edges). */
  dependents: string[];
  /**
   * Longest chain length BACK from this task via `dependencies`. Tasks with no
   * deps have depth 0. RFC-0014 §4.1.
   */
  depth: number;
  /**
   * Longest chain length FORWARD from this task via the reverse edge set
   * (impact closure). Leaf tasks (nothing depends on them) have CPL 0. Per
   * RFC-0014 §12 Q1 this is the secondary dispatcher tiebreak after
   * `effectivePriority`.
   */
  criticalPathLength: number;
  /**
   * `max(basePriority, max basePriority across transitive downstream)` per
   * RFC-0014 §5.3. The PRIMARY dispatcher sort key — a high-priority
   * downstream lifts a low-priority upstream blocker so the critical path
   * surfaces. Numeric weight 1-4 (low=1, medium=2, high=3, critical=4).
   * AISDLC-178.4 #384 review fix: was missing from the snapshot, forcing
   * the TUI Critical Path pane to use criticalPathLength as a wrong proxy
   * (a leaf with priority:critical would sort below a chain-of-3 with
   * priority:low). Computed by `computeEffectivePriorities` at snapshot
   * time and stamped onto each record.
   *
   * Optional in the type for backward-compat with stale on-disk snapshots
   * written before this field shipped. Readers use the
   * `?? DEFAULT_PRIORITY_WEIGHT` (medium=2) fallback so the TUI never
   * crashes on a stale artifact. New snapshots ALWAYS populate this field.
   */
  effectivePriority?: number;
  /** RFC-0014 §8 + Q3 — declared external blockers (pure signal in v1). */
  externalDependencies: ExternalDependency[];
  /** ISO-8601 mtime of the on-disk task file (best-effort; '' on stat failure). */
  lastModified: string;
}

export interface WriteSnapshotOpts {
  /** Project root (defaults to cwd). Must contain `backlog/tasks/` + `backlog/completed/`. */
  workDir?: string;
  /**
   * Base artifacts directory. Falls back to `process.env.ARTIFACTS_DIR`,
   * then `<workDir>/artifacts`. Snapshots land under `<artifactsDir>/_deps/`.
   */
  artifactsDir?: string;
  /** Override the timestamp written into the filename. Used by tests for determinism. */
  now?: () => Date;
  /** Pre-built graph (for tests + composed callers that already have one). */
  graph?: DependencyGraph;
  /** Optional warn channel — currently surfaces malformed-task notices from the graph builder. */
  onWarn?: (msg: string) => void;
}

export interface WriteSnapshotResult {
  /** Absolute path of the file written. */
  path: string;
  /** Tag the snapshot was written under. */
  tag: SnapshotTag;
  /** Number of records written (= graph node count). */
  recordCount: number;
  /** Bytes written. */
  bytes: number;
  /**
   * Feature-flag indicator. When `false` the writer skipped the actual disk
   * write (operator explicitly opted out via `AI_SDLC_DEPS_COMPOSITION=off`;
   * post-AISDLC-410 the flag defaults ON). The caller can still observe what
   * _would_ have been written via `recordCount`.
   */
  written: boolean;
}

/**
 * RFC-0014 feature flag — DEFAULT-ON since AISDLC-410 (2026-05-23 operator
 * promotion via override-path per `docs/operations/deps-composition-promotion.md`).
 *
 * Polarity: absent env = ON. Operator opts OUT with one of the falsy values
 * (`off`, `0`, `false`, `no`, case-insensitive). Truthy values
 * (`1`, `true`, `yes`, `on`) are honored for backward-compat and remain ON.
 * Anything else (including unset) defaults to ON.
 *
 * Pre-promotion behavior (now retained as opt-out): when the operator wants
 * the composition layer disabled — e.g. running in a sparse repo where the
 * `_deps` snapshot writer is unwanted overhead — they set
 * `AI_SDLC_DEPS_COMPOSITION=off`.
 */
export function isCompositionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AI_SDLC_DEPS_COMPOSITION ?? '').trim().toLowerCase();
  const FALSY = new Set(['off', '0', 'false', 'no']);
  if (FALSY.has(raw)) return false;
  return true;
}

/**
 * Resolve the snapshot directory: explicit override > `$ARTIFACTS_DIR` >
 * `<workDir>/artifacts`. Files always land under `<artifactsDir>/_deps/`.
 */
export function resolveSnapshotDir(opts: WriteSnapshotOpts = {}): string {
  const workDir = opts.workDir ?? process.cwd();
  const base = opts.artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(workDir, 'artifacts');
  return join(base, '_deps');
}

/**
 * Write a snapshot of the current dependency graph as JSONL.
 *
 * Filename layout: `snapshot.<isoTimestamp-with-colons-replaced>.<tag>.jsonl`
 * (Windows-friendly; ISO colons are replaced with `-` so the file works on
 * NTFS too). The tag suffix lets `inspectSnapshots` filter by tag without
 * parsing every file.
 */
export function writeSnapshot(tag: SnapshotTag, opts: WriteSnapshotOpts = {}): WriteSnapshotResult {
  const dir = resolveSnapshotDir(opts);
  const now = (opts.now ?? (() => new Date()))();
  const stamp = now.toISOString().replace(/:/g, '-');
  const path = join(dir, `snapshot.${stamp}.${tag}.jsonl`);

  if (!isCompositionEnabled()) {
    // Flag OFF — return synthesised metadata without touching disk so the
    // operator can still see what the snapshot _would_ have been.
    const graph =
      opts.graph ?? buildDependencyGraph({ workDir: opts.workDir ?? process.cwd() }, opts.onWarn);
    const records = computeSnapshotRecords(graph);
    return { path, tag, recordCount: records.length, bytes: 0, written: false };
  }

  const graph =
    opts.graph ?? buildDependencyGraph({ workDir: opts.workDir ?? process.cwd() }, opts.onWarn);
  const records = computeSnapshotRecords(graph);

  mkdirSync(dir, { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
  writeFileSync(path, body, { encoding: 'utf8' });

  return {
    path,
    tag,
    recordCount: records.length,
    bytes: Buffer.byteLength(body, 'utf8'),
    written: true,
  };
}

/**
 * Compute the snapshot records for a given graph. Pure function — no I/O.
 *
 * Walks every node, computes `dependents` from the reverse edge map, and
 * memoises depth + criticalPathLength via DFS. Cycle-safe: a re-entry into a
 * node already on the recursion stack short-circuits to 0 so a malformed
 * graph still produces a finite answer (validate() flags the cycle separately).
 */
export function computeSnapshotRecords(graph: DependencyGraph): SnapshotRecord[] {
  // Build reverse adjacency (id -> list of dependents).
  const reverse = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    for (const dep of node.dependencies) {
      const key = dep.toLowerCase();
      const arr = reverse.get(key) ?? [];
      arr.push(node.id);
      reverse.set(key, arr);
    }
  }

  const depthCache = new Map<string, number>();
  const cplCache = new Map<string, number>();

  function depthOf(key: string, onStack: Set<string>): number {
    const cached = depthCache.get(key);
    if (cached !== undefined) return cached;
    if (onStack.has(key)) return 0; // cycle guard
    onStack.add(key);
    const node = graph.nodes.get(key);
    let best = 0;
    if (node) {
      for (const dep of node.dependencies) {
        const depKey = dep.toLowerCase();
        if (!graph.nodes.has(depKey)) continue; // dangling — skip
        const candidate = 1 + depthOf(depKey, onStack);
        if (candidate > best) best = candidate;
      }
    }
    onStack.delete(key);
    depthCache.set(key, best);
    return best;
  }

  function cplOf(key: string, onStack: Set<string>): number {
    const cached = cplCache.get(key);
    if (cached !== undefined) return cached;
    if (onStack.has(key)) return 0;
    onStack.add(key);
    let best = 0;
    for (const childId of reverse.get(key) ?? []) {
      const childKey = childId.toLowerCase();
      if (!graph.nodes.has(childKey)) continue;
      const candidate = 1 + cplOf(childKey, onStack);
      if (candidate > best) best = candidate;
    }
    onStack.delete(key);
    cplCache.set(key, best);
    return best;
  }

  // AISDLC-178.4 #384 review fix: compute effectivePriority once per snapshot
  // and stamp each record. The TUI Critical Path pane needs this as the
  // primary sort key per RFC-0014 §5.3 + AC #7 of AISDLC-178.4. Reads each
  // node's `priority` frontmatter (already on DependencyNode); falls back to
  // DEFAULT_PRIORITY_WEIGHT (medium=2) when absent.
  const effPri = computeEffectivePriorities(graph);

  const records: SnapshotRecord[] = [];
  const sortedKeys = Array.from(graph.nodes.keys()).sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
  for (const key of sortedKeys) {
    const node = graph.nodes.get(key);
    if (!node) continue;
    const dependents = (reverse.get(key) ?? [])
      .slice()
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    records.push({
      id: node.id,
      dependencies: node.dependencies,
      dependents,
      depth: depthOf(key, new Set()),
      criticalPathLength: cplOf(key, new Set()),
      effectivePriority: effPri.get(key)?.effectivePriority ?? 2,
      externalDependencies: node.externalDependencies,
      lastModified: node.lastModified,
    });
  }
  return records;
}

// ── GC + inspect ───────────────────────────────────────────────────────

export interface GcOpts extends WriteSnapshotOpts {
  /** Trim `rolling`-tagged snapshots whose mtime is older than this many days. Default 30. */
  maxAgeDays?: number;
}

export interface GcResult {
  /** Snapshot files removed by this run. */
  trimmed: string[];
  /** Snapshot files preserved (any tag, OR rolling under the age cap). */
  kept: string[];
  /** Total bytes freed (sum of `statSync.size` for trimmed files). */
  bytesFreed: number;
}

/**
 * RFC-0014 §12 Q2 — trim rolling-tagged snapshots older than `maxAgeDays`
 * days. Event-tagged snapshots (`dispatch` / `calibration` /
 * `lifecycle-transition`) are preserved regardless of age.
 *
 * Best-effort: a file that vanishes between `readdir` and `unlink` is logged
 * via `onWarn` but doesn't fail the GC pass.
 */
export function gcRollingSnapshots(opts: GcOpts = {}): GcResult {
  const dir = resolveSnapshotDir(opts);
  const result: GcResult = { trimmed: [], kept: [], bytesFreed: 0 };
  if (!existsSync(dir)) return result;

  const maxAgeDays = opts.maxAgeDays ?? 30;
  const now = (opts.now ?? (() => new Date()))().getTime();
  const cutoffMs = now - maxAgeDays * 24 * 60 * 60 * 1000;

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl') || !file.startsWith('snapshot.')) continue;
    const path = join(dir, file);
    const tag = extractTag(file);
    if (!tag) {
      // Unrecognised tag — leave it alone (operator-introduced files, etc.).
      result.kept.push(path);
      continue;
    }
    if (tag !== 'rolling') {
      result.kept.push(path);
      continue;
    }
    let size: number;
    let mtimeMs: number;
    try {
      const s = statSync(path);
      size = s.size;
      mtimeMs = s.mtimeMs;
    } catch {
      // disappeared mid-walk — nothing to do
      continue;
    }
    if (mtimeMs >= cutoffMs) {
      result.kept.push(path);
      continue;
    }
    try {
      unlinkSync(path);
      result.trimmed.push(path);
      result.bytesFreed += size;
    } catch (err) {
      opts.onWarn?.(`failed to unlink ${path}: ${(err as Error).message}`);
    }
  }
  return result;
}

export interface InspectEntry {
  /** Absolute path. */
  path: string;
  /** Filename (basename only). */
  file: string;
  /** ISO timestamp embedded in the filename. */
  isoTimestamp: string;
  /** Tag suffix from the filename. */
  tag: SnapshotTag;
  /** File size in bytes (0 on stat failure). */
  size: number;
  /** Number of JSONL records (= number of newline-terminated lines). 0 on read failure. */
  recordCount: number;
}

export interface InspectOpts extends WriteSnapshotOpts {
  /**
   * Tag to filter on. When omitted, every snapshot in the directory is
   * returned.
   */
  tag?: SnapshotTag;
}

/**
 * RFC-0014 §12 Q2 — list snapshots, optionally filtered by tag. Sorted by
 * embedded ISO timestamp ascending so the most recent appears last.
 *
 * Tolerant of zero-byte files (record count = 0) and unreadable files (record
 * count = 0, size = 0) so an operator can audit a partially-written or
 * truncated tier without the whole inspect failing.
 */
export function inspectSnapshots(opts: InspectOpts = {}): InspectEntry[] {
  const dir = resolveSnapshotDir(opts);
  if (!existsSync(dir)) return [];

  const filter = opts.tag;
  const entries: InspectEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl') || !file.startsWith('snapshot.')) continue;
    const tag = extractTag(file);
    if (!tag) continue;
    if (filter && tag !== filter) continue;
    const isoTimestamp = extractIsoTimestamp(file);
    if (!isoTimestamp) continue;
    const path = join(dir, file);
    let size = 0;
    let recordCount = 0;
    try {
      size = statSync(path).size;
    } catch {
      // ignore — surfaced as size 0
    }
    if (size > 0) {
      try {
        const body = readFileSync(path, 'utf8');
        recordCount = body.split('\n').filter((l) => l.length > 0).length;
      } catch {
        // ignore — surfaced as recordCount 0
      }
    }
    entries.push({ path, file, isoTimestamp, tag, size, recordCount });
  }
  entries.sort((a, b) => a.isoTimestamp.localeCompare(b.isoTimestamp));
  return entries;
}

/**
 * Filenames look like `snapshot.<iso>.<tag>.jsonl`. Pull the tag back out.
 * Returns `null` if the suffix isn't a known SnapshotTag value (e.g. an
 * operator dropped a custom-tagged file in the dir).
 */
function extractTag(file: string): SnapshotTag | null {
  const m = file.match(/\.([a-z-]+)\.jsonl$/);
  if (!m) return null;
  const candidate = m[1];
  return SNAPSHOT_TAGS.includes(candidate as SnapshotTag) ? (candidate as SnapshotTag) : null;
}

/**
 * Pull the ISO-style timestamp back out of the filename. We replaced `:` with
 * `-` on write, so we reverse that here to make the timestamp lexically
 * sortable in calendar order. Returns the raw embedded form (with `-`s) on
 * failure to parse — still sortable, just less pretty.
 */
function extractIsoTimestamp(file: string): string {
  // snapshot.<stamp>.<tag>.jsonl  — `<stamp>` may itself contain dots ('.SSSZ')
  const stripped = file.replace(/^snapshot\./, '').replace(/\.[a-z-]+\.jsonl$/, '');
  return stripped;
}
