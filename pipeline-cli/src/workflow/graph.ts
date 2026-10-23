/**
 * Derive the current execute Machine (`next-step/next-step.ts`) as a Workflow
 * document and Mermaid (RFC-0056 phase 1). Read-only; nothing in the execute
 * path imports this module. Node `impl` ids come from the step metadata, the
 * loop cap from the single iteration constant.
 *
 * @module workflow/graph
 */
import { dump } from 'js-yaml';
import { PARENT_UPKEEP_STEP } from '../steps/00-parent-upkeep.js';
import { VALIDATE_STEP } from '../steps/01-validate.js';
import { COMPUTE_BRANCH_STEP } from '../steps/02-compute-branch.js';
import { SETUP_WORKTREE_STEP } from '../steps/03-setup-worktree.js';
import { FLIP_STATUS_STEP } from '../steps/04-flip-status.js';
import { BUILD_DEV_PROMPT_STEP } from '../steps/05-build-dev-prompt.js';
import { PARSE_DEV_RETURN_STEP } from '../steps/06-parse-dev-return.js';
import { BUILD_REVIEW_PROMPTS_STEP } from '../steps/07-build-review-prompts.js';
import { AGGREGATE_VERDICTS_STEP } from '../steps/08-aggregate-verdicts.js';
import { DEFAULT_MAX_ITERATIONS, ITERATE_STEP } from '../steps/09-iterate.js';
import { FINALIZE_STEP } from '../steps/10-finalize.js';
import { PUSH_AND_PR_STEP } from '../steps/11-push-and-pr.js';
import { SIBLING_PRS_STEP } from '../steps/12-sibling-prs.js';
import { CLEANUP_STEP } from '../steps/13-cleanup.js';
import type { StepMeta } from '../steps/step-meta.js';

/** Every step the Machine visits, in execution order. */
export const MACHINE_STEPS: readonly StepMeta[] = [
  PARENT_UPKEEP_STEP,
  VALIDATE_STEP,
  COMPUTE_BRANCH_STEP,
  SETUP_WORKTREE_STEP,
  FLIP_STATUS_STEP,
  BUILD_DEV_PROMPT_STEP,
  PARSE_DEV_RETURN_STEP,
  BUILD_REVIEW_PROMPTS_STEP,
  AGGREGATE_VERDICTS_STEP,
  ITERATE_STEP,
  FINALIZE_STEP,
  PUSH_AND_PR_STEP,
  SIBLING_PRS_STEP,
  CLEANUP_STEP,
];

export interface WorkflowNode {
  kind: 'step' | 'agent' | 'fanout';
  impl?: string;
  role?: string;
  inputs?: string;
  outputs?: string;
  over?: string;
  cap?: number;
  expect?: string;
  fresh?: boolean;
  node?: { kind: 'agent'; role: string; fresh: boolean };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  when?: string;
  loop?: { max: number };
}

export interface WorkflowDocument {
  apiVersion: string;
  kind: 'Workflow';
  metadata: { name: string };
  spec: { nodes: Record<string, WorkflowNode>; edges: WorkflowEdge[] };
}

/** Reviewer fan-out cap of the Machine (security + code + test + staged slot). */
const REVIEW_FANOUT_CAP = 4;

function step(meta: StepMeta): WorkflowNode {
  return { kind: 'step', impl: meta.id, inputs: meta.inputs, outputs: meta.outputs };
}

export function buildExecuteGraph(): WorkflowDocument {
  const nodes: Record<string, WorkflowNode> = {
    upkeep: step(PARENT_UPKEEP_STEP),
    validate: step(VALIDATE_STEP),
    branch: step(COMPUTE_BRANCH_STEP),
    worktree: step(SETUP_WORKTREE_STEP),
    flip: step(FLIP_STATUS_STEP),
    prompt: step(BUILD_DEV_PROMPT_STEP),
    develop: { kind: 'agent', role: 'developer' },
    parse: step(PARSE_DEV_RETURN_STEP),
    plan: step(BUILD_REVIEW_PROMPTS_STEP),
    review: {
      kind: 'fanout',
      over: 'plan.reviewers',
      cap: REVIEW_FANOUT_CAP,
      expect: 'all',
      node: { kind: 'agent', role: '${item.role}', fresh: true },
    },
    aggregate: step(AGGREGATE_VERDICTS_STEP),
    iterate: step(ITERATE_STEP),
    finalize: step(FINALIZE_STEP),
    ship: step(PUSH_AND_PR_STEP),
    siblings: step(SIBLING_PRS_STEP),
    cleanup: step(CLEANUP_STEP),
  };
  const chain = (ids: string[]): WorkflowEdge[] =>
    ids.slice(1).map((to, i) => ({ from: ids[i], to }));
  const edges: WorkflowEdge[] = [
    ...chain(['upkeep', 'validate', 'branch', 'worktree', 'flip', 'prompt', 'develop', 'parse']),
    ...chain(['parse', 'plan', 'review', 'aggregate']),
    { from: 'aggregate', to: 'iterate', when: 'decision == CHANGES_REQUESTED' },
    { from: 'iterate', to: 'develop', loop: { max: DEFAULT_MAX_ITERATIONS } },
    { from: 'aggregate', to: 'finalize', when: 'decision == APPROVED' },
    ...chain(['finalize', 'ship', 'siblings', 'cleanup']),
  ];
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'Workflow',
    metadata: { name: 'execute-task' },
    spec: { nodes, edges },
  };
}

export function renderYaml(doc: WorkflowDocument): string {
  return dump(doc, { lineWidth: -1, noRefs: true });
}

export function renderMermaid(doc: WorkflowDocument): string {
  const lines = ['flowchart TD'];
  for (const [id, n] of Object.entries(doc.spec.nodes)) {
    const label = n.impl ?? n.role ?? id;
    const text = `${id}: ${n.kind} ${label}`;
    lines.push(n.kind === 'step' ? `  ${id}["${text}"]` : `  ${id}(["${text}"])`);
  }
  for (const e of doc.spec.edges) {
    const label = [e.when, e.loop ? `loop max ${e.loop.max}` : undefined]
      .filter(Boolean)
      .join(', ');
    lines.push(label ? `  ${e.from} -->|"${label}"| ${e.to}` : `  ${e.from} --> ${e.to}`);
  }
  return lines.join('\n') + '\n';
}
