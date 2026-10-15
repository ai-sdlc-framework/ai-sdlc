#!/usr/bin/env node
/**
 * Bin shim for `cli-kpi` (AISDLC-877). Compiled entry: `dist/cli/kpi.js`.
 */
import { runKpiCli } from '../dist/cli/kpi.js';

runKpiCli().catch((err) => {
  process.stderr.write(`[cli-kpi] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
