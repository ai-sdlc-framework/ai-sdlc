/**
 * Handoff proof (AISDLC-1448): a planner or executor session is never cleared or restarted
 * until its handoff is written.
 *
 * There is one proof predicate, {@link handoffWrittenSince}. The hooks module (through
 * `cli-hierarchy handoff verify`) and the dispatch restart path both call it; neither keeps its
 * own notion of "written". It is true only when the session's handoff file holds exactly one
 * `## RESUME HERE` block, that block's hash differs from the one recorded when the rotation was
 * requested (the rotate-request marker), and the file was modified after the request.
 *
 * When the proof never arrives the system alerts instead of clearing: one line in
 * `<board-dir>/rotation.log`, one `session-rotation:<name>` escalation in the decision catalog
 * and a desktop notification.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { now as clockNow } from '../clock.js';

import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  withEventLogLock,
} from '../decisions/event-log.js';
import { listDecisions } from '../decisions/projection.js';
import { nextDecisionIdDurable, persistDecisionLog } from '../decisions/remote-persist.js';
import { HANDOFF_BEGIN, HANDOFF_END, handoffPath, newestPlannerHandoff } from './handoff.js';
import { readRotateRequest, writeRotateRequest } from './rotate-request.js';
import type { HierarchyRole } from './types.js';

const RESUME_HEADING_RE = /^## RESUME HERE\b/;

/** Every `## RESUME HERE` section outside the generated block, each up to the next `## ` heading. */
export function resumeBlocks(content: string): string[] {
  const start = content.indexOf(HANDOFF_BEGIN);
  const end = content.indexOf(HANDOFF_END);
  const outside =
    start !== -1 && end !== -1 && end >= start
      ? content.slice(0, start) + '\n' + content.slice(end + HANDOFF_END.length)
      : content;
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of outside.split('\n')) {
    if (/^## /.test(line)) {
      if (current) blocks.push(current.join('\n').trim());
      current = RESUME_HEADING_RE.test(line) ? [line] : undefined;
    } else if (current) current.push(line);
  }
  if (current) blocks.push(current.join('\n').trim());
  return blocks;
}

const hashBlock = (block: string): string => createHash('sha256').update(block).digest('hex');

/** Hash of the file's sole RESUME block; null when it holds none or more than one. */
export function resumeHash(content: string): string | null {
  const blocks = resumeBlocks(content);
  if (blocks.length !== 1) return null;
  return hashBlock(blocks[0] as string);
}

/** Hash of the file's last RESUME block (the one `rollArchive` keeps); null when it holds none. */
export function lastResumeHash(content: string): string | null {
  const blocks = resumeBlocks(content);
  const last = blocks[blocks.length - 1];
  return last === undefined ? null : hashBlock(last);
}

/** Where a session's handoff lives and how to read the clock. */
export interface ProofOptions {
  boardDir: string;
  now?: () => Date;
  /** Overrides the handoff file location (tests). */
  file?: string;
}

function fileOf(role: HierarchyRole, name: string, opts: ProofOptions): string {
  return handoffPath(
    { role, name, boardDir: opts.boardDir, ...(opts.file ? { file: opts.file } : {}) },
    (opts.now ?? clockNow)(),
  );
}

function readOrEmpty(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, 'utf-8') : '';
  } catch {
    return '';
  }
}

/**
 * The RESUME baseline a rotation request records: the block `writeHandoff` would carry into the
 * file without any model edit. That is the last block of the session's handoff file (on the next
 * write `rollArchive` keeps only the last one) or, when today's dated planner file does not exist
 * yet, the last block of the newest earlier planner handoff it inherits from. A baseline of null
 * therefore means no RESUME block exists anywhere a write could carry from, so any block found
 * later was written by the session.
 */
export function rotationBaseline(
  role: HierarchyRole,
  name: string,
  opts: ProofOptions,
): string | null {
  const file = fileOf(role, name, opts);
  const carried = existsSync(file)
    ? file
    : newestPlannerHandoff(file, {
        role,
        name,
        boardDir: opts.boardDir,
        ...(opts.file ? { file: opts.file } : {}),
      });
  return carried ? lastResumeHash(readOrEmpty(carried)) : null;
}

/**
 * Record a rotation request with its RESUME-block baseline and return its time. An existing
 * request whose baseline still matches the file is kept (dispatch and the module share one
 * request); a request already satisfied, or one without a baseline, is replaced.
 */
