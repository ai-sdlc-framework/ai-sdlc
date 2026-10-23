/**
 * Workflow engine (RFC-0056 phase 3): runs a Workflow document one call at a time.
 *
 * Per call it computes the ready set, runs `step` and `anchor` nodes in process, and
 * returns the first `agent` (or `fanout`) node as ONE spawn instruction under the
 * existing `--result` reply protocol. One record per node run is persisted in the
 * state JSON, and a resume replays those records instead of restarting the run.
 *
 * The engine is generic: the host (see `execute-host.ts`) supplies the step
 * implementations and the agent prompts. Everything the RFC asks the ENGINE to
 * guarantee lives here: the base-branch-only load, the refusals, the loop cap, the
 * non-gating (shadow) nodes and their `sample`, and the comparison ledger.
 *
 * @module workflow/engine
 */
import { createSimpleExpressionEvaluator } from '@ai-sdlc/reference';
import { load } from 'js-yaml';
import {
  validate as validateDependencyGraph,
  type DependencyGraph,
  type DependencyNode,
} from '../deps/dependency-graph.js';
import type { Instruction } from '../next-step/types.js';
import type { Runner } from '../runtime/exec.js';
import { BUILTIN_WORKFLOW_PATH, WORKFLOW_PATH, sha256Hex } from './digest.js';
import { buildExecuteGraph, renderYaml } from './graph.js';
import { normalizeEdge, validateWorkflowDocument } from './validate.js';

// ── refusals ────────────────────────────────────────────────────────

export type RefusalRule =
  | 'not-from-base'
  | 'invalid-document'
  | 'undeclared-cycle'
  | 'ship-without-anchor'
  | 'no-ship-node'
  | 'unknown-impl'
  | 'unsupported-expect';

/** The engine will not run this document. `rule` names why; `message` is for the operator. */
export class WorkflowRefusal extends Error {
  constructor(
    readonly rule: RefusalRule,
    message: string,
  ) {
    super(`workflow refused (${rule}): ${message}`);
    this.name = 'WorkflowRefusal';
  }
}

// ── document model ──────────────────────────────────────────────────

export interface EngineNode {
  kind: 'step' | 'anchor' | 'agent' | 'fanout' | 'human';
  impl?: string;
  role?: string;
  gating?: boolean;
  sample?: number | string;
  over?: string;
  cap?: number;
  expect?: string;
  node?: { kind: 'agent'; role: string; fresh?: boolean };
}

export interface EngineEdge {
  from: string;
  to: string;
  when?: string;
  loop?: { max: number };
}

/** Where a document came from. Only the base branch and the built-in default may run. */
export type WorkflowOrigin =
  | { kind: 'base'; baseSha: string; path: string }
  | { kind: 'builtin'; baseSha: string }
  | { kind: 'worktree'; path: string };

export interface PreparedWorkflow {
  name: string;
  nodes: Record<string, EngineNode>;
  edges: EngineEdge[];
  /** Kahn topological order over the non-loop edges. */
  order: string[];
  anchors: Set<string>;
  origin: WorkflowOrigin;
  /** `.ai-sdlc/workflow.yaml` (or the built-in marker) as recorded in `workflowDigest.path`. */
  path: string;
  sha256: string;
  baseSha: string;
  /** Per node: the nodes of the loop it sits in (empty for a node outside every loop). */
  loopBodies: Map<string, Set<string>>;
}

interface RawDoc {
  metadata: { name: string };
  spec: { nodes: Record<string, EngineNode>; edges: unknown[]; anchors?: string[] };
}

function nonLoop(edges: EngineEdge[]): EngineEdge[] {
  return edges.filter((e) => !e.loop);
}

/** Kahn's algorithm; the returned order is shorter than `ids` exactly when a cycle remains. */
export function topologicalOrder(ids: string[], edges: EngineEdge[]): string[] {
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const e of edges) {
      if (e.from !== id) continue;
      const left = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, left);
      if (left === 0) queue.push(e.to);
    }
  }
  return order;
}

