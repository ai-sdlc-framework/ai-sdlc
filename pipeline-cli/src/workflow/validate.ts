/**
 * Workflow document validator (RFC-0056 phase 2). One function shared by
 * `ai-sdlc doctor` (via `cli-workflow validate`) and, later, the engine.
 * Schema first, then the rules a schema cannot state: dangling edges, a cycle
 * with no declared `loop`, an anchor naming an agent role, and every edge `when`
 * parsed by the reference expression evaluator with its identifiers checked
 * against the declared outputs of upstream nodes.
 *
 * @module workflow/validate
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createSimpleExpressionEvaluator, SCHEMAS } from '@ai-sdlc/reference';
import { load } from 'js-yaml';
import { MACHINE_STEPS } from './graph.js';

export interface WorkflowValidationResult {
  ok: boolean;
  /** One line per failing rule, each starting with the rule name. */
  errors: string[];
}

type Validator = ReturnType<InstanceType<typeof Ajv2020>['compile']>;
let schemaValidator: Validator | undefined;

function getSchemaValidator(): Validator {
  if (!schemaValidator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    schemaValidator = ajv.compile(SCHEMAS['workflow.schema.json']);
  }
  return schemaValidator;
}

interface Node {
  kind: string;
  impl?: string;
  role?: string;
}
interface Edge {
  from: string;
  to: string;
  when?: string;
  loop?: { max: number };
}

const OUTPUT_FIELDS = new Map<string, readonly string[]>(
  MACHINE_STEPS.map((s) => [s.id, s.outputFields ?? []]),
);

export function normalizeEdge(e: unknown): Edge | undefined {
  if (typeof e === 'string') {
    const m = e.match(/^\s*([A-Za-z0-9_-]+)\s*->\s*([A-Za-z0-9_-]+)\s*$/);
    return m ? { from: m[1], to: m[2] } : undefined;
  }
  return e as Edge;
}

/** Identifiers a `when` reads: left operands and bare/negated operands; dotted right operands. */
export function whenIdentifiers(expr: string): string[] {
  const out: string[] = [];
  const bare = (tok: string, force: boolean): void => {
    const t = tok.trim().replace(/^!+/, '').trim();
    if (!/^[A-Za-z_][\w]*(\.[\w]+)*$/.test(t)) return;
    if (['true', 'false', 'null'].includes(t)) return;
    if (force || t.includes('.')) out.push(t);
  };
  const stripped = expr.replace(/'[^']*'|"[^"]*"/g, '"s"');
  for (const clause of stripped.split(/&&|\|\|/)) {
    const m = clause.match(/^(.*?)\s*(?:>=|<=|!=|==|>|<|\scontains\s)\s*(.*)$/);
    if (m) {
      bare(m[1], true);
      bare(m[2], false);
    } else {
      bare(clause, true);
    }
  }
  return out;
}

function ancestors(id: string, edges: Edge[]): Set<string> {
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const e of edges) {
      if (e.to === cur && !seen.has(e.from)) {
        seen.add(e.from);
        stack.push(e.from);
      }
    }
  }
  return seen;
}

function hasCycle(ids: string[], edges: Edge[]): boolean {
  const state = new Map<string, number>();
  const visit = (n: string): boolean => {
    state.set(n, 1);
    for (const e of edges) {
      if (e.from !== n) continue;
      const s = state.get(e.to) ?? 0;
      if (s === 1 || (s === 0 && visit(e.to))) return true;
    }
    state.set(n, 2);
    return false;
  };
  return ids.some((n) => (state.get(n) ?? 0) === 0 && visit(n));
}

function semanticErrors(doc: {
  spec: { nodes: Record<string, Node>; edges: unknown[]; anchors?: string[] };
}): string[] {
  const errors: string[] = [];
  const { nodes } = doc.spec;
  const ids = Object.keys(nodes);
  const edges: Edge[] = [];
  for (const raw of doc.spec.edges) {
    const e = normalizeEdge(raw);
    if (!e) continue;
    edges.push(e);
    for (const end of [e.from, e.to]) {
      if (!(end in nodes))
        errors.push(`edge-endpoint: edge ${e.from} -> ${e.to} names unknown node '${end}'`);
    }
  }
  for (const a of doc.spec.anchors ?? []) {
    if (!(a in nodes)) errors.push(`anchor-unknown: anchors lists unknown node '${a}'`);
  }
  const roles = new Set(
    Object.values(nodes)
      .filter((n) => n.kind === 'agent')
      .map((n) => n.role as string),
  );
  for (const [id, n] of Object.entries(nodes)) {
    if (n.kind === 'anchor' && n.impl && roles.has(n.impl)) {
      errors.push(`anchor-impl-agent: anchor '${id}' impl '${n.impl}' is an agent role`);
    }
  }
  if (
    hasCycle(
      ids,
      edges.filter((e) => !e.loop),
    )
  ) {
    errors.push('undeclared-loop: the edges form a cycle that has no edge with a `loop: { max }`');
  }
  const evaluator = createSimpleExpressionEvaluator();
  for (const e of edges) {
    if (e.when === undefined) continue;
    const verdict = evaluator.validate?.(e.when) ?? { valid: true };
    if (!verdict.valid) {
      errors.push(
        `when-syntax: edge ${e.from} -> ${e.to}: ${verdict.error ?? 'invalid expression'}`,
      );
      continue;
    }
    try {
      evaluator.evaluate(e.when, {});
    } catch (err) {
      errors.push(`when-syntax: edge ${e.from} -> ${e.to}: ${(err as Error).message}`);
      continue;
    }
    const upstream = ancestors(e.from, edges);
    const declared = new Set<string>();
    for (const u of upstream) {
      const n = nodes[u];
      if (!n) continue;
      declared.add(u);
      if (n.kind === 'step' && n.impl)
        for (const f of OUTPUT_FIELDS.get(n.impl) ?? []) declared.add(f);
    }
    for (const ident of whenIdentifiers(e.when)) {
      if (!declared.has(ident.split('.')[0])) {
        errors.push(
          `when-identifier: edge ${e.from} -> ${e.to}: '${ident}' is not a declared output of an upstream node`,
        );
      }
    }
  }
  return errors;
}

/** Validate a parsed Workflow document. Never throws. */
export function validateWorkflowDocument(doc: unknown): WorkflowValidationResult {
  const validate = getSchemaValidator();
  if (!validate(doc)) {
    const errors = (validate.errors ?? []).map(
      (e) => `schema: ${e.instancePath || '/'} ${e.message ?? 'is invalid'}`,
    );
    return { ok: false, errors };
  }
  const errors = semanticErrors(doc as Parameters<typeof semanticErrors>[0]);
  return { ok: errors.length === 0, errors };
}

/** Validate Workflow YAML text. */
export function validateWorkflowYaml(text: string): WorkflowValidationResult {
  let doc: unknown;
  try {
    doc = load(text);
  } catch (err) {
    return { ok: false, errors: [`parse: ${(err as Error).message.split('\n')[0]}`] };
  }
  return validateWorkflowDocument(doc);
}
