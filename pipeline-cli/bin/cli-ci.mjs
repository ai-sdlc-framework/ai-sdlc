#!/usr/bin/env node
/**
 * Bin shim for `cli-ci` (AISDLC-799). Forwards to the compiled router.
 * Compiled entry lives in `dist/cli/ci.js` after `pnpm build`.
 */
import { runCiCli } from '../dist/cli/ci.js';

runCiCli().catch((err) => {
  process.stderr.write(`[cli-ci] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
