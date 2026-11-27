#!/usr/bin/env node
/**
 * Bin shim for `cli-pr-unstick` (AISDLC-139). Forwards to the compiled router.
 * Compiled entry lives in `dist/cli/pr-unstick.js` after `pnpm build`.
 */
// AISDLC-1414: time this command (first import, so it runs before the CLI loads).
import '../dist/cli/command-span.js';
import { runPrUnstickCli } from '../dist/cli/pr-unstick.js';

runPrUnstickCli().catch((err) => {
  process.stderr.write(`[cli-pr-unstick] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
