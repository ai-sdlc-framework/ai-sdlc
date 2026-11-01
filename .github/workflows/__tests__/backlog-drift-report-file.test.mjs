/**
 * Structural contract for the Backlog Drift step in ci.yml — AISDLC-796.
 *
 * The JSON report must be redirected to a file. A `$(...)` capture is cut at
 * the 64 KiB pipe buffer because backlog-drift calls process.exit(1) before
 * Node flushes the pipe, which made jq fail with a parse error on every PR.
 *
 * Run with: node --test .github/workflows/__tests__/backlog-drift-report-file.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOWS = ['ai-sdlc-gate.yml'];

/** Executable lines of every `backlog-drift ... --json` invocation, comments stripped. */
function jsonInvocations(file) {
  return readFileSync(join(REPO_ROOT, '.github', 'workflows', file), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .filter((l) => /backlog-drift(@\S+)?\s+check\s+--json/.test(l));
}

describe('Backlog Drift JSON report capture (AISDLC-796)', () => {
  it('ai-sdlc-gate.yml runs the JSON check', () => {
    assert.ok(jsonInvocations('ai-sdlc-gate.yml').length > 0);
  });

  for (const file of WORKFLOWS) {
    it(`${file} redirects the JSON report to a file, never a command substitution`, () => {
      for (const line of jsonInvocations(file)) {
        assert.doesNotMatch(line, /\$\(|`/, `capture reintroduced in ${file}: ${line.trim()}`);
        assert.match(
          line,
          />\s*"?\$\{?report\}?"?|>\s*"?\$\{?RUNNER_TEMP/,
          `${file}: ${line.trim()}`,
        );
      }
    });
  }

  it('reads the report from the file and fails with a named ::error:: on invalid JSON', () => {
    const src = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ai-sdlc-gate.yml'), 'utf8');
    assert.match(src, /report="\$\{RUNNER_TEMP[^"]*backlog-drift\.json"/);
    assert.match(src, /jq [^\n]*"\$report"/);
    assert.match(
      src,
      /::error::Backlog drift report \$\{report\} is not valid JSON[^\n]*exit code \$\{drift_rc\}/,
    );
  });
});