/** The task-dependency cycle detector, fed the workflow edges (a node depends on its sources). */
function cyclesViaDependencyGraph(ids: string[], edges: EngineEdge[]): string[][] {
  const nodes = new Map<string, DependencyNode>();
  for (const id of ids) {
    const dependencies = edges.filter((e) => e.to === id).map((e) => e.from);
    nodes.set(id.toLowerCase(), { id, dependencies } as DependencyNode);
  }
  const graph: DependencyGraph = { nodes, openIds: [], completedIds: [] };
  return validateDependencyGraph(graph).cycles;
}

function reachesWithoutAnchor(
  start: string[],
  target: string,
  edges: EngineEdge[],
  anchors: Set<string>,
): boolean {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (anchors.has(cur)) continue;
    if (cur === target) return true;
    for (const e of edges) if (e.from === cur) stack.push(e.to);
  }
  return false;
}

function computeLoopBodies(
  ids: string[],
  all: EngineEdge[],
  forward: EngineEdge[],
): Map<string, Set<string>> {
  const reach = (from: string, edges: EngineEdge[]): Set<string> => {
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      for (const e of edges)
        if (e.from === cur && !seen.has(e.to)) {
          seen.add(e.to);
          stack.push(e.to);
        }
    }
    return seen;
  };
  const bodies = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const loop of all.filter((e) => e.loop)) {
    const down = reach(loop.to, forward);
    const reversed = forward.map((e) => ({ ...e, from: e.to, to: e.from }));
    const up = reach(loop.from, reversed);
    const body = [...down].filter((n) => up.has(n));
    for (const n of body) for (const m of body) bodies.get(n)?.add(m);
  }
  return bodies;
}

export interface PrepareOptions {
  origin: WorkflowOrigin;
  /** Impl ids the host can run; an unknown impl is refused before any node runs. */
  knownImpls: ReadonlySet<string>;
  text: string;
  path: string;
  sha256: string;
}

/**
 * Validate a parsed document and fix its run order. Every refusal throws a
 * `WorkflowRefusal`; nothing partial is returned.
 */
export function prepareWorkflow(doc: unknown, opts: PrepareOptions): PreparedWorkflow {
  if (opts.origin.kind === 'worktree') {
    throw new WorkflowRefusal(
      'not-from-base',
      `${opts.origin.path} was read from the working tree; the engine loads the document from the base branch only (the review-config.yaml rule)`,
    );
  }
  const verdict = validateWorkflowDocument(doc);
  if (!verdict.ok) {
    const cycle = verdict.errors.some((e) => e.startsWith('undeclared-loop'));
    throw new WorkflowRefusal(
      cycle ? 'undeclared-cycle' : 'invalid-document',
      verdict.errors.join('; '),
    );
  }
  const raw = doc as RawDoc;
  const nodes = raw.spec.nodes;
  const ids = Object.keys(nodes);
  const edges = raw.spec.edges.flatMap((e) => {
    const n = normalizeEdge(e);
    return n ? [n as EngineEdge] : [];
  });
  const forward = nonLoop(edges);

  const cycles = cyclesViaDependencyGraph(ids, forward);
  const order = topologicalOrder(ids, forward);
  if (cycles.length > 0 || order.length !== ids.length) {
    throw new WorkflowRefusal(
      'undeclared-cycle',
      `the edges form a cycle without a declared loop${cycles[0] ? ` (${cycles[0].join(' -> ')})` : ''}`,
    );
  }

  for (const [id, n] of Object.entries(nodes)) {
    if ((n.kind === 'step' || n.kind === 'anchor') && n.impl && !opts.knownImpls.has(n.impl)) {
      throw new WorkflowRefusal(
        'unknown-impl',
        `node '${id}' names impl '${n.impl}' with no implementation`,
      );
    }
    if (n.kind === 'fanout' && (n.expect ?? 'all') !== 'all') {
      throw new WorkflowRefusal(
        'unsupported-expect',
        `fanout '${id}' expects '${n.expect}'; only 'all' (a missing return fails the join closed) is implemented`,
      );
    }
  }

  const anchors = new Set<string>([
    ...(raw.spec.anchors ?? []),
    ...ids.filter((id) => nodes[id].kind === 'anchor'),
  ]);
  const shipId = ids.find((id) => id === 'ship' || nodes[id].impl === 'push-and-pr');
  if (shipId === undefined) {
    throw new WorkflowRefusal('no-ship-node', "no node 'ship' (impl push-and-pr) to reach");
  }
  const roots = ids.filter((id) => !forward.some((e) => e.to === id));
  if (reachesWithoutAnchor(roots, shipId, forward, anchors)) {
    throw new WorkflowRefusal(
      'ship-without-anchor',
      `a path to '${shipId}' crosses no anchor; list a deterministic node under spec.anchors or make it kind: anchor`,
    );
  }

  return {
    name: raw.metadata.name,
    nodes,
    edges,
    order,
    anchors,
    origin: opts.origin,
    path: opts.path,
    sha256: opts.sha256,
    baseSha: opts.origin.baseSha,
    loopBodies: computeLoopBodies(ids, edges, forward),
  };
}

