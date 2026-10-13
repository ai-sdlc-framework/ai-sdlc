/**
 * Gate 2 — No unresolved markers in the body.
 *
 * Stage A (deterministic, fully owns this gate per RFC §4.4 — no Stage B).
 * The agent looks for placeholder phrases the author left meaning to
 * fill in later. Hits anywhere in the body block fail the gate.
 *
 * Patterns mirror the RFC §4.1 + §4.4 examples:
 *   TBD / TODO / XXX / FIXME / ??? as bare tokens
 *   "not sure", "we'll figure out", "decide later", "up to the dev",
 *   "tbd", "to be determined", "tba" etc.
 *
 * The matcher is **case-insensitive** and uses `\b` word boundaries on
 * the bare-token forms so legitimate words like "fixmessage" don't
 * trigger false positives. Code blocks (``` fenced ```) are stripped
 * before matching so genuine `// TODO` snippets in code samples don't
 * trip the gate — those are content, not author placeholders.
 */

import type { GateEvaluation, IssueInput } from '../types.js';

interface MarkerPattern {
  re: RegExp;
  description: string;
}

const MARKER_PATTERNS: MarkerPattern[] = [
  { re: /\bTBD\b/i, description: 'TBD placeholder' },
  { re: /\bTODO\b/, description: 'TODO placeholder' },
  { re: /\bXXX\b/, description: 'XXX placeholder' },
  { re: /\bFIXME\b/i, description: 'FIXME placeholder' },
  { re: /\?\?\?+/, description: '"???" placeholder' },
  { re: /\bnot\s+sure\b/i, description: '"not sure" hedge' },
  {
    re: /\bwe'?ll\s+figure\s+(it|that|this)\s+out\b/i,
    description: '"we\'ll figure ... out" hedge',
  },
  { re: /\bdecide\s+later\b/i, description: '"decide later" hedge' },
  { re: /\bup\s+to\s+(the\s+dev|whoever)\b/i, description: '"up to the dev/whoever" hedge' },
  { re: /\bto\s+be\s+determined\b/i, description: '"to be determined" placeholder' },
  { re: /\bto\s+be\s+decided\b/i, description: '"to be decided" placeholder' },
  { re: /\bplaceholder\b/i, description: '"placeholder" word' },
];

/**
 * Strip fenced code blocks (``` ... ```) from a markdown body so
 * "// TODO" inside a code sample doesn't trip the gate. Inline code
 * spans (`` `foo` ``) are left intact — markers there are still
 * author placeholders.
 */
export function stripFencedCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, '');
}

export function findMarkers(body: string): Array<{ marker: string; description: string }> {
  const stripped = stripFencedCode(body);
  const hits: Array<{ marker: string; description: string }> = [];
  for (const p of MARKER_PATTERNS) {
    const m = stripped.match(p.re);
    if (m) {
      hits.push({ marker: m[0], description: p.description });
    }
  }
  return hits;
}

export function evaluateGate2(input: IssueInput): GateEvaluation {
  const hits = findMarkers(input.body);
  if (hits.length === 0) {
    return {
      gateId: 2,
      verdict: 'pass',
      severity: 'block',
      stage: 'A',
      confidence: 'high',
    };
  }
  const summary = hits
    .slice(0, 5)
    .map((h) => `'${h.marker}' (${h.description})`)
    .join('; ');
  return {
    gateId: 2,
    verdict: 'fail',
    severity: 'block',
    stage: 'A',
    confidence: 'high',
    finding: `Body contains ${hits.length} unresolved marker(s): ${summary}.`,
    clarificationQuestion:
      'Resolve every TBD / TODO / "we\'ll figure out" / "decide later" placeholder before re-submitting.',
  };
}
