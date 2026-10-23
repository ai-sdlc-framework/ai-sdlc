#!/usr/bin/env node
/**
 * Bin shim for `cli-workflow` (RFC-0056 phase 1). Forwards to `dist/cli/workflow.js`.
 */
import { runWorkflowCli } from '../dist/cli/workflow.js';

runWorkflowCli().catch((err) => {
  process.stderr.write(`[cli-workflow] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
