/**
 * A passing decision evidence ledger for CLI tests (AISDLC-1452): the decision
 * gate refuses `add` and `answer` without one. The single entry is a `command`
 * fact, so the ledger passes against any repo root and lives outside it.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PASSING_LEDGER = {
  schemaVersion: 1,
  ref: 'test-decision',
  draftSha256: 'a'.repeat(64),
  researchedBy: 'test-research-agent',
  researchedAt: '2026-11-27T10:00:00Z',
  entries: [
    {
      id: 'f1',
      kind: 'fact',
      claim: 'the fixture command ran',
      status: 'checked',
      source: { command: 'true', output: 'ok', ranAt: '2026-11-27T10:00:00Z' },
    },
  ],
};

/** Write a passing ledger to a fresh temp dir; returns its path. */
export function writePassingLedger(ledger: unknown = PASSING_LEDGER): string {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-ledger-'));
  const path = join(dir, 'ledger.json');
  writeFileSync(path, JSON.stringify(ledger));
  return path;
}

/** Store a ledger where `answer` reads it: `<root>/.ai-sdlc/decisions/evidence/<id>.json`. */
export function storeLedger(root: string, id: string, ledger: unknown = PASSING_LEDGER): string {
  const dir = join(root, '.ai-sdlc', 'decisions', 'evidence');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify(ledger));
  return path;
}

/**
 * The argv a test means, plus `--evidence` where the decision gate needs one:
 * an `add` that is not an escalation, and an `answer` with no stored ledger.
 */
export function withEvidence(root: string, args: string[]): string[] {
  if (args.includes('--evidence')) return args;
  const [cmd, id] = args;
  const escalation = args.some((a, i) => a === '--source' && args[i + 1] === 'subagent-escalation');
  if (cmd === 'add' && !escalation) return [...args, '--evidence', writePassingLedger()];
  if (
    cmd === 'answer' &&
    typeof id === 'string' &&
    !existsSync(join(root, '.ai-sdlc', 'decisions', 'evidence', `${id}.json`))
  ) {
    return [...args, '--evidence', writePassingLedger()];
  }
  return args;
}
