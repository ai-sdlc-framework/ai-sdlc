/**
 * Decision evidence ledger (AISDLC-1451, DEC-0442).
 *
 * A research subagent that is not the question's author reads the exact draft
 * of a decision question, pulls out every factual claim and dependency path in
 * it, checks each at its source and writes one ledger
 * (`spec/schemas/decision-evidence-ledger.v1.schema.json`). This module is the
 * one checker every gate calls (`cli-decisions evidence check`, the
 * AskUserQuestion hook, `cli-decisions add`/`answer` and the RFC resolution
 * check of AISDLC-1452), plus the one draft hash they share.
 *
 * The checker re-verifies what it can (file quotes, record and task ids,
 * paths), so a check the agent claims to have done cannot simply be made up.
 *
 * @module decisions/evidence-ledger
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { listDecisions } from './projection.js';

export const EVIDENCE_LEDGER_SCHEMA_VERSION = 1;

/** Lines that cite the ledger itself; left out of the hash so adding one does not change it. */
const EVIDENCE_LINE = /^\s*Evidence:\s/;

/**
 * The one normalization behind `draftSha256`, shared by `cli-decisions
 * evidence hash` and the AskUserQuestion hook (AISDLC-1452): CRLF and CR
 * become LF, `Evidence: <path>` lines are dropped, trailing whitespace is
 * trimmed from every line, and leading and trailing blank lines are removed.
 * Any other edit (a word, an option, a number) changes the hash.
 */
export function normalizeDraftText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !EVIDENCE_LINE.test(line))
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** sha256 (hex) of the normalized draft. */
export function draftSha256(text: string): string {
  return createHash('sha256').update(normalizeDraftText(text), 'utf8').digest('hex');
}

export interface EvidenceFailure {
  /** Entry id, or `ledger` for a ledger-level failure. */
  entry: string;
  reason: string;
}

export interface EvidenceCheckResult {
  ok: boolean;
  failures: EvidenceFailure[];
}

export interface EvidenceCheckOptions {
  /** Root the file quotes, paths, RFCs and tasks resolve against (the main checkout). */
  repoRoot: string;
  /** The draft text the ledger must match; omit to skip the hash comparison. */
  draftText?: string;
  /** Override for DEC existence; default projects the catalog under `repoRoot`. */
  decisionExists?: (id: string) => boolean;
}

/** Lines either side of `line` a file quote may sit on. */
export const QUOTE_LINE_TOLERANCE = 5;

const DEC_ID = /^DEC-\d{4,}$/;
const RFC_ID = /^RFC-\d{4}$/;
const TASK_ID = /^[A-Z][A-Z0-9]*-\d+(\.\d+)*$/;
const REF = /^(DEC-\d{4,}|rfc:RFC-\d{4}#OQ-[A-Za-z0-9.-]+|[a-z0-9][a-z0-9-]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isDate(v: unknown): boolean {
  return nonEmpty(v) && !Number.isNaN(Date.parse(v));
}

