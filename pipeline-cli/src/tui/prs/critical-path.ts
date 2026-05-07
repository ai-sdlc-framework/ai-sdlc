/**
 * PR critical-path derivation — RFC-0023 §7.2 / AISDLC-178.4.1.
 *
 * Mirrors the task-level `effective-priority.ts` (RFC-0014 §5.3) for PRs:
 * given a set of open PRs and (optionally) the latest dep snapshot + a git
 * ancestry checker, derive each PR's upstream/downstream PR set, longest
 * forward chain length (`cpl`), transitive unblock count, and chain
 * position/length so the PRs pane can sort by merge-sequence and render a
 * `🔗 N/M` indicator on chained PRs.
 *
 * Sources for an edge "PR A blocks PR B" (matched in this order, deduped):
 *
 *   1. Task dependencies via 1:1 task↔PR mapping. Each PR's `headRefName`
 *      contains a task ID (e.g. `ai-sdlc/aisdlc-178.4.1-...`); look up that
 *      task's `dependencies` in the snapshot — every dep ID that maps to
 *      another open PR is an upstream edge.
 *   2. Optional `depends-on:#N` label on the PR (operator-declared).
 *   3. Optional `depends-on: #N` marker in the PR body.
 *   4. Optional git branch ancestry — `gitAncestry(parent, child)` returns
 *      true when parent's tip is an ancestor of child. Defaults to no-op
 *      since calling out to git from a render path is expensive; the App
 *      can inject a real checker in a future revision.
 *
 * The longer-term home for auto-rebase trigger semantics, depends-on label
 * conventions, and multi-repo PR ordering is RFC-0034 (see registry
 * reservation). This module ships the minimum derivation needed for the
 * AISDLC-178.4.1 sort + chain indicator + chain tree.
 *
 * @module tui/prs/critical-path
 */

import type { GhPrSummary } from '../sources/gh-pr-cache.js';
import type { SnapshotRecord } from '../../deps/snapshot.js';

// ── Task-id extraction ────────────────────────────────────────────────────────

/**
 * Pull an `AISDLC-NNN[.M[.K]]` task ID out of a branch name. Matches the
 * branch pattern produced by `steps/02-compute-branch.ts`
 * (`ai-sdlc/{issueIdLower}-{slug}`) plus older shapes (`feat/aisdlc-178`,
 * `ai-sdlc/issue-178`). Case-insensitive on the prefix; the returned ID is
 * uppercased to match the canonical task-file form.
 *
 * Returns `null` when no recognisable token is present (e.g. `feat/foo`).
 */
export function extractTaskId(branchName: string | undefined | null): string | null {
  if (!branchName) return null;
  // Match AISDLC-N, AISDLC-N.M, AISDLC-N.M.K (case-insensitive).
  // Anchored to a non-word boundary so `feat/aisdlc-178-something` works.
  const match = /aisdlc-(\d+(?:\.\d+){0,2})/i.exec(branchName);
  if (!match) return null;
  return `AISDLC-${match[1]}`;
}

// ── depends-on parsing ────────────────────────────────────────────────────────

