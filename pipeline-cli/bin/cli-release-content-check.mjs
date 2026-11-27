#!/usr/bin/env node
/**
 * Bin shim for `cli-release-content-check` (AISDLC-717). Compiled entry lives in
 * `dist/cli/release-content-check.js` after `pnpm build`.
 */
// AISDLC-1414: time this command (first import, so it runs before the CLI loads).
import '../dist/cli/command-span.js';
import { runReleaseContentCheckCli } from '../dist/cli/release-content-check.js';

runReleaseContentCheckCli()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[cli-release-content-check] error: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
