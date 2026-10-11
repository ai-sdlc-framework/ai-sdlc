/**
 * AI-SDLC Context Warning Hook (Stop) - AISDLC-728
 *
 * After each turn, prints a one-time `systemMessage` when the session's context
 * percentage (recorded by the status line command) has reached the upper
 * threshold. Works for every role. Never blocks, never fails a session.
 */

'use strict';

const { readFileSync } = require('node:fs');
const { evaluateWarning } = require('./lib/context-warn');

/** Hook output for one Stop payload, or null when there is nothing to say. */
function runContextWarn(payload, env = process.env) {
  try {
    if (env.AI_SDLC_CONTEXT_WARN === 'off') return null;
    const message = evaluateWarning(payload && payload.session_id, env);
    return message ? { systemMessage: message } : null;
  } catch {
    return null;
  }
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf-8') || '{}');
  } catch {
    return {};
  }
}

if (require.main === module) {
  try {
    const out = runContextWarn(readStdin());
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  } catch {
    // never fail the session
  }
  process.exit(0);
}

module.exports = { runContextWarn };