// ── loading from the base branch ────────────────────────────────────

export interface LoadOptions {
  runner: Runner;
  workDir: string;
  /** Ref the document is read from; a resume passes the recorded base SHA. */
  baseRef: string;
  knownImpls: ReadonlySet<string>;
  /** On resume: the digest recorded at the start, which the document must still match. */
  expect?: { path: string; sha256: string; baseSha: string };
}

/**
 * Read `.ai-sdlc/workflow.yaml` from the base ref with `git show`, never from the working
 * tree, and prepare it. No document on the base ref means the plugin default runs.
 */
export async function loadWorkflowFromBase(opts: LoadOptions): Promise<PreparedWorkflow> {
  const sha = await opts.runner('git', ['rev-parse', '--verify', `${opts.baseRef}^{commit}`], {
    cwd: opts.workDir,
    allowFailure: true,
  });
  if (sha.code !== 0) {
    throw new WorkflowRefusal(
      'not-from-base',
      `cannot resolve the base ref '${opts.baseRef}'; the document is read from the base branch only`,
    );
  }
  const baseSha = sha.stdout.trim();
  const shown = await opts.runner('git', ['show', `${baseSha}:${WORKFLOW_PATH}`], {
    cwd: opts.workDir,
    allowFailure: true,
  });
  const knownImpls = opts.knownImpls;
  if (shown.code !== 0) {
    const text = renderYaml(buildExecuteGraph());
    return prepareWorkflow(load(text), {
      origin: { kind: 'builtin', baseSha },
      knownImpls,
      text,
      path: BUILTIN_WORKFLOW_PATH,
      sha256: sha256Hex(text),
    });
  }
  const text = shown.stdout;
  const prepared = prepareWorkflow(load(text), {
    origin: { kind: 'base', baseSha, path: WORKFLOW_PATH },
    knownImpls,
    text,
    path: WORKFLOW_PATH,
    sha256: sha256Hex(text),
  });
  if (opts.expect && opts.expect.sha256 !== prepared.sha256) {
    throw new WorkflowRefusal(
      'not-from-base',
      `the document at ${baseSha} no longer matches the digest recorded for this run`,
    );
  }
  return prepared;
}

// ── run state ───────────────────────────────────────────────────────

export type RecordStatus = 'ok' | 'covered' | 'skipped' | 'spawned' | 'reset';

