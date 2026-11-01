/**
 * RFC-0053 surfacing hook (AISDLC-779). Usage: node context-surface.js <moment>
 * Always exits 0; emits hook JSON only when the slice is non-empty.
 */
const { readStdinSync } = require('./lib/read-stdin.js');
const { surface, MOMENTS } = require('./lib/context-surface.js');

try {
  const moment = process.argv[2];
  if (MOMENTS.includes(moment)) {
    let input = {};
    try {
      input = JSON.parse(readStdinSync()) || {};
    } catch {
      // keep {}
    }
    const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const out = surface(moment, input, process.env, projectDir);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  }
} catch {
  // never block the tool call or prompt
}
process.exit(0);
