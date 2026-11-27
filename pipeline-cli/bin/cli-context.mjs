#!/usr/bin/env node
/**
 * Bin shim for `cli-context` (RFC-0053 knowledge layer / AISDLC-773).
 * Forwards to the compiled router in `dist/cli/context.js`.
 */
// AISDLC-1414: time this command (first import, so it runs before the CLI loads).
import '../dist/cli/command-span.js';
import { runContextCli } from '../dist/cli/context.js';

runContextCli().catch((err) => {
  process.stderr.write(`[cli-context] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
