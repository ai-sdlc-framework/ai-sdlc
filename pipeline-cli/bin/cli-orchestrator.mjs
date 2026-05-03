#!/usr/bin/env node
/**
 * Bin shim for `cli-orchestrator` (RFC-0015 Phase 1 / AISDLC-169.1).
 * Forwards to the compiled router. Compiled entry lives in
 * `dist/cli/orchestrator.js` after `pnpm build`.
 *
 * Invoke directly via `node pipeline-cli/bin/cli-orchestrator.mjs <subcommand>`
 * — never via `pnpm exec` (AISDLC-156 — `pnpm exec` does not resolve a
 * workspace package's own bin entries).
 */
import { runOrchestratorCli } from '../dist/cli/orchestrator.js';

runOrchestratorCli().catch((err) => {
  process.stderr.write(`[cli-orchestrator] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
