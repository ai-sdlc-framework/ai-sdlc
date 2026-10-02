import type { JudgmentDefinition } from '../definition.js';
import type { JudgmentQuestion } from '../types.js';

/** Lines of context sent either side of a cited line. */
export const GROUNDING_CONTEXT_LINES = 30;

export type GroundingRelation = 'supports' | 'contradicts' | 'unrelated' | 'cannot-tell';

/** Relations that make an annotation worth surfacing. */
export const GROUNDING_FLAGGED: readonly string[] = [
  'contradicts',
  'unrelated',
  'location-not-found',
];

export interface GroundingItem {
  /** Stable id within one evaluation (also the question id). */
  id: string;
  /** Reviewer that produced the finding. */
  agentId: string;
  /** Index of the finding within that reviewer's findings. */
  findingIndex: number;
  /** The finding's message: what it claims about the code. */
  claim: string;
  file: string;
  line: number;
  /** Line number of the first excerpt line. */
  excerptStart: number;
  /** The cited line with up to 30 lines of context either side. */
  excerpt: string;
}

export interface FindingGroundingInput {
  items: GroundingItem[];
}

export interface FindingGroundingAnnotation {
  agentId: string;
  findingIndex: number;
  file: string;
  line: number;
  relation: GroundingRelation | 'location-not-found';
}

export interface FindingGroundingDecision {
  annotations: FindingGroundingAnnotation[];
}

/**
 * Cut the cited line plus context out of a file's text. Returns undefined when the
 * line is not in range (1-based).
 */
export function extractExcerpt(
  text: string,
  line: number,
): { excerpt: string; excerptStart: number } | undefined {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return undefined;
  const start = Math.max(1, line - GROUNDING_CONTEXT_LINES);
  const end = Math.min(lines.length, line + GROUNDING_CONTEXT_LINES);
  return { excerpt: lines.slice(start - 1, end).join('\n'), excerptStart: start };
}

/**
 * Advisory check: how does the cited code relate to a review finding's claim?
 * One Choice per finding; all findings that fit the state budget share a request.
 * Tighten-only: it annotates, it never alters or drops a finding.
 */
export const findingGroundingJudgment: JudgmentDefinition<
  FindingGroundingInput,
  FindingGroundingDecision
> = {
  id: 'review.finding-grounding',
  version: 1,
  // The judgment also sends a code excerpt; the caller requires `code-diff` to be allowed too.
  egressClass: 'agent-output',
  direction: 'tighten-only',
  riskClass: 'tighten',
  buildState: (input) => ({
    findings: input.items.map((it) => ({
      id: it.id,
      claim: it.claim,
      file: it.file,
      line: it.line,
      excerptStart: it.excerptStart,
      excerpt: it.excerpt,
    })),
  }),
  questions: (input) => {
    const questions: Record<string, JudgmentQuestion> = {};
    input.items.forEach((it, i) => {
      questions[it.id] = {
        type: 'choice',
        instructions:
          `How does the code in findings[${i}].excerpt relate to the claim in ` +
          `findings[${i}].claim? The cited line is findings[${i}].line.`,
        options: {
          supports: 'The code shows what the claim says.',
          contradicts: 'The code shows the opposite of what the claim says.',
          unrelated: 'The code has nothing to do with the claim.',
          'cannot-tell': 'The excerpt is not enough to decide.',
        },
      };
    });
    return questions;
  },
  compose: (answers, input) => {
    const annotations: FindingGroundingAnnotation[] = input.items.map((it) => {
      const answer = answers[it.id];
      const choice = answer?.type === 'choice' ? answer.choice : 'cannot-tell';
      const relation: GroundingRelation =
        choice === 'supports' || choice === 'contradicts' || choice === 'unrelated'
          ? choice
          : 'cannot-tell';
      return {
        agentId: it.agentId,
        findingIndex: it.findingIndex,
        file: it.file,
        line: it.line,
        relation,
      };
    });
    const flagged = annotations.filter((a) => GROUNDING_FLAGGED.includes(a.relation)).length;
    const decision: FindingGroundingDecision = { annotations };
    if (flagged === 0) return { kind: 'act', decision };
    return {
      kind: 'escalate',
      to: 'operator',
      reason: `${flagged} review finding${flagged === 1 ? '' : 's'} not supported by the cited code`,
      partial: decision,
    };
  },
};
