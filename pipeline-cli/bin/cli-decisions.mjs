#!/usr/bin/env node
/**
 * Bin shim for `cli-decisions` (RFC-0035 / AISDLC-285). Forwards to the
 * compiled router in `dist/cli/decisions.js`.
 */
import { runDecisionsCli } from '../dist/cli/decisions.js';

runDecisionsCli().catch((err) => {
  process.stderr.write(`[cli-decisions] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
