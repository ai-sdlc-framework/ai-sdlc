/**
 * Workflow overlays and the frozen set (RFC-0056 phase 4, OQ-3).
 *
 * An adopter document with `metadata.extends: ai-sdlc/execute-task@<version>` is
 * applied over the plugin default. Allowed: add nodes, add edges, change `with`,
 * lower caps, change lenses, remove non-frozen nodes. Refused: touch a frozen
 * node, raise a cap above the plugin ceiling, remove the last anchor on a path,
 * declare an agent as an anchor.
 *
 * One frozen list ({@link FROZEN_SET}) and one refusal shape
 * (`<rule>: <what>; enforcer: <file>, ...`): every refusal names the file that
 * enforces the rule it protects. A frozen entry may be changed only when the
 * overlay names a decision record that resolves in the catalog on the base
 * branch (a record in the working tree is not authority; CLAUDE.md, Decision
 * authority).
 *
 * @module workflow/overlay
 */
import { DEFAULT_MAX_ITERATIONS } from '../steps/09-iterate.js';
import { REVIEW_FANOUT_CAP, buildExecuteGraph, type WorkflowDocument } from './graph.js';

export interface FrozenEntry {
  /** Rule id; also the `with` key an overlay may not set. */
  id: string;
  /** What the rule protects, in a sentence. */
  rule: string;
  /** Repo-relative files that enforce the rule outside the edited document. */
  enforcers: readonly string[];
  /** Nodes of the plugin default frozen byte-for-byte by this entry. */
  nodes?: readonly string[];
}

/** The OQ-3 frozen set: the code-backed list plus the fanout join rule. */
export const FROZEN_SET: readonly FrozenEntry[] = [
  {
    id: 'aggregate',
    rule: 'severity rule, unanimity, a missing reviewer is critical',
    enforcers: [
      'pipeline-cli/src/steps/08-aggregate-verdicts.ts',
      'pipeline-cli/src/next-step/review-finalize.ts',
    ],
    nodes: ['aggregate'],
  },
  {
    id: 'ship',
    rule: 'never land, lease-only push',
    enforcers: [
      'ai-sdlc-plugin/hooks/enforce-blocked-actions.js',
      'ai-sdlc-plugin/hooks/lib/lease-push-guard.js',
      'pipeline-cli/src/governance/merge-if-eligible.ts',
    ],
    nodes: ['ship'],
  },
  {
    id: 'anchor',
    rule: 'every anchor stays, and every path to ship crosses one',
    enforcers: ['pipeline-cli/src/workflow/engine.ts', 'spec/schemas/workflow.schema.json'],
  },
  {
    id: 'attestation-signing',
    rule: 'attestation signing and verification',
    enforcers: [
      'pipeline-cli/src/attestation/sign-v6.ts',
      'pipeline-cli/attestation-core/verify-core.mjs',
    ],
  },
  {
    id: 'nonce-head-sha',
    rule: 'the nonce is bound to the head SHA',
    enforcers: ['pipeline-cli/src/attestation/merkle.ts'],
  },
  {
    id: 'baseline-checklist',
    rule: 'the planner cannot weaken the baseline checklist',
    enforcers: ['pipeline-cli/src/review-plan/validate.ts'],
  },
  {
    id: 'grounding-drop',
    rule: 'ungrounded findings are dropped',
    enforcers: ['pipeline-cli/src/review-synth/ground.ts'],
  },
  {
    id: 'atomic-board-claims',
    rule: 'board claims are atomic',
    enforcers: ['pipeline-cli/src/dispatch/board.ts'],
  },
  {
    id: 'reconciler-loop-guard',
    rule: 'one (action, head SHA) runs once before it parks',
    enforcers: ['pipeline-cli/src/hierarchy/reconcile.ts'],
  },
  {
    id: 'base-branch-config',
    rule: 'configuration is loaded from the base branch only',
    enforcers: [
      'pipeline-cli/src/steps/reviewer-set.ts',
      'pipeline-cli/src/routing/load-table.ts',
      'pipeline-cli/src/hierarchy/pr-lifecycle-config.ts',
    ],
  },
  {
    id: 'fanout-join',
    rule: '`expect` cannot be loosened and `cap` cannot exceed the plugin ceiling',
    enforcers: ['pipeline-cli/src/workflow/engine.ts', 'pipeline-cli/src/workflow/execute-host.ts'],
  },
];

