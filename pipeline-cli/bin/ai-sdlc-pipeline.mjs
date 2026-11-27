#!/usr/bin/env node
/**
 * Bin shim for `ai-sdlc-pipeline`. Forwards to the compiled CLI router.
 * This is a tiny wrapper kept in `.mjs` form so it works without a build step
 * for the shebang itself; everything below is in `dist/cli/index.js`.
 */
// AISDLC-1414: time this command (first import, so it runs before the CLI loads).
import '../dist/cli/command-span.js';
import { runCli } from '../dist/cli/index.js';

runCli().catch((err) => {
  process.stderr.write(`[ai-sdlc-pipeline] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
