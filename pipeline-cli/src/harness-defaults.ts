/**
 * Single home for the default harness label and CLI binary name (AISDLC-540).
 *
 * Core orchestration code must not hardwire a vendor string; it imports these
 * constants instead, so the vendor default lives behind one seam. The
 * substrate-contract gate (`scripts/check-substrate-contract.mjs`) fails when a
 * core file re-introduces a literal `harness: 'claude-code'` default.
 */

/** Harness label recorded on verdicts/attestations when none is configured. */
export const DEFAULT_HARNESS = 'claude-code' as const;

/** Default executable name for the default harness CLI. */
export const DEFAULT_HARNESS_BINARY = 'claude' as const;