/** One node run. The state JSON holds the list; a resume replays it. */
export interface NodeRecord {
  seq: number;
  node: string;
  /** Loop pass the record belongs to (0 until a loop edge fires). */
  epoch: number;
  status: RecordStatus;
  at: string;
  detail?: string;
  /** Small, JSON-safe output the `when` expressions read. */
  output?: Record<string, unknown>;
  gating?: boolean;
}

export interface LedgerEntry {
  at: string;
  taskId: string;
  node: string;
  role: string;
  /** Always false: only non-gating nodes are written to the comparison ledger. */
  gating: false;
  skipped?: true;
  sampleKey?: { source: 'pr' | 'task'; value: number };
  approved?: boolean;
  findings?: Record<string, number>;
  summary?: string;
}

/** Persisted under `NextStepState.workflow`. */
export interface WorkflowRunState {
  name: string;
  path: string;
  sha256: string;
  baseSha: string;
  origin: 'base' | 'builtin';
  epoch: number;
  records: NodeRecord[];
  ledger: LedgerEntry[];
  /** Loop-edge traversals, keyed `from->to`. */
  loops: Record<string, number>;
  /** Host scratch that must survive a resume (developer prompt file, flags). */
  scratch: Record<string, unknown>;
}

export function newRunState(prepared: PreparedWorkflow): WorkflowRunState {
  return {
    name: prepared.name,
    path: prepared.path,
    sha256: prepared.sha256,
    baseSha: prepared.baseSha,
    origin: prepared.origin.kind === 'base' ? 'base' : 'builtin',
    epoch: 0,
    records: [],
    ledger: [],
    loops: {},
    scratch: {},
  };
}

// ── host contract ───────────────────────────────────────────────────

export type StepOutcome =
  | {
      kind: 'ok';
      output?: Record<string, unknown>;
      detail?: string;
      /** Impl ids or node ids this step already did; those nodes are recorded `covered`. */
      covers?: readonly string[];
    }
  | { kind: 'invalidate'; nodes: readonly string[]; detail?: string }
  | { kind: 'halt'; instruction: Instruction };

/** A non-gating agent node that is running beside the gating spawn. */
export interface ShadowSpawn {
  nodeId: string;
  role: string;
}

export type SpawnOutcome =
  | { kind: 'spawn'; instruction: Instruction }
  /** Nothing to spawn (an empty fan-out): the node is done. */
  | { kind: 'none'; output?: Record<string, unknown>; detail?: string }
  | { kind: 'halt'; instruction: Instruction };

export interface ShadowResult {
  nodeId: string;
  role: string;
  approved?: boolean;
  findings?: Record<string, number>;
  summary?: string;
}

export type ResultOutcome =
  | { kind: 'ok'; output?: Record<string, unknown>; shadows?: ShadowResult[] }
  /** Stay on this node and hand the model a corrected-report or next-stage instruction. */
  | { kind: 'respawn'; instruction: Instruction; shadows?: ShadowResult[] }
  | { kind: 'invalidate'; nodes: readonly string[]; detail?: string }
  | { kind: 'halt'; instruction: Instruction };

export interface EngineHost {
  /** Impl ids that `runStep` implements. */
  readonly knownImpls: ReadonlySet<string>;
  now(): Date;
  taskId(): string;
  /** Key `sample: 1/N` is taken against: the PR number once there is one. */
  sampleKey(): { source: 'pr' | 'task'; value: number };
  runStep(nodeId: string, node: EngineNode, run: WorkflowRunState): Promise<StepOutcome>;
  spawn(
    nodeId: string,
    node: EngineNode | undefined,
    shadows: ShadowSpawn[],
    run: WorkflowRunState,
  ): Promise<SpawnOutcome>;
  onResult(
    nodeId: string | undefined,
    node: EngineNode | undefined,
    text: string,
    shadows: ShadowSpawn[],
    run: WorkflowRunState,
  ): Promise<ResultOutcome>;
  /** The loop cap ended the loop: the host records that a human must look at the result. */
  onLoopExhausted(run: WorkflowRunState): void;
  appendLedger(entry: LedgerEntry): void;
  persist(): void;
}

