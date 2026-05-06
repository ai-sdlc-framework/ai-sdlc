#!/usr/bin/env node
/**
 * Bin shim for `cli-task-complete` (AISDLC-203).
 *
 * Atomically moves a backlog task from tasks/ to completed/, patching
 * the frontmatter status to Done and verifying post-move integrity.
 *
 * Usage: node pipeline-cli/bin/cli-task-complete.mjs AISDLC-203
 *
 * Compiled entry lives in `dist/cli/complete-task.js` after `pnpm build`.
 */
import { runCompleteTaskCli } from '../dist/cli/complete-task.js';

runCompleteTaskCli().catch((err) => {
  process.stderr.write(`[cli-task-complete] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
