#!/usr/bin/env node
/**
 * Bin shim for `cli-staged-review`: drives the staged review set (`reviewerSet: staged`).
 *
 * Subcommands:
 *   prepare | plan | execute | synth-prompt | finalize | status
 *
 * Compiled entry lives in `dist/cli/staged-review.js` after `pnpm build`.
 */
import { runStagedReviewCli } from '../dist/cli/staged-review.js';

runStagedReviewCli().catch((err) => {
  process.stderr.write(`[cli-staged-review] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
