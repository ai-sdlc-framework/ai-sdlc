#!/usr/bin/env node
/**
 * Bin shim for `cli-classifier` (AISDLC-321 / RFC-0024 Refit Phase 2).
 * Forwards to the compiled corpus aggregator + sweeper. The router lives
 * in `dist/cli/classifier.js` after `pnpm build`.
 *
 * Sister CLIs:
 *   - `cli-classify-pr`     — conditional-review classifier (per-PR, picks
 *                              which reviewers to fan out).
 *   - `cli-classify-budget` — budget-exhaustion aggregate decision for
 *                              the CI report job.
 *   - `cli-classifier`      — shared classifier substrate corpus tooling
 *                              (THIS file). Different concern from the
 *                              two above; the substrate is the framework-
 *                              level shared service for OQ-2 / OQ-3 / OQ-5 /
 *                              OQ-11 / RFC-0035 Stage C.
 */
import { runClassifierCli } from '../dist/cli/classifier.js';

runClassifierCli().catch((err) => {
  process.stderr.write(`[cli-classifier] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
