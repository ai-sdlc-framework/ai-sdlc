#!/usr/bin/env node
/**
 * Bin shim for `cli-import-spec` (RFC-0036 Phase 4 / AISDLC-329).
 * Forwards to the compiled router in `dist/cli/import-spec.js`.
 */
// AISDLC-1414: time this command (first import, so it runs before the CLI loads).
import '../dist/cli/command-span.js';
import { runImportSpecCli } from '../dist/cli/import-spec.js';

runImportSpecCli().catch((err) => {
  process.stderr.write(`[cli-import-spec] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
