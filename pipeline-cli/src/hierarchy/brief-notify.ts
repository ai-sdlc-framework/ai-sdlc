/**
 * Hand-off: tell the dispatch session a brief is ready.
 *
 * The message goes to the dispatch session's roster entry only, and only after
 * the entry passes the same validation `down` applies: the hierarchy tmux
 * session, a valid window name, a valid pane id that tmux confirms still belongs
 * to that window. Nothing is ever typed into any other tmux target.
 */

import path from 'node:path';

import { unsafeEntryReason } from './roster.js';
import { listWindows, resolveSendTarget } from './tmux.js';
import type { CommandRunner, RosterEntry } from './types.js';

/** Delivers one line to a roster session. Injected in tests. */
export type BriefSender = (entry: RosterEntry, message: string) => void;

/** The one-line message that names the brief. */
export function briefMessage(briefFile: string, cwd: string): string {
  const rel = path.relative(cwd, briefFile);
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : briefFile;
  // One line, no control characters: the text is typed into a terminal.
  const clean = [...shown]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? ' ' : ch;
    })
    .join('');
  return `A dispatch brief is ready: ${clean}. Read it and ingest it.`;
}

/**
 * Sender that types the message into the entry's tmux pane with `send-keys`.
 * @throws when the entry is not safe to target or its window is not open.
 */
export function createTmuxBriefSender(run: CommandRunner): BriefSender {
  return (entry, message) => {
    const reason = unsafeEntryReason(entry);
    if (reason) throw new Error(`refusing to message '${entry.name}': it ${reason}`);
    if (!listWindows(run, entry.tmuxSession).includes(entry.tmuxWindow)) {
      throw new Error(`the window for '${entry.name}' is not open; start it with cli-hierarchy up`);
    }
    const target = resolveSendTarget(run, entry.tmuxSession, entry.tmuxWindow, entry.paneId);
    const typed = run('tmux', ['send-keys', '-t', target, '-l', '--', message]);
    if (typed.status !== 0) throw new Error(`could not type into '${entry.name}': ${typed.stderr}`);
    const sent = run('tmux', ['send-keys', '-t', target, 'Enter']);
    if (sent.status !== 0) throw new Error(`could not submit to '${entry.name}': ${sent.stderr}`);
  };
}

/**
 * Send exactly one message to the dispatch session.
 * @throws when the roster has no dispatch session.
 */
export function notifyDispatch(
  dispatch: RosterEntry | undefined,
  briefFile: string,
  cwd: string,
  send: BriefSender,
): string {
  if (!dispatch) {
    throw new Error('no dispatch session in the roster; start one with cli-hierarchy up');
  }
  const message = briefMessage(briefFile, cwd);
  send(dispatch, message);
  return message;
}
