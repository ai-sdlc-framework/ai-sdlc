#!/usr/bin/env node
/**
 * Bin shim for `cli-labels` (AISDLC-1210, RFC-0062 OQ-3).
 * Forwards to the compiled router in `dist/cli/labels.js`.
 */
import { runLabelsCli } from '../dist/cli/labels.js';

runLabelsCli().catch((err) => {
  process.stderr.write(`[cli-labels] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
