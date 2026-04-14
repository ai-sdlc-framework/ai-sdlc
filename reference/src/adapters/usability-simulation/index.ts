/**
 * Usability Simulation Runner — project-owned reference implementation.
 * (RFC-0006 Addendum A §A.5)
 *
 * Deploys Storybook stories to headless browser environments and runs
 * LLM-driven task-based usability testing.
 */

export {
  selectTasks,
  parseTaskLibrary,
  type TaskLibrary,
  type TaskSelectionResult,
} from './task-selector.js';

export {
  filterByConfidence,
  runMetaReview,
  createHeuristicMetaReviewer,
  CONFIDENCE_THRESHOLD,
  META_REVIEW_UPPER,
  type MetaReviewEvaluator,
} from './meta-review.js';
