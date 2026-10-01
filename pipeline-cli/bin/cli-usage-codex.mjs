#!/usr/bin/env node
/**
 * Bin shim for `cli-usage-codex`. Forwards to the compiled router in
 * `dist/cli/usage-codex.js`.
 */
import { runUsageCodexCli } from '../dist/cli/usage-codex.js';

runUsageCodexCli().catch((err) => {
  process.stderr.write(`[cli-usage-codex] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