const DEPENDS_ON_LABEL_RE = /^depends[-_ ]on[:#-]\s*#?(\d+)$/i;
const DEPENDS_ON_BODY_RE = /depends[-_ ]on[:]\s*#(\d+)/gi;

/**
 * Pull `depends-on:#N` PR numbers out of a PR's labels. Tolerates the few
 * variants we've seen in dogfood: `depends-on:#247`, `depends-on-#247`,
 * `depends-on: 247`, mixed case. Returns deduped, sorted ASC.
 */
export function parseDependsOnLabels(labels: GhPrSummary['labels'] | undefined): number[] {
  if (!labels) return [];
  const out = new Set<number>();
  for (const label of labels) {
    const m = DEPENDS_ON_LABEL_RE.exec(label.name.trim());
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Pull `depends-on: #N` markers out of a PR's body. Allows multiple markers
 * (one per dep). Returns deduped, sorted ASC.
 */
export function parseDependsOnBody(body: string | undefined): number[] {
  if (!body) return [];
  const out = new Set<number>();
  // Reset stateful regex (`g` flag) before each call.
  DEPENDS_ON_BODY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEPENDS_ON_BODY_RE.exec(body)) !== null) {
    out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

// ── Chain info ────────────────────────────────────────────────────────────────

export interface PrChainInfo {
  /** Direct upstream PR numbers — PRs that this PR depends on (must merge first). */
  upstream: number[];
  /** Direct downstream PR numbers — PRs that depend on this one. */
  downstream: number[];
  /**
   * Longest forward chain length from this PR (the "PR critical path
   * length"). 0 = leaf (no downstream). Drives the primary sort key per
   * AC #2: merge the PR with the deepest forward chain first.
   */
  cpl: number;
  /** Total transitive downstream PR count — "unblocks N other PRs". */
  unblockCount: number;
  /**
   * 1-indexed position within the longest chain this PR is part of.
   * `1` = head of chain (merge first).
   */
  chainPos: number;
  /** Total length of the longest chain this PR is part of. `1` = singleton. */
  chainLen: number;
  /** True iff `chainLen > 1` — convenience flag for the row renderer. */
  inChain: boolean;
}

export type PrAncestryChecker = (parentBranch: string, childBranch: string) => boolean;

export interface DerivePrChainGraphOpts {
  prs: GhPrSummary[];
  /**
   * Optional dep-snapshot records. When provided, edges are derived from
   * task dependencies via the branch→task-id mapping. Tasks not in the
   * snapshot contribute no edges (graceful degradation).
   */
  snapshotRecords?: SnapshotRecord[];
  /**
   * Optional git ancestry checker — `(parentBranch, childBranch) => boolean`.
   * Only invoked when both branches are present on PRs. Default: no-op.
   * The default keeps the render path side-effect-free; a future revision
   * can wire `git merge-base --is-ancestor` here once the perf budget is
   * understood (RFC-0034).
   */
  gitAncestry?: PrAncestryChecker;
}

export interface PrChainGraph {
  /** PR number → chain info for that PR. */
  info: Map<number, PrChainInfo>;
  /** PR number → set of direct upstream PR numbers (deduped). */
  upstreamMap: Map<number, Set<number>>;
  /** PR number → set of direct downstream PR numbers (deduped). */
  downstreamMap: Map<number, Set<number>>;
}

/**
 * Derive the PR chain graph from the four signal sources documented above.
 *
 * Pure: no I/O. Cycle-safe via on-stack guards in the DFS passes. Sub-ms
 * even at hundreds of PRs (we only run it on `gh pr list` output).
 */
export function derivePrChainGraph(opts: DerivePrChainGraphOpts): PrChainGraph {
  const { prs, snapshotRecords, gitAncestry } = opts;

  // Build PR-number index for quick edge lookup.
  const byNumber = new Map<number, GhPrSummary>(prs.map((pr) => [pr.number, pr]));

  // Build task-id → PR-number index for the snapshot-edge pass.
  const byTaskId = new Map<string, number>();
  for (const pr of prs) {
    const taskId = extractTaskId(pr.headRefName);
    if (taskId) byTaskId.set(taskId.toLowerCase(), pr.number);
  }

  // Snapshot lookup: task-id (lowercase) → record.
  const snapshotByTask = new Map<string, SnapshotRecord>();
  for (const record of snapshotRecords ?? []) {
    snapshotByTask.set(record.id.toLowerCase(), record);
  }

  const upstreamMap = new Map<number, Set<number>>();
  const downstreamMap = new Map<number, Set<number>>();
  for (const pr of prs) {
    upstreamMap.set(pr.number, new Set());
    downstreamMap.set(pr.number, new Set());
  }

  function addEdge(parentPr: number, childPr: number): void {
    if (parentPr === childPr) return; // self-edge — degenerate
    if (!byNumber.has(parentPr) || !byNumber.has(childPr)) return; // closed PR / unknown
    upstreamMap.get(childPr)?.add(parentPr);
    downstreamMap.get(parentPr)?.add(childPr);
  }

  // 1. Task-dependency edges via the 1:1 task↔PR mapping.
  for (const pr of prs) {
    const taskId = extractTaskId(pr.headRefName);
    if (!taskId) continue;
    const record = snapshotByTask.get(taskId.toLowerCase());
    if (!record) continue;
    for (const depTaskId of record.dependencies) {
      const parentPr = byTaskId.get(depTaskId.toLowerCase());
      if (parentPr !== undefined) addEdge(parentPr, pr.number);
    }
  }

  // 2 + 3. Operator-declared depends-on edges (labels + body).
  for (const pr of prs) {
    const labelDeps = parseDependsOnLabels(pr.labels);
    const bodyDeps = parseDependsOnBody(pr.body);
    for (const parentPr of [...labelDeps, ...bodyDeps]) {
      addEdge(parentPr, pr.number);
    }
  }

  // 4. Git ancestry — O(N^2) so only invoke when caller injected a checker.
  if (gitAncestry) {
    for (const parent of prs) {
      if (!parent.headRefName) continue;
      for (const child of prs) {
        if (parent === child) continue;
        if (!child.headRefName) continue;
        // Skip pairs we already linked via stronger signals; ancestry is the
        // weakest signal and shouldn't override an explicit task-dep edge.
        if (upstreamMap.get(child.number)?.has(parent.number)) continue;
        try {
          if (gitAncestry(parent.headRefName, child.headRefName)) {
            addEdge(parent.number, child.number);
          }
        } catch {
          // Defensive: don't let a single git invocation crash the render.
        }
      }
    }
  }

  // ── Chain length + position via memoised DFS ────────────────────────────────
  const cplCache = new Map<number, number>();
  const unblockCache = new Map<number, number>();
  const backDepthCache = new Map<number, number>();

  function cplOf(num: number, onStack: Set<number>): number {
    const cached = cplCache.get(num);
    if (cached !== undefined) return cached;
    if (onStack.has(num)) return 0; // cycle guard
    onStack.add(num);
    let best = 0;
    for (const child of downstreamMap.get(num) ?? new Set<number>()) {
      const candidate = 1 + cplOf(child, onStack);
      if (candidate > best) best = candidate;
    }
    onStack.delete(num);
    cplCache.set(num, best);
    return best;
  }

  function unblockCountOf(num: number, onStack: Set<number>): number {
    const cached = unblockCache.get(num);
    if (cached !== undefined) return cached;
    if (onStack.has(num)) return 0;
    onStack.add(num);
    const seen = new Set<number>();
    function visit(n: number): void {
      for (const child of downstreamMap.get(n) ?? new Set<number>()) {
        if (seen.has(child)) continue;
        seen.add(child);
        visit(child);
      }
    }
    visit(num);
    onStack.delete(num);
    unblockCache.set(num, seen.size);
    return seen.size;
  }

  function backDepthOf(num: number, onStack: Set<number>): number {
    const cached = backDepthCache.get(num);
    if (cached !== undefined) return cached;
    if (onStack.has(num)) return 0;
    onStack.add(num);
    let best = 0;
    for (const parent of upstreamMap.get(num) ?? new Set<number>()) {
      const candidate = 1 + backDepthOf(parent, onStack);
      if (candidate > best) best = candidate;
    }
    onStack.delete(num);
    backDepthCache.set(num, best);
    return best;
  }

  // Assemble per-PR chain info.
  const info = new Map<number, PrChainInfo>();
  for (const pr of prs) {
    const upstream = [...(upstreamMap.get(pr.number) ?? new Set())].sort((a, b) => a - b);
    const downstream = [...(downstreamMap.get(pr.number) ?? new Set())].sort((a, b) => a - b);
    const cpl = cplOf(pr.number, new Set());
    const unblockCount = unblockCountOf(pr.number, new Set());
    const backDepth = backDepthOf(pr.number, new Set());
    const chainPos = backDepth + 1;
    const chainLen = backDepth + 1 + cpl;
    info.set(pr.number, {
      upstream,
      downstream,
      cpl,
      unblockCount,
      chainPos,
      chainLen,
      inChain: chainLen > 1,
    });
  }

  return { info, upstreamMap, downstreamMap };
}

// ── ASCII chain tree ──────────────────────────────────────────────────────────

export interface BuildPrChainTreeOpts {
  prNumber: number;
  prs: GhPrSummary[];
  graph: PrChainGraph;
}

/**
 * Render an ASCII chain tree for a single PR's detail view.
 *
 * Layout (mirrors `buildAsciiDepTree` from the Critical Path pane):
 *
 *   Upstream (parents — must merge first) above
 *   The focused PR in the middle, marked with *
 *   Downstream (dependents — unblocked by this PR) below
 *
 * Only one level of upstream / downstream is rendered to keep the tree
 * readable in a small detail pane. Operators with deeper chains can
 * navigate to the upstream/downstream PR and re-open detail.
 */
export function buildPrChainTree(opts: BuildPrChainTreeOpts): string[] {
  const { prNumber, prs, graph } = opts;
  const byNum = new Map<number, GhPrSummary>(prs.map((pr) => [pr.number, pr]));
  const focused = byNum.get(prNumber);
  const chainInfo = graph.info.get(prNumber);
  if (!focused || !chainInfo) return [`PR #${prNumber} not found in graph`];

  const lines: string[] = [];
  const { upstream, downstream, cpl, unblockCount, chainPos, chainLen } = chainInfo;

  if (upstream.length > 0) {
    lines.push('Upstream (must merge first):');
    for (const upNum of upstream) {
      const upPr = byNum.get(upNum);
      const branch = upPr?.headRefName ?? 'unknown-branch';
      const title = upPr?.title ?? '(closed)';
      lines.push(`  ┌─ #${upNum} ${branch} — ${title}`);
    }
    lines.push('  │');
  }

  const chainLabel = chainLen > 1 ? `🔗 ${chainPos}/${chainLen}` : 'singleton';
  lines.push(
    `  * #${focused.number} ${focused.headRefName ?? ''} — ${focused.title}  [${chainLabel}, cpl=${cpl}, unblocks=${unblockCount}]`,
  );

  if (downstream.length > 0) {
    lines.push('  │');
    lines.push('Downstream (unblocked by this PR):');
    for (const downNum of downstream) {
      const downPr = byNum.get(downNum);
      const branch = downPr?.headRefName ?? 'unknown-branch';
      const title = downPr?.title ?? '(closed)';
      lines.push(`  └─ #${downNum} ${branch} — ${title}`);
    }
  }

  return lines;
}
