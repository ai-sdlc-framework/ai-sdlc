/**
 * Gate 5 — Affected surface is named.
 *
 * Stage A (deterministic, hybrid per RFC §4.4): regex for presence of
 * file paths, route patterns, system identifiers, named components.
 *
 * The Stage A pass condition is "at least one of the following appears
 * somewhere in title or body":
 *   - A backtick-quoted file path (`pipeline-cli/src/foo.ts`)
 *   - A bare repo path with an extension (`spec/rfcs/RFC-0011.md`)
 *   - A route pattern (`/api/...`, `POST /foo/bar`)
 *   - An RFC ID (`RFC-NNNN`) or AISDLC ID (`AISDLC-NN`)
 *   - A named system component (CamelCase identifier, MAYBE — too noisy
 *     by itself; must be combined with another signal)
 *
 * If NO surface signal is present, Stage A fails with the standard
 * "name the affected surface" finding. Stage B (Phase 2b) judges
 * whether the surface is *specific enough*; Stage A only catches the
 * case where it's missing entirely.
 */

import type { GateEvaluation, IssueInput } from '../types.js';

const SURFACE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'backtick-path', re: /`([\w./-]+\/[\w./-]+\.[a-zA-Z0-9]+)`/ },
  {
    name: 'backtick-config-file',
    re: /`(?:\.?[\w.-]+\.(?:json|ya?ml|toml|ini|conf|mjs|cjs|js|ts|md|sh|env)|CHANGELOG\.md|README\.md|LICENSE|CODEOWNERS)`/,
  },
  { name: 'bare-path', re: /(?<![\w/])([\w-]+\/[\w./-]+\.[a-zA-Z0-9]{1,8})/ },
  { name: 'route-pattern', re: /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[\w/{}:.-]+/ },
  {
    name: 'api-path',
    re: /(?<![\w/])\/(?:api|v\d+|app|admin|dashboard|auth|users|search|graphql|mcp)\/[\w/{}:.-]+/,
  },
  { name: 'rfc-ref', re: /\bRFC-\d{4}\b/ },
  { name: 'aisdlc-ref', re: /\bAISDLC-\d+(?:\.\d+)?\b/ },
  { name: 'workspace-package', re: /@[\w-]+\/[\w-]+/ },
  { name: 'database-table', re: /\b(?:table|column|schema)\s+`?[a-zA-Z_][\w]*`?\b/i },
  { name: 'github-workflow', re: /\.github\/workflows\/[\w.-]+\.ya?ml/ },
];

export function findSurfaceSignals(text: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of SURFACE_PATTERNS) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

export function evaluateGate5(input: IssueInput): GateEvaluation {
  const haystack = `${input.title}\n${input.body}`;
  const signals = findSurfaceSignals(haystack);

  if (signals.length === 0) {
    return {
      gateId: 5,
      verdict: 'fail',
      severity: 'block',
      stage: 'A',
      confidence: 'high',
      finding:
        'No affected-surface signal found in title or body (file path, route, RFC/AISDLC ID, workflow file, or named component).',
      clarificationQuestion:
        'Name the file path, route, RFC ID, workflow file, or specific component this issue changes. "the dashboard" / "search" / "the auth flow" without a concrete reference is too vague.',
    };
  }

  // Stage A passes — Stage B (Phase 2b) judges whether the named surface
  // is *specific enough* to be actionable.
  return {
    gateId: 5,
    verdict: 'pass',
    severity: 'block',
    stage: 'A',
    confidence: 'medium',
    finding: `Stage A surface signals: ${signals.join(', ')}.`,
  };
}
