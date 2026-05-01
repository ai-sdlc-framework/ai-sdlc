/**
 * Gate 7 — No invisible dependencies.
 *
 * Stage A (deterministic, hybrid per RFC §4.4): regex for dependency
 * phrases ("requires X", "depends on X", "after X ships", "blocked by
 * X", "once X lands") and for each match, check whether a tracked
 * issue / RFC ID / linked PR is in the same sentence or in the
 * `dependencies:` frontmatter list (passed in via `input.references`).
 *
 * The Stage A pass condition is "every dependency phrase has at least
 * one accompanying tracked-work reference (AISDLC-NN, RFC-NNNN,
 * `#NN`, or markdown link)". Phrases without a reference fail.
 *
 * Stage B (Phase 2b) catches "unstated structural assumptions" — this
 * gate's regex side only catches the case where the author *names* a
 * dependency but doesn't link it.
 */

import type { GateEvaluation, IssueInput } from '../types.js';

const DEP_PHRASE_RE =
  /\b(?:requires|depends\s+on|blocked\s+by|after\s+\w+(?:\s+\w+){0,3}\s+(?:ships|lands|merges|is\s+(?:done|finished|complete))|once\s+\w+(?:\s+\w+){0,3}\s+(?:ships|lands|merges|is\s+(?:done|finished|complete))|prerequisite|pre-?requisite)\b/gi;

const REF_NEAR_RE =
  /(?:\bAISDLC-\d+(?:\.\d+)?|\bRFC-\d{4}|(?<![\w/])(?:gh)?#\d+|\b[\w.-]+\/[\w.-]+#\d+|\bhttps?:\/\/[^\s)]+)/i;

/**
 * Returns the offending dependency phrases — phrases that name a
 * prerequisite but have no tracked-work reference within the same
 * sentence (or in the `references[]` input).
 */
export function findInvisibleDependencies(
  input: IssueInput,
): Array<{ phrase: string; sentence: string }> {
  const haystack = input.body;
  const sentences = splitIntoSentences(haystack);
  const explicitRefs = input.references ?? [];
  const hasExplicitRef = explicitRefs.length > 0;

  const out: Array<{ phrase: string; sentence: string }> = [];
  for (const sentence of sentences) {
    DEP_PHRASE_RE.lastIndex = 0;
    const phrases: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = DEP_PHRASE_RE.exec(sentence)) !== null) {
      phrases.push(m[0]);
    }
    if (phrases.length === 0) continue;
    // Sentence has a dep phrase. Does the same sentence also carry a ref?
    if (REF_NEAR_RE.test(sentence)) continue;
    // Or is there a global explicit ref list (frontmatter dependencies)?
    if (hasExplicitRef) continue;
    for (const phrase of phrases) {
      out.push({ phrase, sentence: sentence.trim().slice(0, 200) });
    }
  }
  return out;
}

function splitIntoSentences(text: string): string[] {
  // Light-weight sentence split — preserves dep-phrase locality without
  // pulling in a full NLP dependency. Splits on `.`, `?`, `!`, newline,
  // and bullet markers.
  return text
    .split(/(?<=[.?!])\s+|\n+|^[-*]\s+/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function evaluateGate7(input: IssueInput): GateEvaluation {
  const offenders = findInvisibleDependencies(input);
  if (offenders.length === 0) {
    return {
      gateId: 7,
      verdict: 'pass',
      severity: 'block',
      stage: 'A',
      confidence: 'medium',
    };
  }
  const sample = offenders
    .slice(0, 3)
    .map((o) => `'${o.phrase}' in: "${o.sentence}"`)
    .join(' | ');
  return {
    gateId: 7,
    verdict: 'fail',
    severity: 'block',
    stage: 'A',
    confidence: 'high',
    finding: `${offenders.length} dependency phrase(s) lack a tracked-work reference: ${sample}.`,
    clarificationQuestion:
      'Every "requires / depends on / blocked by / after X ships" phrase must link to an existing tracked issue (AISDLC-NN, RFC-NNNN, #NN, or markdown URL).',
  };
}