const entry = (id: string): FrozenEntry => FROZEN_SET.find((e) => e.id === id) as FrozenEntry;

/** Ceilings: the code constants that bound a document value. */
export const CEILINGS = {
  fanoutCap: REVIEW_FANOUT_CAP,
  loopMax: DEFAULT_MAX_ITERATIONS,
} as const;

const ITERATION_ENFORCER = 'pipeline-cli/src/steps/09-iterate.ts';

/** Lenses the review plan node accepts; `security` may not be dropped. */
export const KNOWN_LENSES: readonly string[] = [
  'correctness',
  'code',
  'test',
  'security',
  'staged',
];
const LENS_ENFORCER = 'pipeline-cli/src/steps/reviewer-set.ts';

/** Authorizing reference logged when staged is promoted to gating (RFC-0052 OQ-2). */
export const STAGED_PROMOTION_REF = 'RFC-0052 OQ-2';

const EXTENDS_RE = /^ai-sdlc\/execute-task@(.+)$/;

const AGENT_ROLES = new Set([
  'developer',
  'code-reviewer',
  'test-reviewer',
  'security-reviewer',
  'code-reviewer-codex',
  'test-reviewer-codex',
  'review-executor',
]);

export interface OverlayContext {
  /** True when the id resolves in the decision catalog on the base branch. */
  decisionExists: (id: string) => boolean;
}

export interface OverlayResult {
  ok: boolean;
  /** The merged document; present when `ok`. */
  doc?: WorkflowDocument;
  errors: string[];
  /** Accepted-with-a-reference facts (a frozen touch authorized, a staged promotion). */
  notes: string[];
}

type AnyNode = Record<string, unknown>;
type AnyEdge = { from: string; to: string; when?: string; loop?: { max: number } };

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as unknown as AnyNode).sort(([a], [b]) => a.localeCompare(b)),
        )
      : val,
  );

const refuse = (rule: string, what: string, e: FrozenEntry | string[]): string =>
  `${rule}: ${what}; enforcer: ${(Array.isArray(e) ? e : e.enforcers).join(', ')}`;

function normEdge(e: unknown): AnyEdge | undefined {
  if (typeof e === 'string') {
    const m = e.match(/^\s*([A-Za-z0-9_-]+)\s*->\s*([A-Za-z0-9_-]+)\s*$/);
    return m ? { from: m[1], to: m[2] } : undefined;
  }
  return e && typeof e === 'object' ? (e as AnyEdge) : undefined;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** True when some root-to-`target` path crosses none of `anchors`. */
function reachesWithoutAnchor(
  nodes: string[],
  edges: AnyEdge[],
  target: string,
  anchors: Set<string>,
): boolean {
  const forward = edges.filter((e) => !e.loop);
  const roots = nodes.filter((n) => !forward.some((e) => e.to === n));
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur) || anchors.has(cur)) continue;
    seen.add(cur);
    if (cur === target) return true;
    for (const e of forward) if (e.from === cur) stack.push(e.to);
  }
  return false;
}

function anchorSet(doc: WorkflowDocument): Set<string> {
  return new Set([
    ...(doc.spec.anchors ?? []),
    ...Object.entries(doc.spec.nodes)
      .filter(([, n]) => (n as unknown as AnyNode).kind === 'anchor')
      .map(([id]) => id),
  ]);
}

/**
 * Check a merged document against the plugin default. `authorized` is true when
 * the document named decision records that all resolve on the base branch.
 * Returns the refusals; `notes` receives authorized touches and promotions.
 */
