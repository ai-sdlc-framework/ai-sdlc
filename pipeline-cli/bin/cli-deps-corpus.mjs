#!/usr/bin/env node
/**
 * Bin shim for `cli-deps-corpus` (AISDLC-167.5 / RFC-0014 §11 Phase 5).
 * Forwards to the compiled router. Compiled entry lives in
 * `dist/cli/deps-corpus.js` after `pnpm build`.
 *
 * The CLI aggregates downloaded dependency-graph snapshot artifacts +
 * the operator override log into a dispatch-quality recommendation
 * envelope. See `pipeline-cli/src/cli/deps-corpus.ts` for the full
 * contract and `docs/operations/deps-composition-promotion.md` for how
 * the recommendation drives the AI_SDLC_DEPS_COMPOSITION default-on
 * promotion decision.
 */
import { runDepsCorpusCli } from '../dist/cli/deps-corpus.js';

runDepsCorpusCli().catch((err) => {
  process.stderr.write(`[cli-deps-corpus] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
