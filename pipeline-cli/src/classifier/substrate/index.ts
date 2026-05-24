/**
 * Shared classifier substrate — public barrel (AISDLC-321 / RFC-0024
 * Refit Phase 2).
 *
 * Consumers (OQ-2 / OQ-3 / OQ-5 / OQ-11 + RFC-0035 Stage C) import from
 * `@ai-sdlc/pipeline-cli/classifier` and pick up the substrate's public
 * surface. The substrate's internal layout (config / corpus / override /
 * prompts) is exposed for advanced callers (sweepers, the corpus
 * aggregator CLI) that need finer-grained access.
 *
 * @module classifier/substrate
 */

export { classify } from './classify.js';
export {
  recordOperatorOverride,
  resolveSilenceAsPositive,
  resolveOverrideWindowHours,
  DEFAULT_OVERRIDE_WINDOW_HOURS,
  type RecordOperatorOverrideOpts,
  type RecordOperatorOverrideResult,
  type ResolveSilenceAsPositiveOpts,
  type ResolveSilenceAsPositiveResult,
} from './override.js';
export {
  appendCorpusEntry,
  readCorpus,
  resolveCorpusDir,
  resolveCorpusFilePath,
  setCorpusEntryPolarity,
} from './corpus.js';
export {
  loadSubstrateConfig,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_HAIKU_MODEL,
  DEFAULT_DAILY_TOKEN_CAP,
  type SubstrateConfig,
} from './config.js';
export { buildPrompt, isAllowedClassification, ALLOWED_CLASSIFICATIONS } from './task-prompts.js';
export { FakeLlmInvoker, type FakeInvokerFixture } from './fake-invoker.js';
export {
  ALL_TASK_TYPES,
  type CalibrationCorpusEntry,
  type ClassifierDecision,
  type ClassifierInput,
  type ClassifierTaskType,
  type ClassifyOpts,
  type LlmInvocationRequest,
  type LlmInvocationResponse,
  type LlmInvoker,
  type SubscriptionLedgerEntry,
  type SubscriptionLedgerWriter,
} from './types.js';
