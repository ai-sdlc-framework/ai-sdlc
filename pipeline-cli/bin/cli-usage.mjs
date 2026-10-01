#!/usr/bin/env node
/**
 * Bin shim for `cli-usage`. Forwards to the compiled router in
 * `dist/cli/usage.js`.
 *
 * Invoke via:
 *   node pipeline-cli/bin/cli-usage.mjs ingest [--backfill] [--json]
 */
import { runUsageCli } from '../dist/cli/usage.js';

runUsageCli().catch((err) => {
  process.stderr.write(`[cli-usage] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