/** Resolve `p` under `root`; `null` when it escapes the root. */
function insideRoot(root: string, p: string): string | null {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  return rel.startsWith('..') || isAbsolute(rel) ? null : abs;
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function taskExists(root: string, id: string): boolean {
  const prefix = `${id.toLowerCase()} - `;
  return ['tasks', 'completed'].some((d) =>
    listNames(join(root, 'backlog', d)).some((n) => n.toLowerCase().startsWith(prefix)),
  );
}

function rfcExists(root: string, id: string): boolean {
  return listNames(join(root, 'spec', 'rfcs')).some((n) => n.startsWith(`${id}-`));
}

/** Check one ledger. Never throws; every problem is one failure naming its entry. */
export function checkEvidenceLedger(
  ledger: unknown,
  opts: EvidenceCheckOptions,
): EvidenceCheckResult {
  const failures: EvidenceFailure[] = [];
  const fail = (entry: string, reason: string): void => {
    failures.push({ entry, reason });
  };
  const root = opts.repoRoot;
  let decIds: Set<string> | null = null;
  const decisionExists =
    opts.decisionExists ??
    ((id: string): boolean => {
      decIds ??= new Set(listDecisions({ workDir: root }).decisions.map((d) => d.metadata.id));
      return decIds.has(id);
    });
  const recordExists = (id: string): boolean => {
    if (DEC_ID.test(id)) return decisionExists(id);
    if (RFC_ID.test(id)) return rfcExists(root, id);
    if (TASK_ID.test(id)) return taskExists(root, id);
    return false;
  };

  if (!isObj(ledger)) {
    return { ok: false, failures: [{ entry: 'ledger', reason: 'not a JSON object' }] };
  }
  if (ledger.schemaVersion !== EVIDENCE_LEDGER_SCHEMA_VERSION) {
    fail('ledger', `schemaVersion must be ${EVIDENCE_LEDGER_SCHEMA_VERSION}`);
  }
  if (!nonEmpty(ledger.ref) || !REF.test(ledger.ref)) {
    fail('ledger', 'ref must be DEC-NNNN, rfc:RFC-NNNN#OQ-N or a lower-case slug');
  }
  if (!nonEmpty(ledger.draftSha256) || !SHA256.test(ledger.draftSha256)) {
    fail('ledger', 'draftSha256 must be a 64-character hex sha256');
  } else if (opts.draftText !== undefined) {
    const actual = draftSha256(opts.draftText);
    if (actual !== ledger.draftSha256) {
      fail(
        'ledger',
        `draftSha256 does not match the draft (draft hashes to ${actual}); the draft changed after the research, so research it again`,
      );
    }
  }
  if (!nonEmpty(ledger.researchedBy)) fail('ledger', 'researchedBy is missing');
  if (!isDate(ledger.researchedAt)) fail('ledger', 'researchedAt must be an ISO date-time');

  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  if (entries.length === 0) fail('ledger', 'the ledger has no entries');

  const seen = new Set<string>();
  const factPasses = new Map<string, boolean>();
  const assumptions: Array<{ id: string; e: Obj }> = [];

  entries.forEach((raw: unknown, index: number) => {
    const e = isObj(raw) ? raw : {};
    const id = nonEmpty(e.id) ? e.id : `#${index + 1}`;
    const before = failures.length;
    const entryFail = (reason: string): void => fail(id, reason);
    if (!nonEmpty(e.id)) entryFail('entry has no id');
    else if (seen.has(e.id)) entryFail('duplicate entry id');
    seen.add(id);
    if (!nonEmpty(e.claim)) entryFail('entry has no claim');
    if (e.status !== 'checked') {
      entryFail(
        `status is ${JSON.stringify(e.status ?? null)}; the only final state is "checked" (anything that cannot be checked is an assumption resting on checked facts, or a gap to close first)`,
      );
    }
    switch (e.kind) {
      case 'fact':
        checkFactSource(e.source, root, recordExists, entryFail);
        factPasses.set(id, failures.length === before);
        break;
      case 'dependency':
        checkDependency(e, root, entryFail);
        break;
      case 'assumption':
        assumptions.push({ id, e });
        break;
      default:
        entryFail(`kind must be fact, dependency or assumption (got ${JSON.stringify(e.kind)})`);
    }
  });

  for (const { id, e } of assumptions) {
    const restsOn = Array.isArray(e.restsOn) ? e.restsOn : [];
    if (restsOn.length === 0) {
      fail(id, 'assumption has no restsOn; it must rest on at least one checked fact');
    }
    for (const ref of restsOn) {
      if (factPasses.get(String(ref)) !== true) {
        fail(id, `restsOn ${JSON.stringify(ref)} is not a passing fact entry`);
      }
    }
    if (!nonEmpty(e.falsifiedBy)) fail(id, 'assumption has no falsifiedBy');
  }

  return { ok: failures.length === 0, failures };
}

function checkFactSource(
  source: unknown,
  root: string,
  recordExists: (id: string) => boolean,
  fail: (reason: string) => void,
): void {
  if (!isObj(source)) {
    fail('fact has no source');
    return;
  }
  if ('file' in source) {
    const { file, line, quote } = source;
    if (!nonEmpty(file) || !nonEmpty(quote) || !Number.isInteger(line) || (line as number) < 1) {
      fail('file source needs file, line (>= 1) and quote');
      return;
    }
    const abs = insideRoot(root, file);
    let text: string | null;
    try {
      text = abs ? readFileSync(abs, 'utf8') : null;
    } catch {
      text = null;
    }
    if (text === null) {
      fail(`file ${file} does not exist`);
      return;
    }
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const from = Math.max(0, (line as number) - 1 - QUOTE_LINE_TOLERANCE);
    const to = Math.min(lines.length, (line as number) + QUOTE_LINE_TOLERANCE);
    if (!lines.slice(from, to).join('\n').includes(quote)) {
      fail(
        `quote not found in ${file} within ${QUOTE_LINE_TOLERANCE} lines of line ${String(line)}`,
      );
    }
    return;
  }
  if ('command' in source) {
    if (!nonEmpty(source.command) || !nonEmpty(source.output) || !isDate(source.ranAt)) {
      fail('command source needs command, output and an ISO ranAt');
    }
    return;
  }
  if ('url' in source) {
    if (
      !nonEmpty(source.url) ||
      !/^https?:\/\//.test(source.url) ||
      !isDate(source.readAt) ||
      !nonEmpty(source.quote)
    ) {
      fail('url source needs an http(s) url, an ISO readAt and a quote');
    }
    return;
  }
  if ('record' in source) {
    if (!nonEmpty(source.record)) fail('record source has no id');
    else if (!recordExists(source.record)) fail(`record ${source.record} does not exist on main`);
    return;
  }
  fail(
    'fact source must be one of {file, line, quote}, {command, output, ranAt}, {url, readAt, quote} or {record}',
  );
}

function checkDependency(e: Obj, root: string, fail: (reason: string) => void): void {
  if (!nonEmpty(e.what)) fail('dependency has no what');
  if (isObj(e.exists)) {
    const p = e.exists.path;
    if (!nonEmpty(p)) fail('dependency exists.path is missing');
    else {
      const abs = insideRoot(root, p);
      if (!abs || !existsSync(abs)) fail(`path ${p} does not exist`);
    }
    return;
  }
  if (e.prerequisite !== undefined) {
    const t = e.prerequisite;
    if (!nonEmpty(t) || !TASK_ID.test(t)) fail('dependency prerequisite must be a task id');
    else if (!taskExists(root, t)) fail(`prerequisite task ${t} is not filed`);
    return;
  }
  fail('dependency has no source: give exists.path or a prerequisite task id');
}

/** One line per failure, for stderr. */
export function formatEvidenceFailures(failures: EvidenceFailure[]): string {
  return failures.map((f) => `  ${f.entry}: ${f.reason}`).join('\n');
}