export function enforceFrozenSet(
  merged: WorkflowDocument,
  base: WorkflowDocument,
  authorized: boolean,
  notes: string[] = [],
): string[] {
  const errors: string[] = [];
  const touch = (e: FrozenEntry, rule: string, what: string): void => {
    if (authorized) notes.push(`frozen entry '${e.id}' changed under a decision record: ${what}`);
    else errors.push(refuse(rule, what, e));
  };
  const baseAnchors = anchorSet(base);
  const frozenIds = new Set<string>(FROZEN_SET.flatMap((e) => e.nodes ?? []));
  for (const id of baseAnchors) frozenIds.add(id);

  for (const id of frozenIds) {
    const was = base.spec.nodes[id];
    if (was === undefined) continue;
    const now = merged.spec.nodes[id];
    if (now !== undefined && stable(now) === stable(was)) continue;
    const owner = FROZEN_SET.find((e) => e.nodes?.includes(id)) ?? entry('anchor');
    touch(
      owner,
      'frozen-node',
      `node '${id}' is frozen (${owner.rule}); it differs from the plugin default`,
    );
  }
  const mergedAnchors = anchorSet(merged);
  for (const a of baseAnchors) {
    if (!mergedAnchors.has(a) && merged.spec.nodes[a] === undefined) continue; // reported as frozen-node
    if (!mergedAnchors.has(a)) {
      touch(entry('anchor'), 'frozen-anchor', `anchor '${a}' was removed from spec.anchors`);
    }
  }
  const mergedEdges = merged.spec.edges.flatMap((e) => normEdge(e) ?? []);
  const ids = Object.keys(merged.spec.nodes);
  const ship = ids.find((id) => id === 'ship');
  if (ship && reachesWithoutAnchor(ids, mergedEdges, ship, mergedAnchors)) {
    errors.push(refuse('last-anchor', `a path to '${ship}' crosses no anchor`, entry('anchor')));
  }
  for (const [id, n] of Object.entries(merged.spec.nodes) as unknown as [string, AnyNode][]) {
    if (n.kind === 'anchor' && typeof n.impl === 'string') {
      const roles = new Set([
        ...AGENT_ROLES,
        ...Object.values(merged.spec.nodes)
          .filter((m) => (m as unknown as AnyNode).kind === 'agent')
          .map((m) => String((m as unknown as AnyNode).role)),
      ]);
      if (roles.has(n.impl)) {
        errors.push(
          refuse(
            'agent-anchor',
            `anchor '${id}' impl '${n.impl}' is an agent role`,
            entry('anchor'),
          ),
        );
      }
    }
  }

  const join = entry('fanout-join');
  for (const [id, was] of Object.entries(base.spec.nodes) as unknown as [string, AnyNode][]) {
    if (was.kind !== 'fanout') continue;
    const now = merged.spec.nodes[id] as unknown as AnyNode | undefined;
    if (now === undefined || now.kind !== 'fanout') {
      touch(
        join,
        'fanout-join',
        `fanout '${id}' was removed or replaced; reviewers join through it`,
      );
      continue;
    }
    if ((now.expect ?? 'all') !== (was.expect ?? 'all')) {
      touch(
        join,
        'fanout-join',
        `fanout '${id}' expect '${String(now.expect)}' loosens '${String(was.expect)}'`,
      );
    }
  }
  for (const [id, n] of Object.entries(merged.spec.nodes) as unknown as [string, AnyNode][]) {
    if (n.kind === 'fanout' && typeof n.cap === 'number' && n.cap > CEILINGS.fanoutCap) {
      touch(
        join,
        'cap-ceiling',
        `fanout '${id}' cap ${n.cap} exceeds the plugin ceiling ${CEILINGS.fanoutCap}`,
      );
    }
  }
  for (const e of mergedEdges) {
    if (e.loop && e.loop.max > CEILINGS.loopMax) {
      errors.push(
        refuse(
          'cap-ceiling',
          `loop ${e.from} -> ${e.to} max ${e.loop.max} exceeds the plugin ceiling ${CEILINGS.loopMax}`,
          [ITERATION_ENFORCER],
        ),
      );
    }
  }

  // Knobs that name a frozen rule are not knobs.
  for (const [id, n] of Object.entries(merged.spec.nodes) as unknown as [string, AnyNode][]) {
    const w = n.with as unknown as AnyNode | undefined;
    if (!w) continue;
    for (const f of FROZEN_SET) {
      if (
        f.id in w &&
        stable(w[f.id]) !==
          stable((base.spec.nodes[id] as unknown as AnyNode | undefined)?.with?.[f.id as never])
      ) {
        touch(f, 'frozen-knob', `node '${id}' with.${f.id} names a frozen rule (${f.rule})`);
      }
    }
    const lenses = w.lenses;
    if (lenses !== undefined) {
      if (!Array.isArray(lenses) || lenses.some((l) => !KNOWN_LENSES.includes(String(l)))) {
        errors.push(
          refuse(
            'lenses',
            `node '${id}' with.lenses must be a list of ${KNOWN_LENSES.join(', ')}`,
            [LENS_ENFORCER],
          ),
        );
      } else if (!lenses.includes('security')) {
        errors.push(
          refuse(
            'lenses',
            `node '${id}' with.lenses drops 'security'; the security reviewer always runs`,
            [LENS_ENFORCER],
          ),
        );
      } else if (lenses.includes('staged')) {
        const was = (base.spec.nodes[id] as unknown as AnyNode | undefined)?.with as unknown as
          AnyNode | undefined;
        if (!Array.isArray(was?.lenses) || !(was.lenses as string[]).includes('staged')) {
          notes.push(
            `staged lens promoted to gating on '${id}' (tightening; authorized by ${STAGED_PROMOTION_REF})`,
          );
        }
      }
    }
  }
  for (const [id, n] of Object.entries(merged.spec.nodes) as unknown as [string, AnyNode][]) {
    const was = base.spec.nodes[id] as unknown as AnyNode | undefined;
    if (was && was.gating === false && n.gating !== false) {
      notes.push(
        `node '${id}' promoted to gating (tightening; authorized by ${STAGED_PROMOTION_REF})`,
      );
    }
  }
  return errors;
}

