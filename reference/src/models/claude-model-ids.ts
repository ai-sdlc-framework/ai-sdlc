/**
 * The ONE place a versioned Claude model id may appear in non-test source
 * (besides price tables). Direct-API paths (anything that sends a model id to
 * a provider HTTP API or SDK, where a bare family alias may not be accepted)
 * take their default from here. Harness paths (anything that reaches Claude
 * Code) use the family alias (`sonnet`, `opus`, `haiku`) and never this module.
 *
 * Each id is the current release of its family and has a row in the price
 * seed (`usage/prices-seed.ts`). Pinning stays possible: every consumer keeps
 * its environment-variable or config override.
 *
 * To follow a new release, change the id here; to pin away from a bad
 * release, set the consumer's environment variable.
 *
 * @module models/claude-model-ids
 */

/** Current Sonnet release (direct-API default). */
export const CLAUDE_SONNET_MODEL_ID = 'claude-sonnet-5-5';

/** Current Opus release (direct-API default). */
export const CLAUDE_OPUS_MODEL_ID = 'claude-opus-5-5';

/** Opus with the 1M-token context window. */
export const CLAUDE_OPUS_1M_MODEL_ID = `${CLAUDE_OPUS_MODEL_ID}[1m]`;

/** Current Haiku release (direct-API default). */
export const CLAUDE_HAIKU_MODEL_ID = 'claude-haiku-4-5';

/** Family aliases the harness resolves to the current release. */
export const CLAUDE_FAMILY_ALIASES = ['haiku', 'sonnet', 'opus'] as const;
