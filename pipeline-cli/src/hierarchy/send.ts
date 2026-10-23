/**
 * Roster guard for peer messages (AISDLC-1036, RFC-0058 phase 3).
 *
 * `cli-hierarchy send --to <name> --text <message>` is the one way a session messages a peer by hand:
 * it refuses a `to` that is not listed in this project's roster (`<board-dir>/hierarchy.json`, the same
 * source `cli-hierarchy status` prints) and says so, so a look-alike name from memory or from another
 * project's session on the same machine never reaches a pane. This is a mistake guard, not authentication.
 */

import { ROSTER_FILENAME } from './roster.js';
import { rosterProject } from './peer-guard.js';
import type { BriefSender } from './brief-notify.js';
import type { RosterEntry } from './types.js';

export type SendCheck = { ok: true; entry: RosterEntry } | { ok: false; reason: string };

/** Find `to` in the roster, or say why it cannot be addressed. */
export function checkSendTarget(sessions: readonly RosterEntry[], to: string): SendCheck {
  const source = `the roster (${ROSTER_FILENAME}, as printed by cli-hierarchy status)`;
  const project = rosterProject(sessions);
  if (!project.ok) return { ok: false, reason: `refusing to send to '${to}': ${project.reason}` };
  const entry = sessions.find((s) => s.name === to);
  if (!entry) {
    const names = sessions.map((s) => s.name).join(', ') || 'none';
    return {
      ok: false,
      reason: `refusing to send to '${to}': it is not listed in ${source} for project '${project.project}' (listed: ${names})`,
    };
  }
  return { ok: true, entry };
}

/** Send one message to a roster session; throws the refusal reason when `to` is not in the roster. */
export function sendToRoster(
  sessions: readonly RosterEntry[],
  to: string,
  text: string,
  send: BriefSender,
): void {
  if (/[\r\n]/.test(text)) {
    throw new Error(
      'refusing to send: the text contains a newline (a pane would run it as separate input)',
    );
  }
  const check = checkSendTarget(sessions, to);
  if (!check.ok) throw new Error(check.reason);
  send(check.entry, text);
}
