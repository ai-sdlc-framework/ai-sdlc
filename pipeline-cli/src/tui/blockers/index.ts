/**
 * Public surface for the Blockers pane logic — RFC-0023 §8 / AISDLC-178.3.
 *
 * Exports the pure detector (`detectBlockers`) + the React hook
 * (`useBlockers`) that consumer panes import.
 */

export {
  detectBlockers,
  detectChangesRequested,
  detectDorComment,
  detectExternalDep,
  detectNeedsClarification,
  detectOpenPrQuestion,
  detectTriageTbd,
  MARKER_DOR_COMMENT,
  MARKER_NOT_A_DECISION,
  MARKER_URGENT_DECISION,
  readTaskBody,
  sortBlockers,
  STALE_THRESHOLD_MS,
  type BlockerItem,
  type BlockerKind,
  type DetectBlockersOpts,
} from './detector.js';

export { useBlockers, type UseBlockersOpts, type UseBlockersState } from './use-blockers.js';
