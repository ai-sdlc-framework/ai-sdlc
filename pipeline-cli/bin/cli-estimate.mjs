#!/usr/bin/env node
/**
 * Bin shim for `cli-estimate` (AISDLC-279, RFC-0016 Phase 1).
 * Forwards to the compiled estimate CLI router in `dist/cli/estimate.js`.
 */
import { runEstimateCli } from '../dist/cli/estimate.js';

runEstimateCli().catch((err) => {
  process.stderr.write(`[cli-estimate] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
