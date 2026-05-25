#!/usr/bin/env node
/**
 * Bin shim for `cli-rfc` (RFC-0036 Phase 9 / AISDLC-334).
 * Forwards to the compiled router in `dist/cli/rfc.js`.
 */
import { runRfcCli } from '../dist/cli/rfc.js';

runRfcCli().catch((err) => {
  process.stderr.write(`[cli-rfc] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
