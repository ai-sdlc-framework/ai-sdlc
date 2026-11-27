#!/usr/bin/env node
/**
 * Bin shim for `cli-pr` (AISDLC-881). Compiled entry: `dist/cli/pr.js`.
 */
// AISDLC-1414: time this command (first import, so it runs before the CLI loads).
import '../dist/cli/command-span.js';
import { runPrCli } from '../dist/cli/pr.js';

runPrCli().catch((err) => {
  process.stderr.write(`[cli-pr] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