// ── engine ──────────────────────────────────────────────────────────

const DONE: ReadonlySet<RecordStatus> = new Set(['ok', 'covered', 'skipped']);

/** `sample: 1/N` or `N` as the divisor N; 1 (every PR) when absent. */
export function sampleDivisor(sample: number | string | undefined): number {
  if (sample === undefined) return 1;
  if (typeof sample === 'number') return sample;
  const m = sample.match(/^1\/([1-9][0-9]*)$/);
  return m ? Number(m[1]) : 1;
}

/** The decision-style identifiers a `when` may name as bare words (reference grammar has no enum). */
const ENUM_CONSTANTS: Record<string, string> = {
  APPROVED: 'APPROVED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
};

export class WorkflowEngine {
  private readonly evaluator = createSimpleExpressionEvaluator();

  constructor(
    private readonly wf: PreparedWorkflow,
    private readonly host: EngineHost,
    private readonly run: WorkflowRunState,
  ) {}

  // ── record replay ─────────────────────────────────────────────────

  private latest(node: string, epochOnly: boolean): NodeRecord | undefined {
    for (let i = this.run.records.length - 1; i >= 0; i--) {
      const r = this.run.records[i];
      if (r.node !== node) continue;
      if (epochOnly && r.epoch !== this.run.epoch) continue;
      return r;
    }
    return undefined;
  }

  private inLoop(node: string): boolean {
    return (this.wf.loopBodies.get(node)?.size ?? 0) > 0;
  }

  private isDone(node: string): boolean {
    const r = this.latest(node, this.inLoop(node));
    return r !== undefined && DONE.has(r.status);
  }

  private add(node: string, status: RecordStatus, extra: Partial<NodeRecord> = {}): NodeRecord {
    const rec: NodeRecord = {
      seq: this.run.records.length + 1,
      node,
      epoch: this.run.epoch,
      status,
      at: this.host.now().toISOString(),
      ...extra,
    };
    this.run.records.push(rec);
    return rec;
  }

  /** Nodes whose latest record is `spawned`: the model owes a result for them. */
  private pending(): string[] {
    const out: string[] = [];
    for (const id of this.wf.order) {
      const r = this.latest(id, false);
      if (r?.status === 'spawned') out.push(id);
    }
    return out;
  }

  private context(): Record<string, unknown> {
    const ctx: Record<string, unknown> = { ...ENUM_CONSTANTS };
    for (const id of this.wf.order) {
      const r = this.latest(id, this.inLoop(id));
      if (r && DONE.has(r.status) && r.output) {
        Object.assign(ctx, r.output);
        ctx[id] = r.output;
      }
    }
    return ctx;
  }

  private whenHolds(e: EngineEdge): boolean {
    return e.when === undefined || this.evaluator.evaluate(e.when, this.context());
  }

  private gating(node: string): boolean {
    const n = this.wf.nodes[node];
    return !(n.kind === 'agent' && n.gating === false);
  }

  // ── readiness ─────────────────────────────────────────────────────

  private inbound(node: string): EngineEdge[] {
    // A non-gating node never joins: it is not waited for, and it feeds nothing.
    return this.wf.edges.filter((e) => !e.loop && e.to === node && this.gating(e.from));
  }

  private loopFull(e: EngineEdge): boolean {
    // `max` is the cap on passes through the loop body (the Machine's iteration cap).
    return (this.run.loops[`${e.from}->${e.to}`] ?? 0) + 1 >= (e.loop?.max ?? 1);
  }

  /** The edge enters a loop body through a node whose loop edge can no longer fire. */
  private leadsIntoSpentLoop(e: EngineEdge): boolean {
    return this.wf.edges.some((l) => l.loop && l.from === e.to && this.loopFull(l));
  }