/** Decision ids an overlay names, with the unresolved ones split out. */
function checkDecisions(
  raw: unknown,
  ctx: OverlayContext,
): { authorized: boolean; errors: string[]; ids: string[] } {
  const ids = Array.isArray(raw) ? raw.map(String) : [];
  const unresolved = ids.filter((d) => !ctx.decisionExists(d));
  return {
    authorized: ids.length > 0 && unresolved.length === 0,
    ids,
    errors: unresolved.map(
      (d) =>
        `decision-unresolved: ${d} does not resolve in the decision catalog on the base branch (a record in the working tree or an unmerged PR is not authority); enforcer: pipeline-cli/src/workflow/overlay.ts`,
    ),
  };
}

/** True when the parsed document asks to extend the plugin default. */
export function isOverlay(doc: unknown): boolean {
  const m = (doc as { metadata?: { extends?: unknown } } | null)?.metadata?.extends;
  return typeof m === 'string';
}

/** Check a full (non-overlay) document against the plugin default. */
export function checkFullDocument(doc: WorkflowDocument, ctx: OverlayContext): OverlayResult {
  const dec = checkDecisions((doc.metadata as { decisions?: unknown }).decisions, ctx);
  const notes: string[] = [];
  const errors = [
    ...dec.errors,
    ...enforceFrozenSet(doc, buildExecuteGraph(), dec.authorized, notes),
  ];
  return { ok: errors.length === 0, doc, errors, notes };
}