export function markRotation(
  role: HierarchyRole,
  name: string,
  opts: ProofOptions,
): { since: string; resumeHash: string | null; file: string } {
  const file = fileOf(role, name, opts);
  const current = rotationBaseline(role, name, opts);
  const existing = readRotateRequest(opts.boardDir, name);
  if (existing && existing.resumeHash !== undefined && existing.resumeHash === current) {
    return { since: existing.at, resumeHash: current, file };
  }
  const now = (opts.now ?? clockNow)();
  writeRotateRequest(opts.boardDir, name, now, current);
  return { since: now.toISOString(), resumeHash: current, file };
}

/** The proof and, when it fails, why. */
export interface ProofResult {
  proven: boolean;
  reason: string;
  file: string;
}

/** {@link handoffWrittenSince} with the reason a proof failed. */
export function checkHandoffProof(
  role: HierarchyRole,
  name: string,
  sinceIso: string,
  opts: ProofOptions,
): ProofResult {
  const file = fileOf(role, name, opts);
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(since))
    return { proven: false, reason: `invalid since '${sinceIso}'`, file };
  const request = readRotateRequest(opts.boardDir, name);
  if (!request || request.resumeHash === undefined) {
    return {
      proven: false,
      reason: 'no rotation request with a RESUME baseline is recorded',
      file,
    };
  }
  if (!existsSync(file)) return { proven: false, reason: 'the handoff file does not exist', file };
  const content = readOrEmpty(file);
  const count = resumeBlocks(content).length;
  if (count !== 1) {
    return {
      proven: false,
      reason: `the handoff holds ${count} RESUME HERE blocks, not one`,
      file,
    };
  }
  if (resumeHash(content) === request.resumeHash) {
    return { proven: false, reason: 'the RESUME HERE block is unchanged since the request', file };
  }
  if (statSync(file).mtimeMs <= since) {
    return { proven: false, reason: `the handoff was not modified after ${sinceIso}`, file };
  }
  return { proven: true, reason: 'a new RESUME HERE block was written after the request', file };
}

/**
 * True only when the session's handoff holds exactly one RESUME block whose hash differs from
 * the baseline recorded with the rotation request, and the file was modified after `sinceIso`.
 */
export function handoffWrittenSince(
  role: HierarchyRole,
  name: string,
  sinceIso: string,
  opts: ProofOptions,
): boolean {
  return checkHandoffProof(role, name, sinceIso, opts).proven;
}

/** `<board-dir>/rotation.log`: every unproven rotation, escalation and forced restart, one line each. */
export function rotationLogPath(boardDir: string): string {
  return path.join(boardDir, 'rotation.log');
}

/** Append one line to the rotation log. Never throws. */
export function appendRotationLog(boardDir: string, now: Date, line: string): void {
  try {
    mkdirSync(boardDir, { recursive: true });
    appendFileSync(rotationLogPath(boardDir), `${now.toISOString()} ${line}\n`);
  } catch {
    /* the log is a record, never a gate */
  }
}

/** Decision scope of a rotation that never got its proof. */
export const rotationScope = (name: string): string => `session-rotation:${name}`;

/**
 * File one `session-rotation:<name>` escalation in the decision catalog (the
 * `cli-decisions escalate --route operational` record), reusing an open one. Returns its id.
 */
export function escalateUnprovenRotation(
  workDir: string,
  name: string,
  reason: string,
  now: Date,
): string {
  const scope = rotationScope(name);
  const id = withEventLogLock({ workDir }, () => {
    const open = listDecisions({ workDir }).decisions.find(
      (d) =>
        d.metadata.scope === scope &&
        !['answered', 'superseded', 'archived'].includes(d.status.lifecycle),
    );
    if (open) return open.metadata.id;
    const decisionId = nextDecisionIdDurable({ workDir });
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId,
        source: 'ad-hoc',
        scope,
        summary: `${name} is over its context threshold but its handoff is unproven; it was not restarted`,
        body:
          `The rotation grace lapsed without a new RESUME HERE block (${reason}). ` +
          'Ask the session to write its handoff, or restart it with cli-hierarchy restart --force, which loses its unrecorded state.',
        reversible: true,
        options: [
          {
            id: 'write-handoff',
            description: 'Have the session write its RESUME HERE block, then let it rotate',
          },
          { id: 'force-restart', description: `Run cli-hierarchy restart ${name} --force` },
        ],
        escalation: { route: 'operational', taskId: scope, parked: false },
        by: 'operator-dispatch',
        now,
      }),
      { workDir },
    );
    return decisionId;
  });
  persistDecisionLog({ workDir });
  return id;
}
