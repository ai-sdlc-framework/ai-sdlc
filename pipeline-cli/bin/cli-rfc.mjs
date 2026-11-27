#!/usr/bin/env node
/**
 * Bin shim for `cli-rfc` (RFC-0036 Phase 9 / AISDLC-334).
 * Forwards to the compiled router in `dist/cli/rfc.js`.
 */
// AISDLC-1414: time this command (first import, so it runs before the CLI loads).
import '../dist/cli/command-span.js';
import { runRfcCli } from '../dist/cli/rfc.js';

runRfcCli().catch((err) => {
  process.stderr.write(`[cli-rfc] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
