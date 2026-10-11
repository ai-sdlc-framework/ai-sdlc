#!/usr/bin/env node
/**
 * Status line command (AISDLC-728): prints the session's context percentage,
 * coloured at the warn and crit thresholds, and records it for the Stop hook
 * `hooks/context-warn.js`. Configure in settings:
 *
 *   { "statusLine": { "type": "command",
 *     "command": "node \"<plugin>/scripts/context-statusline.mjs\"" } }
 *
 * Thresholds: AI_SDLC_CONTEXT_WARN_PCT (default 30), AI_SDLC_CONTEXT_CRIT_PCT (default 40).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  percentageOf,
  recordPercentage,
  renderStatusLine,
} = require('../hooks/lib/context-warn.js');

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf-8') || '{}');
} catch {
  payload = {};
}
const pct = percentageOf(payload);
recordPercentage(payload.session_id, pct);
process.stdout.write(renderStatusLine(pct) + '\n');
