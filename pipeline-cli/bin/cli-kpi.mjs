#!/usr/bin/env node
/**
 * Bin shim for `cli-kpi` (AISDLC-877). Compiled entry: `dist/cli/kpi.js`.
 */
// AISDLC-1414: time this command (first import, so it runs before the CLI loads).
import '../dist/cli/command-span.js';
import { runKpiCli } from '../dist/cli/kpi.js';

runKpiCli().catch((err) => {
  process.stderr.write(`[cli-kpi] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
