/**
 * AI-SDLC parent-on-main hook (AISDLC-764).
 *
 * One entry point for two events, chosen by `hook_event_name`:
 *  - SessionStart: report (and, when the parent is clean, undo) a parent
 *    checkout left on a branch other than main.
 *  - PreToolUse: deny Edit/Write/MultiEdit into the parent working tree and
 *    branch creation with the parent as the working directory.
 * Decision logic lives in lib/parent-on-main.js. A tool call is allowed when
 * the input cannot be read (this hook must not wedge a session on bad input);
 * every call it can classify as a parent write is denied.
 */

const { readStdinSync } = require('./lib/read-stdin');
const { evaluatePreToolUse, checkParentOnMain } = require('./lib/parent-on-main');

let input;
try {
  input = JSON.parse(readStdinSync());
} catch {
  process.exit(0);
}

const event = input && input.hook_event_name;
if (event === 'SessionStart') {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const r = checkParentOnMain(cwd);
  if (r.message) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: r.message },
      }) + '\n',
    );
  }
  process.exit(0);
}

const reason = evaluatePreToolUse(input);
if (reason) {
  process.stdout.write(
    JSON.stringify(
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Blocked by AI-SDLC governance policy: ${reason}`,
        },
      },
      null,
      2,
    ) + '\n',
  );
}
process.exit(0);
