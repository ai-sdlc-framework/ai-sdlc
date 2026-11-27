/**
 * The ONE decision evidence ledger checker (AISDLC-1451, DEC-0442).
 *
 * Dependency-free ESM so every gate runs the same rules without a build:
 * `pipeline-cli/src/decisions/evidence-ledger.ts` (the `cli-decisions evidence
 * check`, `add` and `answer` paths, and through the CLI the AskUserQuestion
 * hook) re-exports it, and `scripts/check-rfc-docs.mjs` imports it directly in
 * the governance gate, which runs a trusted copy of this directory with no
 * install (AISDLC-1452). Types: `evidence-ledger-core.d.mts`.
 *
 * A research subagent that is not the question's author reads the exact draft
 * of a decision question, pulls out every factual claim and dependency path in
 * it, checks each at its source and writes one ledger
 * (`spec/schemas/decision-evidence-ledger.v1.schema.json`). The checker
 * re-verifies what it can (file quotes, record and task ids, paths), so a check
 * the agent claims to have done cannot simply be made up.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const EVIDENCE_LEDGER_SCHEMA_VERSION = 1;

/** Where a filed decision's ledger lives, relative to the repo root (AISDLC-1452). */
export const DECISION_EVIDENCE_DIR = '.ai-sdlc/decisions/evidence';

/** The command a refusal names so the author can re-check a ledger. */
export const EVIDENCE_CHECK_COMMAND = 'node pipeline-cli/bin/cli-decisions.mjs evidence check';

/** Lines that cite the ledger itself; left out of the hash so adding one does not change it. */
const EVIDENCE_LINE = /^\s*Evidence:\s/;

/**
 * The one normalization behind `draftSha256`: CRLF and CR become LF,
 * `Evidence: <path>` lines are dropped, trailing whitespace is trimmed from
 * every line, and leading and trailing blank lines are removed. Any other edit
 * (a word, an option, a number) changes the hash.
 */
export function normalizeDraftText(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !EVIDENCE_LINE.test(line))
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** sha256 (hex) of the normalized draft. */
export function draftSha256(text) {
  return createHash('sha256').update(normalizeDraftText(text), 'utf8').digest('hex');
}

/** Lines either side of `line` a file quote may sit on. */
export const QUOTE_LINE_TOLERANCE = 5;

const DEC_ID = /^DEC-\d{4,}$/;
const RFC_ID = /^RFC-\d{4}$/;
const TASK_ID = /^[A-Z][A-Z0-9]*-\d+(\.\d+)*$/;
const REF = /^(DEC-\d{4,}|rfc:RFC-\d{4}#OQ-[A-Za-z0-9.-]+|[a-z0-9][a-z0-9-]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isDate(v) {
  return nonEmpty(v) && !Number.isNaN(Date.parse(v));
}

/** Resolve `p` under `root`; `null` when it escapes the root. */
function insideRoot(root, p) {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  return rel.startsWith('..') || isAbsolute(rel) ? null : abs;
}

function listNames(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function taskExists(root, id) {
  const prefix = `${id.toLowerCase()} - `;
  return ['tasks', 'completed'].some((d) =>
    listNames(join(root, 'backlog', d)).some((n) => n.toLowerCase().startsWith(prefix)),
  );
}

function rfcExists(root, id) {
  return listNames(join(root, 'spec', 'rfcs')).some((n) => n.startsWith(`${id}-`));
}

/**
 * Default DEC lookup with no catalog projection: a `decision-opened` event for
 * the id in the per-event store or the legacy log under `root`. The TypeScript
 * wrapper replaces it with the projected catalog.
 */
export function decisionOpenedOnDisk(root, id) {
  const dir = join(root, '.ai-sdlc', '_decisions');
  if (listNames(join(dir, 'events')).some((n) => n.includes(`__${id}__decision-opened__`))) {
    return true;
  }
  let legacy = '';
  try {
    legacy = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  } catch {
    return false;
  }
  return legacy
    .split('\n')
    .some((l) => l.includes(`"decisionId":"${id}"`) && l.includes('"type":"decision-opened"'));
}

/** Check one ledger. Never throws; every problem is one failure naming its entry. */
export function checkEvidenceLedger(ledger, opts) {
  const failures = [];
  const fail = (entry, reason) => {
    failures.push({ entry, reason });
  };
  const root = opts.repoRoot;
  const decisionExists = opts.decisionExists ?? ((id) => decisionOpenedOnDisk(root, id));
  const recordExists = (id) => {
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

  const seen = new Set();
  const factPasses = new Map();
  const assumptions = [];

  entries.forEach((raw, index) => {
    const e = isObj(raw) ? raw : {};
    const id = nonEmpty(e.id) ? e.id : `#${index + 1}`;
    const before = failures.length;
    const entryFail = (reason) => fail(id, reason);
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

function checkFactSource(source, root, recordExists, fail) {
  if (!isObj(source)) {
    fail('fact has no source');
    return;
  }
  if ('file' in source) {
    const { file, line, quote } = source;
    if (!nonEmpty(file) || !nonEmpty(quote) || !Number.isInteger(line) || line < 1) {
      fail('file source needs file, line (>= 1) and quote');
      return;
    }
    const abs = insideRoot(root, file);
    let text;
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
    const from = Math.max(0, line - 1 - QUOTE_LINE_TOLERANCE);
    const to = Math.min(lines.length, line + QUOTE_LINE_TOLERANCE);
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

function checkDependency(e, root, fail) {
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
export function formatEvidenceFailures(failures) {
  return failures.map((f) => `  ${f.entry}: ${f.reason}`).join('\n');
}

/**
 * The refusal every gate prints (AISDLC-1452 AC 4): the ledger, each failing
 * entry, and the command that re-checks it.
 */
export function formatEvidenceRefusal(ledgerPath, failures) {
  return (
    `evidence ledger ${ledgerPath} fails:\n${formatEvidenceFailures(failures)}\n` +
    `Fix the entries, then re-check: ${EVIDENCE_CHECK_COMMAND} ${ledgerPath}`
  );
}

/** Parse ledger JSON text; a parse error is one ledger-level failure. */
export function parseEvidenceLedger(text) {
  try {
    return { ledger: JSON.parse(String(text)) };
  } catch (e) {
    return {
      ledger: null,
      failures: [{ entry: 'ledger', reason: `not valid JSON: ${e.message}` }],
    };
  }
}