  /**
   * Nodes whose chosen exit is a spent loop. The loop cannot run again, so their other
   * exits are taken regardless of `when`, and the host is told a human must look.
   */
  private computeCapExits(): Set<string> {
    const out = new Set<string>();
    for (const id of this.wf.order) {
      if (!this.isDone(id)) continue;
      const leaving = this.wf.edges.filter((e) => !e.loop && e.from === id);
      if (leaving.some((e) => this.leadsIntoSpentLoop(e) && this.whenHolds(e))) out.add(id);
    }
    return out;
  }

  private edgeSatisfied(e: EngineEdge, capExit: Set<string>): boolean {
    if (!this.isDone(e.from) || this.leadsIntoSpentLoop(e)) return false;
    return this.whenHolds(e) || capExit.has(e.from);
  }

  private nextReady(): { ready: string[]; capExit: Set<string> } {
    const capExit = this.computeCapExits();
    const ready: string[] = [];
    for (const id of this.wf.order) {
      if (this.isDone(id) || this.latest(id, false)?.status === 'spawned') continue;
      const inbound = this.inbound(id);
      if (inbound.every((e) => this.edgeSatisfied(e, capExit))) ready.push(id);
    }
    return { ready, capExit };
  }

  // ── driving ───────────────────────────────────────────────────────

  /** Accept the model's result for the pending node(s), then advance. */
  async resume(resultText: string): Promise<Instruction | null> {
    const pending = this.pending();
    const gatingId = pending.find((id) => this.gating(id));
    const shadows = pending
      .filter((id) => !this.gating(id))
      .map((id) => ({ nodeId: id, role: this.wf.nodes[id].role ?? id }));
    const node = gatingId ? this.wf.nodes[gatingId] : undefined;
    const out = await this.host.onResult(gatingId, node, resultText, shadows, this.run);
    if (out.kind === 'halt') return out.instruction;
    if (out.kind === 'respawn') {
      if (out.shadows?.length) this.closeShadows(out.shadows);
      this.host.persist();
      return out.instruction;
    }
    if (out.kind === 'invalidate') {
      this.closeShadows([]);
      this.reset(out.nodes, out.detail);
      return this.advance();
    }
    this.closeShadows(out.shadows ?? []);
    if (gatingId) this.add(gatingId, 'ok', { output: out.output });
    return this.advance();
  }

  private closeShadows(results: ShadowResult[]): void {
    for (const id of this.pending().filter((p) => !this.gating(p))) {
      const res = results.find((r) => r.nodeId === id);
      this.add(id, 'ok', { gating: false, detail: 'non-gating: output excluded from every join' });
      if (res) {
        this.ledger({
          at: this.host.now().toISOString(),
          taskId: this.host.taskId(),
          node: id,
          role: res.role,
          gating: false,
          ...(res.approved !== undefined ? { approved: res.approved } : {}),
          ...(res.findings ? { findings: res.findings } : {}),
          ...(res.summary ? { summary: res.summary } : {}),
        });
      }
    }
  }

  private ledger(entry: LedgerEntry): void {
    this.run.ledger.push(entry);
    this.host.appendLedger(entry);
  }

  private reset(nodes: readonly string[], detail?: string): void {
    for (const n of nodes) this.add(n, 'reset', detail ? { detail } : {});
  }

