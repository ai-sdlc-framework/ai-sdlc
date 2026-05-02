#!/usr/bin/env node
/**
 * Bin shim for `cli-dor-digest` (AISDLC-115.6 / RFC-0011 Phase 5).
 * Forwards to the compiled router. Compiled entry lives in
 * `dist/cli/dor-digest.js` after `pnpm build`.
 */
import { runDorDigestCli } from '../dist/cli/dor-digest.js';

runDorDigestCli().catch((err) => {
  process.stderr.write(`[cli-dor-digest] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
