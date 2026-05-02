#!/usr/bin/env node
/**
 * Bin shim for `cli-dor-stats` (AISDLC-115.6 / RFC-0011 Phase 5).
 * Forwards to the compiled router. Compiled entry lives in
 * `dist/cli/dor-stats.js` after `pnpm build`.
 */
import { runDorStatsCli } from '../dist/cli/dor-stats.js';

runDorStatsCli().catch((err) => {
  process.stderr.write(`[cli-dor-stats] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
