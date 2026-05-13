#!/usr/bin/env node
/**
 * Bin shim for `cli-capture` (RFC-0024 / AISDLC-269). Forwards to the
 * compiled capture CLI router. The router lives in `dist/cli/capture.js`
 * after `pnpm build`.
 */
import { runCaptureCli } from '../dist/cli/capture.js';

runCaptureCli().catch((err) => {
  process.stderr.write(`[cli-capture] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
