#!/usr/bin/env node
/**
 * Bin shim for `cli-pr-unstick` (AISDLC-139). Forwards to the compiled router.
 * Compiled entry lives in `dist/cli/pr-unstick.js` after `pnpm build`.
 */
import { runPrUnstickCli } from '../dist/cli/pr-unstick.js';

runPrUnstickCli().catch((err) => {
  process.stderr.write(`[cli-pr-unstick] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
