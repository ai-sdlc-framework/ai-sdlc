#!/usr/bin/env node
/**
 * Bin shim for `cli-hierarchy`.
 *
 * Starts, inspects and stops the planner / dispatch / executor session
 * hierarchy as named tmux windows.
 *
 * Usage:
 *   node pipeline-cli/bin/cli-hierarchy.mjs up --executors 2
 *   node pipeline-cli/bin/cli-hierarchy.mjs status
 *   node pipeline-cli/bin/cli-hierarchy.mjs down --role executor-beta
 *
 * Compiled entry lives in `dist/cli/hierarchy.js` after `pnpm build`.
 */
import { runHierarchyCli } from '../dist/cli/hierarchy.js';

runHierarchyCli().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[cli-hierarchy] error: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  },
);
