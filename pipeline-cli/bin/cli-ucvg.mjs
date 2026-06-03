#!/usr/bin/env node
/**
 * Bin shim for `cli-ucvg` — RFC-0043 Phase 5 UCVG CLI.
 *
 * Subcommands: classify, ast-gate, sandbox-run, review-degraded, clean-room-sign, local-review
 * See pipeline-cli/src/cli/ucvg.ts for the full implementation.
 */
import { runUcvgCli } from '../dist/cli/ucvg.js';

runUcvgCli().catch((err) => {
  process.stderr.write(`[cli-ucvg] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
