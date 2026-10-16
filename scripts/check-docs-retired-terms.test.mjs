/**
 * Retired-term gate for docs/ (AISDLC-893).
 *
 * A line in docs/**\/*.md that names a retired token must also say it is retired
 * (retired, superseded, deleted or removed on the same line). Audits, upstream bug
 * reports and whitepapers are historical records and are excluded.
 *
 * Run with: node --test scripts/check-docs-retired-terms.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const RETIRED_TOKENS = [
  'cli-orchestrator tick',
  'orchestrator-tick',
  'AI_SDLC_AUTONOMOUS_ORCHESTRATOR',
  'AI_SDLC_TUI',
  'execute-parallel',
  'dispatch-worker',
  'Pattern Z',
  'auto-rearm-on-dequeue.yml',
  'isolated-review.yml',
  'ai-sdlc-fix-ci.yml',
];

const RETIREMENT_WORDS = /retired|superseded|deleted|removed/i;
const EXCLUDED_DIRS = new Set(['audits', 'upstream-bug-reports', 'whitepapers']);

/**
 * Pages kept despite retired tokens: `path` -> reason. Shrink-only: fix the page, then
 * delete its entry (a stale entry fails the test below). Keyed by file, not line, so
 * concurrent edits that shift line numbers do not break the gate.
 */
export const ALLOWLIST = {
  'docs/concepts/autonomous-orchestrator.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/README.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/auto-rebase-stale-prs.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/backlog-and-execution-reference.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/billing-and-cost-optimization.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/ci-conflict-resolver.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/claude-cli-spawner-removed.md':
    'migration page that describes the removed spawner by its old commands',
  'docs/operations/cli-hierarchy.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/copilot-execution-path.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/copilot-spawner.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/dispatched-session-decisions.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/gate-audit-2026-10.md':
    'historical audit record naming the workflows it audited',
  'docs/operations/pre-push-and-ci-reference.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/release-and-plugin-reference.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/remote-agents-readonly.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/reviewer-dispatch-defaults.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
  'docs/operations/usage-ledger.md':
    'sibling docs sweep (stale orchestrator and flag sentences) owns the rewrite; allowlisted so this gate can land',
};

/** Returns the retired tokens a single line uses without a retirement word. */
export function offendingTokens(line) {
  if (RETIREMENT_WORDS.test(line)) return [];
  return RETIRED_TOKENS.filter((t) => line.includes(t));
}

function listDocs(dir, top = true) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (top && entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listDocs(p, false));
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

describe('docs retired terms', () => {
  it('flags a retired token used without a retirement word (fixture)', () => {
    assert.deepEqual(offendingTokens('Run `/ai-sdlc orchestrator-tick` to drain.'), [
      'orchestrator-tick',
    ]);
    assert.deepEqual(
      offendingTokens('`orchestrator-tick` was retired in favour of cli-hierarchy.'),
      [],
    );
    assert.deepEqual(offendingTokens('Nothing retired-looking here is absent.'), []);
    assert.deepEqual(offendingTokens('plain line'), []);
  });

  it('no docs page uses a retired token without saying it is retired', () => {
    const failures = [];
    const used = new Set();
    for (const file of listDocs(join(root, 'docs'))) {
      const rel = relative(root, file);
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          for (const token of offendingTokens(line)) {
            if (ALLOWLIST[rel]) used.add(rel);
            else failures.push(`${rel}:${i + 1}: ${token}`);
          }
        });
    }
    assert.deepEqual(failures, [], `retired terms in docs:\n${failures.join('\n')}`);
    const stale = Object.keys(ALLOWLIST).filter((f) => !used.has(f));
    assert.deepEqual(
      stale,
      [],
      `allowlist entries with no retired token left (delete them): ${stale}`,
    );
  });
});
