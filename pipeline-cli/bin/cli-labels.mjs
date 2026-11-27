#!/usr/bin/env node
/**
 * Bin shim for `cli-labels` (AISDLC-1210, RFC-0062 OQ-3).
 * Forwards to the compiled router in `dist/cli/labels.js`.
 */
// AISDLC-1414: time this command (first import, so it runs before the CLI loads).
import '../dist/cli/command-span.js';
import { runLabelsCli } from '../dist/cli/labels.js';

runLabelsCli().catch((err) => {
  process.stderr.write(`[cli-labels] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