  /** Run every ready node that needs no model; return the first model instruction (or a halt). */
  /** Resolves to `null` when the graph is finished: no node is ready and none is pending. */
  async advance(): Promise<Instruction | null> {
    for (let guard = 0; guard < 500; guard++) {
      const { ready, capExit } = this.nextReady();
      for (const id of capExit) {
        if (!this.run.scratch[`capExit:${id}`]) {
          this.run.scratch[`capExit:${id}`] = true;
          this.host.onLoopExhausted(this.run);
        }
      }
      if (ready.length === 0) return null;
      const shadows = this.takeShadows(ready);
      const next = ready.find((id) => this.gating(id));
      if (next === undefined) {
        if (shadows.length === 0) continue; // only skipped shadows were ready
        const out = await this.host.spawn('', undefined, shadows, this.run);
        return this.afterSpawn(out, undefined, shadows);
      }
      const node = this.wf.nodes[next];
      if (node.kind === 'agent' || node.kind === 'fanout') {
        const out = await this.host.spawn(next, node, shadows, this.run);
        return this.afterSpawn(out, next, shadows);
      }
      if (node.kind === 'human') {
        throw new WorkflowRefusal(
          'invalid-document',
          `human node '${next}' is not supported by the engine yet`,
        );
      }
      const outcome = await this.host.runStep(next, node, this.run);
      if (outcome.kind === 'halt') return outcome.instruction;
      if (outcome.kind === 'invalidate') {
        this.reset(outcome.nodes, outcome.detail);
        this.host.persist();
        continue;
      }
      this.add(next, 'ok', {
        ...(outcome.output ? { output: outcome.output } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      });
      this.cover(next, outcome.covers ?? []);
      this.fireLoops(next);
    }
    throw new Error('workflow engine: no progress after 500 node runs (guard)');
  }

  private afterSpawn(
    out: SpawnOutcome,
    nodeId: string | undefined,
    shadows: ShadowSpawn[],
  ): Instruction | Promise<Instruction | null> {
    if (out.kind === 'halt') return out.instruction;
    if (out.kind === 'none') {
      if (nodeId)
        this.add(nodeId, 'ok', {
          ...(out.output ? { output: out.output } : {}),
          detail: out.detail ?? 'nothing to spawn',
        });
      for (const s of shadows)
        this.add(s.nodeId, 'skipped', { gating: false, detail: 'nothing spawned' });
      return this.advance();
    }
    if (nodeId) this.add(nodeId, 'spawned');
    for (const s of shadows) this.add(s.nodeId, 'spawned', { gating: false });
    this.host.persist();
    return out.instruction;
  }

  /**
   * Sample the ready non-gating agent nodes: record the skip of the ones `sample`
   * excludes (and write it to the ledger), return the ones that run beside the spawn.
   */
  private takeShadows(ready: string[]): ShadowSpawn[] {
    const out: ShadowSpawn[] = [];
    for (const id of ready) {
      const n = this.wf.nodes[id];
      if (n.kind !== 'agent' || n.gating !== false) continue;
      const divisor = sampleDivisor(n.sample);
      const key = this.host.sampleKey();
      if (divisor > 1 && key.value % divisor !== 0) {
        this.add(id, 'skipped', {
          gating: false,
          detail: `sample 1/${divisor}: ${key.source} ${key.value} % ${divisor} != 0`,
        });
        this.ledger({
          at: this.host.now().toISOString(),
          taskId: this.host.taskId(),
          node: id,
          role: n.role ?? id,
          gating: false,
          skipped: true,
          sampleKey: key,
        });
        continue;
      }
      out.push({ nodeId: id, role: n.role ?? id });
    }
    return out;
  }

  /** A step that covers other impls already did their work: record them without running. */
  private cover(by: string, impls: readonly string[]): void {
    if (impls.length === 0) return;
    for (const id of this.wf.order) {
      const n = this.wf.nodes[id];
      if (((n.impl && impls.includes(n.impl)) || impls.includes(id)) && !this.isDone(id)) {
        this.add(id, 'covered', { detail: `covered by ${by}` });
      }
    }
  }

  /** A loop edge whose source just finished fires when its `when` holds and the cap allows. */
  private fireLoops(node: string): void {
    for (const e of this.wf.edges) {
      if (!e.loop || e.from !== node) continue;
      if (this.loopFull(e) || !this.whenHolds(e)) continue;
      const key = `${e.from}->${e.to}`;
      this.run.loops[key] = (this.run.loops[key] ?? 0) + 1;
      this.run.epoch += 1;
    }
  }
}
