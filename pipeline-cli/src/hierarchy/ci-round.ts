/**
 * The note for an automatic CI round (AISDLC-1231): the failed step, the tail of its log and
 * the head sha, so the executor starts the round knowing what broke. The log is capped by
 * line count and bytes and stripped of ANSI; a log that cannot be fetched is said so in the
 * note and the round is still ordered.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MAX_NOTE_CHARS } from '../dispatch/resume.js';
import { resolveGateRunId } from './gate-run.js';
import type { CommandRunner } from './types.js';

export const CI_LOG_TAIL_LINES = 60;
export const CI_LOG_TAIL_BYTES = 2500;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Last lines of a log, ANSI-stripped, capped by line count and by bytes (keeping the end). */
export function tailLog(raw: string, maxLines = CI_LOG_TAIL_LINES, maxBytes = CI_LOG_TAIL_BYTES) {
  const lines = raw
    .replace(ANSI_RE, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '');
  let text = lines.slice(-maxLines).join('\n');
  if (Buffer.byteLength(text) > maxBytes) {
    text = Buffer.from(text).subarray(-maxBytes).toString('utf-8').replace(/^�+/, '');
  }
  return text;
}

interface RunJob {
  name?: string;
  conclusion?: string;
  steps?: { name?: string; conclusion?: string }[];
}

/** `job / step` of every failed step in a `gh run view --json jobs` payload. */
function failedSteps(stdout: string): string[] {
  try {
    const jobs = (JSON.parse(stdout) as { jobs?: RunJob[] }).jobs ?? [];
    return jobs.flatMap((j) => {
      if (j.conclusion !== 'failure') return [];
      const steps = (j.steps ?? []).filter((s) => s.conclusion === 'failure');
      return steps.length > 0
        ? steps.map((s) => `${j.name ?? 'job'} / ${s.name ?? 'step'}`)
        : [j.name ?? 'job'];
    });
  } catch {
    return [];
  }
}

export interface CiNoteInput {
  pr: number;
  headSha: string;
  failingLine?: string;
}

/** Build the note text. Never throws; a missing run or log is stated in the note. */
export function buildCiRoundNote(run: CommandRunner, cwd: string, input: CiNoteInput): string {
  const { headSha } = input;
  const runId = resolveGateRunId(run, cwd, headSha);
  let steps: string[] = [];
  let log: string | undefined;
  if (runId) {
    const jobs = run('gh', ['run', 'view', runId, '--json', 'jobs'], { cwd });
    if (jobs.status === 0) steps = failedSteps(jobs.stdout);
    const l = run('gh', ['run', 'view', runId, '--log-failed'], { cwd });
    if (l.status === 0 && l.stdout.trim() !== '') log = tailLog(l.stdout);
  }
  const stepName = steps.length > 0 ? steps.join('; ') : (input.failingLine ?? 'unknown step');
  const head = [
    `CI failed on PR #${input.pr} at head ${headSha}. Failed step: ${stepName}.`,
    'Fix the cause in this round, run the full verification, and push.',
  ];
  const body = log
    ? `Log tail:\n${log}`
    : 'The failing log could not be fetched; read it with `gh run view --log-failed` for this head.';
  let note = `${head.join(' ')}\n${body}`;
  if (note.length > MAX_NOTE_CHARS) {
    const room = MAX_NOTE_CHARS - head.join(' ').length - 40;
    note = `${head.join(' ')}\nLog tail:\n${tailLog(log ?? '', CI_LOG_TAIL_LINES, Math.max(room, 200)).slice(-Math.max(room, 200))}`;
  }
  return note.slice(0, MAX_NOTE_CHARS);
}

/** Write the note under the board directory (the only place `--note-file` reads) and return its path. */
export function writeCiRoundNote(boardDir: string, pr: number, headSha: string, note: string) {
  const dir = path.join(boardDir, 'landing', String(pr));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ci-round-${headSha.slice(0, 12)}.md`);
  writeFileSync(file, note, 'utf-8');
  return file;
}
