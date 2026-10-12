/**
 * Facts `cli-usage context` reads from a framework session's transcript that
 * the ledger does not hold: where the session was last cleared, its name, and
 * the tools a call invoked.
 *
 * Only tool NAMES, timestamps and the session title are read; message text and
 * tool output are never kept. The transcript is untrusted input: lines are
 * pre-filtered by substring, parsed defensively and capped, and a missing or
 * unreadable file yields empty facts rather than an error.
 *
 * The clear marker and title entries are read the same way by
 * `ai-sdlc-plugin/hooks/lib/context-budget.js`.
 */

import { statSync } from 'node:fs';
import { readLines } from './line-reader.js';

/** Hook name Claude Code records for the SessionStart hook that ran after `/clear`. */
export const CLEAR_HOOK_NAME = 'SessionStart:clear';

const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/;
const MAX_TITLE_LEN = 200;

export interface TranscriptFacts {
  /** False when the transcript could not be read; every other field is then empty. */
  readable: boolean;
  /** Epoch ms of every `/clear` recorded in the transcript, in file order. */
  clearTimes: number[];
  /** Latest session title or agent name, when the transcript records one. */
  sessionName?: string;
  /** Tool names invoked by each requested call id; a call that invoked none has no entry. */
  toolsByCallId: Map<string, string[]>;
}

export type TranscriptInspector = (
  file: string,
  wantedCallIds: ReadonlySet<string>,
) => TranscriptFacts;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function title(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_TITLE_LEN ? v : undefined;
}

/** Read the facts of one transcript. Never throws. */
export const inspectTranscript: TranscriptInspector = (file, wantedCallIds) => {
  const facts: TranscriptFacts = { readable: false, clearTimes: [], toolsByCallId: new Map() };
  try {
    const size = statSync(file).size;
    readLines(file, {
      start: 0,
      maxBytes: Math.min(size, MAX_TRANSCRIPT_BYTES),
      onLine: (line) => {
        const isClear = line.includes(CLEAR_HOOK_NAME);
        const isTitle = line.includes('"custom-title"') || line.includes('"agent-name"');
        const isTool = wantedCallIds.size > 0 && line.includes('"tool_use"');
        if (!isClear && !isTitle && !isTool) return true;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          return true;
        }
        if (!isRecord(entry)) return true;
        if (entry['type'] === 'custom-title') {
          facts.sessionName = title(entry['customTitle']) ?? facts.sessionName;
        } else if (entry['type'] === 'agent-name') {
          facts.sessionName = title(entry['agentName']) ?? facts.sessionName;
        } else if (entry['type'] === 'attachment') {
          const att = entry['attachment'];
          if (isRecord(att) && att['hookName'] === CLEAR_HOOK_NAME) {
            const t = Date.parse(String(entry['timestamp']));
            if (!Number.isNaN(t)) facts.clearTimes.push(t);
          }
        } else if (entry['type'] === 'assistant' && isRecord(entry['message'])) {
          const message = entry['message'];
          const id = message['id'];
          if (
            typeof id === 'string' &&
            wantedCallIds.has(id) &&
            Array.isArray(message['content'])
          ) {
            const names = facts.toolsByCallId.get(id) ?? [];
            for (const part of message['content']) {
              if (isRecord(part) && part['type'] === 'tool_use') {
                const name = part['name'];
                if (typeof name === 'string' && TOOL_NAME.test(name) && !names.includes(name)) {
                  names.push(name);
                }
              }
            }
            facts.toolsByCallId.set(id, names);
          }
        }
        return true;
      },
    });
    facts.readable = true;
  } catch {
    // unreadable transcript: report what the ledger alone can say
  }
  return facts;
};
