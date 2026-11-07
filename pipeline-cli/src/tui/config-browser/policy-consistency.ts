/**
 * Bounded policy consistency check (RFC-0062 OQ-6, DEC-0390, AISDLC-1215).
 *
 * No SAT or SMT dependency. Two checks over the small boolean systems in config:
 *   1. Pairwise contradiction (polynomial, unbounded): an AutonomyPolicy level that lists the
 *      same path glob as allowed (permissions.read/write) and as blocked (guardrails.blockedPaths).
 *   2. Reachability (truth table, bounded by `maxPolicyVariables`, default 20): every enforcement
 *      level a QualityGate declares must be reachable by some assignment that satisfies at least
 *      one gate at that level. A gate's optional `when` is a list of flag literals (`flag` or
 *      `!flag`) that must all hold.
 * The compliance artefact is the rule id pair (or the level) plus a witness assignment.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_POLICY_VARIABLES = 20;

export interface ConsistencyFinding {
  kind: 'contradiction' | 'unreachable-level' | 'too-many-variables';
  message: string;
  /** Rule ids involved (two for a contradiction). */
  ruleIds: string[];
  /** Witness assignment: a path for contradictions, flag values for reachability. */
  witness: Record<string, unknown>;
}

export interface ConsistencyArtefact {
  kind: string;
  policy: string;
  findings: ConsistencyFinding[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function witnessPath(glob: string): string {
  return glob.replace(/\*\*/g, 'x/x').replace(/\*/g, 'x');
}

function checkAutonomy(spec: Record<string, unknown>): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const levels = Array.isArray(spec.levels) ? spec.levels : [];
  levels.forEach((lv, li) => {
    if (!isObj(lv)) return;
    const id = `levels[${String(lv.level ?? li)}]`;
    const perms = isObj(lv.permissions) ? lv.permissions : {};
    const blocked = strList(isObj(lv.guardrails) ? lv.guardrails.blockedPaths : undefined);
    for (const op of ['read', 'write'] as const) {
      strList(perms[op]).forEach((allow, ai) => {
        blocked.forEach((block, bi) => {
          if (allow !== block) return;
          const a = `${id}.permissions.${op}[${ai}]`;
          const b = `${id}.guardrails.blockedPaths[${bi}]`;
          const p = witnessPath(allow);
          findings.push({
            kind: 'contradiction',
            message: `Contradicting rules ${a} and ${b}: path "${allow}" is both always-allowed and always-blocked (witness path "${p}")`,
            ruleIds: [a, b],
            witness: { path: p, allowedBy: a, blockedBy: b },
          });
        });
      });
    }
  });
  return findings;
}

interface Gate {
  id: string;
  enforcement: string;
  /** Required values: flag name to boolean. `null` means the gate's own `when` is contradictory. */
  required: Map<string, boolean> | null;
}

function parseGates(spec: Record<string, unknown>): Gate[] {
  const gates = Array.isArray(spec.gates) ? spec.gates : [];
  const out: Gate[] = [];
  gates.forEach((g, i) => {
    if (!isObj(g) || typeof g.enforcement !== 'string') return;
    const id = typeof g.name === 'string' ? `gates[${g.name}]` : `gates[${i}]`;
    let required: Map<string, boolean> | null = new Map();
    for (const lit of strList(g.when)) {
      const neg = lit.startsWith('!');
      const name = neg ? lit.slice(1) : lit;
      const want = !neg;
      if (required.has(name) && required.get(name) !== want) required = null;
      if (required === null) break;
      required.set(name, want);
    }
    out.push({ id, enforcement: g.enforcement, required });
  });
  return out;
}

function checkEnforcement(spec: Record<string, unknown>): ConsistencyFinding[] {
  const gates = parseGates(spec);
  if (gates.length === 0) return [];
  const declared = strList(spec.enforcementLevels);
  const levels = declared.length > 0 ? declared : [...new Set(gates.map((g) => g.enforcement))];
  const vars = new Set<string>();
  for (const g of gates) g.required?.forEach((_, k) => vars.add(k));
  const rawMax = spec.maxPolicyVariables;
  const max =
    typeof rawMax === 'number' && Number.isInteger(rawMax) && rawMax >= 0
      ? rawMax
      : DEFAULT_MAX_POLICY_VARIABLES;
  if (vars.size > max) {
    return [
      {
        kind: 'too-many-variables',
        message: `Policy uses ${vars.size} variables, exceeding maxPolicyVariables (${max}); reachability was not checked. Reduce flags or raise maxPolicyVariables.`,
        ruleIds: [],
        witness: { variables: vars.size, maxPolicyVariables: max },
      },
    ];
  }
  const names = [...vars];
  const bit = new Map(names.map((n, i) => [n, 1 << i]));
  const compiled = gates.map((g) => {
    let mask = 0;
    let value = 0;
    g.required?.forEach((want, k) => {
      mask |= bit.get(k)!;
      if (want) value |= bit.get(k)!;
    });
    return { g, mask, value };
  });
  const findings: ConsistencyFinding[] = [];
  for (const level of levels) {
    const mine = compiled.filter((c) => c.g.enforcement === level && c.g.required !== null);
    let hit: { assign: number; id: string } | null = null;
    outer: for (let assign = 0; assign < 1 << names.length; assign++) {
      for (const c of mine) {
        if ((assign & c.mask) === c.value) {
          hit = { assign, id: c.g.id };
          break outer;
        }
      }
    }
    if (hit) continue;
    const ids = gates.filter((g) => g.enforcement === level).map((g) => g.id);
    findings.push({
      kind: 'unreachable-level',
      message: `Enforcement level "${level}" is unreachable: no assignment of ${names.length} variables satisfies any gate at that level${ids.length ? ` (${ids.join(', ')})` : ' (no gate declares it)'}`,
      ruleIds: ids,
      witness: { level, variables: names, assignmentsChecked: 2 ** names.length },
    });
  }
  return findings;
}

/** Run the bounded consistency check on a parsed AutonomyPolicy or QualityGate document. */
export function checkPolicyConsistency(kind: string, doc: unknown): ConsistencyArtefact | null {
  if (!isObj(doc) || !isObj(doc.spec)) return null;
  if (kind !== 'AutonomyPolicy' && kind !== 'QualityGate') return null;
  const meta = isObj(doc.metadata) ? doc.metadata : {};
  const findings = kind === 'AutonomyPolicy' ? checkAutonomy(doc.spec) : checkEnforcement(doc.spec);
  return {
    kind,
    policy: typeof meta.name === 'string' ? meta.name : 'unnamed',
    findings,
  };
}

/** Write the compliance artefact to `<dir>/policy-consistency-<policy>.json`; returns the path. */
export function writeConsistencyArtefact(dir: string, artefact: ConsistencyArtefact): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `policy-consistency-${artefact.policy.replace(/[^A-Za-z0-9._-]/g, '_')}.json`,
  );
  writeFileSync(file, JSON.stringify(artefact, null, 2) + '\n');
  return file;
}
