#!/usr/bin/env node
/**
 * Bin shim for `cli-estimate-classes` (AISDLC-284, RFC-0016 Phase 6).
 * Forwards to the compiled CLI router in `dist/cli/estimate-classes.js`.
 */
import { runEstimateClassesCli } from '../dist/cli/estimate-classes.js';

runEstimateClassesCli().catch((err) => {
  process.stderr.write(`[cli-estimate-classes] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
