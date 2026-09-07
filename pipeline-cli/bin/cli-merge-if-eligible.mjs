#!/usr/bin/env node
/**
 * Bin shim for `cli-merge-if-eligible` (RFC-0048 Phase 3 / AISDLC-603).
 * Forwards to the compiled router. Compiled entry lives in
 * `dist/cli/merge-if-eligible.js` after `pnpm build`.
 */
import { runMergeIfEligibleCli } from '../dist/cli/merge-if-eligible.js';

runMergeIfEligibleCli().catch((err) => {
  process.stderr.write(`[cli-merge-if-eligible] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
