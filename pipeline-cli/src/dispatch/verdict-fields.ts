/**
 * Strict shapes for the verdict fields that reach a language model, the planner
 * or a command line.
 *
 * A verdict is a file on the board, so every string in it is untrusted. The
 * decision ids and the cause code are the two fields the dispatch session acts
 * on, so each has a short anchored pattern; anything that does not match is
 * rejected when a verdict is written and dropped when one is read.
 */

import type { DispatchVerdict } from './types.js';

/** Decision Catalog id, for example `DEC-0042`. */
export const DECISION_ID_RE = /^DEC-[0-9]{4,9}$/;
/** Cause code: lower-case words joined by hyphens, for example `prettier-drift`. */
export const CAUSE_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** Most decision ids one verdict may carry. */
export const MAX_DECISION_IDS = 20;

/** True for a well-formed Decision Catalog id. */
export function isValidDecisionId(id: unknown): id is string {
  return typeof id === 'string' && DECISION_ID_RE.test(id);
}

/** True for a well-formed cause code. */
export function isValidCause(cause: unknown): cause is string {
  return typeof cause === 'string' && CAUSE_RE.test(cause);
}

/**
 * Collapse text to one printable ASCII line of at most `max` characters.
 * Control characters, newlines and non-ASCII characters become a single space.
 */
export function oneLine(text: string | undefined, max: number): string {
  return (text ?? '')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** A verdict whose decision ids, cause, outcome and worker are safe to forward, and what was dropped. */
export interface SanitizedVerdict {
  verdict: DispatchVerdict;
  /** Names of the fields that were dropped or replaced. */
  dropped: string[];
}

const OUTCOME_RE = /^[a-z][a-z-]{0,29}$/;
const WORKER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Copy a verdict read from the board with every field the loop forwards checked.
 * An invalid cause is removed, invalid decision ids are removed, and an outcome
 * or worker name that is not a plain token is replaced by `unknown`.
 */
export function sanitizeVerdict(verdict: DispatchVerdict): SanitizedVerdict {
  const dropped: string[] = [];
  const copy: DispatchVerdict = { ...verdict };
  if (copy.cause !== undefined && !isValidCause(copy.cause)) {
    delete copy.cause;
    dropped.push('cause');
  }
  if (copy.decisionIds !== undefined) {
    const list: unknown[] = Array.isArray(copy.decisionIds) ? copy.decisionIds : [];
    const valid = list.filter(isValidDecisionId).slice(0, MAX_DECISION_IDS);
    if (valid.length !== list.length) dropped.push('decisionIds');
    if (valid.length > 0) copy.decisionIds = valid;
    else delete copy.decisionIds;
  }
  if (typeof copy.outcome !== 'string' || !OUTCOME_RE.test(copy.outcome)) {
    copy.outcome = 'unknown' as DispatchVerdict['outcome'];
    dropped.push('outcome');
  }
  if (typeof copy.workerId !== 'string' || !WORKER_RE.test(copy.workerId)) {
    copy.workerId = 'unknown';
    dropped.push('workerId');
  }
  return { verdict: copy, dropped };
}
