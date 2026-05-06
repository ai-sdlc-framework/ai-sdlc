#!/usr/bin/env node
/**
 * Bin shim for `cli-backlog-verify` (AISDLC-203).
 *
 * Scans backlog/tasks/ and backlog/completed/ for duplicate task IDs.
 * Exits non-zero when any task ID appears in both directories.
 *
 * Usage: node pipeline-cli/bin/cli-backlog-verify.mjs
 *        node pipeline-cli/bin/cli-backlog-verify.mjs --work-dir /abs/repo
 *
 * Compiled entry lives in `dist/cli/backlog-verify.js` after `pnpm build`.
 */
import { runBacklogVerifyCli } from '../dist/cli/backlog-verify.js';

runBacklogVerifyCli().catch((err) => {
  process.stderr.write(`[cli-backlog-verify] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
