#!/usr/bin/env node
/**
 * Bin shim for `cli-context` (RFC-0053 knowledge layer / AISDLC-773).
 * Forwards to the compiled router in `dist/cli/context.js`.
 */
import { runContextCli } from '../dist/cli/context.js';

runContextCli().catch((err) => {
  process.stderr.write(`[cli-context] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