/** Apply an overlay document over the plugin default and enforce the frozen set. */
export function applyOverlay(
  overlay: unknown,
  ctx: OverlayContext,
  base: WorkflowDocument = buildExecuteGraph(),
): OverlayResult {
  const o = overlay as {
    metadata?: { name?: string; extends?: string; decisions?: unknown };
    spec?: {
      nodes?: Record<string, AnyNode>;
      edges?: unknown[];
      anchors?: string[];
      remove?: string[];
    };
  };
  const errors: string[] = [];
  const notes: string[] = [];
  const ext = EXTENDS_RE.exec(o?.metadata?.extends ?? '');
  if (!ext) {
    return {
      ok: false,
      errors: [
        `extends: '${String(o?.metadata?.extends)}' is not ai-sdlc/execute-task@<version>; enforcer: pipeline-cli/src/workflow/overlay.ts`,
      ],
      notes,
    };
  }
  if (typeof o.metadata?.name !== 'string' || o.metadata.name === '') {
    errors.push('schema: /metadata name is required');
  }
  const dec = checkDecisions(o.metadata?.decisions, ctx);
  errors.push(...dec.errors);

  const merged = clone(base);
  merged.metadata = { name: o.metadata?.name ?? base.metadata.name };
  const spec = o.spec ?? {};

  for (const id of spec.remove ?? []) {
    if (!(id in merged.spec.nodes)) {
      errors.push(
        `remove: node '${id}' is not in the extended document; enforcer: pipeline-cli/src/workflow/overlay.ts`,
      );
      continue;
    }
    delete merged.spec.nodes[id];
    const edges = merged.spec.edges.flatMap((e) => normEdge(e) ?? []);
    const into = edges.filter((e) => e.to === id && !e.loop);
    const out = edges.filter((e) => e.from === id && !e.loop);
    const rest = edges.filter((e) => e.from !== id && e.to !== id);
    for (const a of into) {
      for (const b of out)
        rest.push({
          from: a.from,
          to: b.to,
          ...((a.when ?? b.when) ? { when: a.when ?? b.when } : {}),
        });
    }
    merged.spec.edges = rest;
    if (merged.spec.anchors) merged.spec.anchors = merged.spec.anchors.filter((a) => a !== id);
  }
  for (const [id, patch] of Object.entries(spec.nodes ?? {})) {
    const cur = merged.spec.nodes[id] as unknown as AnyNode | undefined;
    if (cur === undefined) {
      (merged.spec.nodes as unknown as Record<string, AnyNode>)[id] = patch;
      continue;
    }
    const next: AnyNode = { ...cur, ...patch };
    if (cur.with || patch.with)
      next.with = { ...(cur.with as unknown as AnyNode), ...(patch.with as unknown as AnyNode) };
    (merged.spec.nodes as unknown as Record<string, AnyNode>)[id] = next;
  }
  const have = new Set(merged.spec.edges.map((e) => stable(normEdge(e))));
  for (const raw of spec.edges ?? []) {
    const e = normEdge(raw);
    if (!e) {
      errors.push(
        `edge: '${stable(raw)}' is not an edge; enforcer: spec/schemas/workflow.schema.json`,
      );
      continue;
    }
    if (e.loop) {
      const idx = merged.spec.edges.findIndex((m) => {
        const n = normEdge(m);
        return n?.loop && n.from === e.from && n.to === e.to;
      });
      if (idx >= 0) {
        merged.spec.edges[idx] = e;
        continue;
      }
    }
    if (!have.has(stable(e))) merged.spec.edges.push(e);
  }
  if (spec.anchors) {
    merged.spec.anchors = [...new Set([...(merged.spec.anchors ?? []), ...spec.anchors])];
  }

  errors.push(...enforceFrozenSet(merged, base, dec.authorized, notes));
  if (dec.authorized) notes.push(`authorized by ${dec.ids.join(', ')}`);
  return { ok: errors.length === 0, doc: errors.length === 0 ? merged : undefined, errors, notes };
}

/** Base-branch decision lookup input: the file names under the events dir plus the legacy log. */
export function decisionLookup(
  eventFileNames: string[],
  legacyLog: string,
): (id: string) => boolean {
  const ids = new Set<string>();
  for (const n of eventFileNames) {
    const m = /__(DEC-[0-9]+)__/.exec(n);
    if (m) ids.add(m[1]);
  }
  for (const m of legacyLog.matchAll(/"decisionId":"(DEC-[0-9]+)"/g)) ids.add(m[1]);
  return (id) => ids.has(id);
}
