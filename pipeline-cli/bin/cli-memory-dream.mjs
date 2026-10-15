#!/usr/bin/env node
/**
 * Bin shim for `cli-memory-dream` (AISDLC-729): consolidate, prune and refine
 * an agent memory folder. Subcommands: run, apply, undo.
 *
 *   node pipeline-cli/bin/cli-memory-dream.mjs run --dry-run
 *
 * See docs/operations/memory-dream.md.
 */
import { runMemoryDreamCli } from '../dist/cli/memory-dream.js';

runMemoryDreamCli().catch((err) => {
  process.stderr.write(`[cli-memory-dream] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
