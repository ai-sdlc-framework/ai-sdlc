/**
 * AISDLC-797: no workflow step may capture a tool's JSON output through a shell
 * pipe. Node does not flush pending pipe writes on process.exit(), so a
 * `$(...)` capture is cut at the 64 KiB pipe buffer and fails later as a jq
 * parse error that looks like a branch problem (the 2026-10-10 Backlog Drift
 * outage). The accepted pattern is a redirect to "$RUNNER_TEMP/<name>.json"
 * followed by a validity check.
 *
 * Run with: node --test .github/workflows/__tests__/no-json-capture.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TOOL = /\b(node|npx|pnpm)\b|\bcli-[\w-]+\.mjs\b/;
const JSON_FLAG = /--json\b|--format[ =]json\b/;

/**
 * Offending captures in a workflow's text. A capture is `NAME=$(...)` or
 * `NAME="$(...)"` whose command is a node/npx/pnpm/cli-*.mjs invocation and
 * either carries a JSON flag, is piped to jq, or whose variable is later
 * piped into jq.
 */
export function findJsonCaptures(text) {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('#')) continue;
    const m = lines[i].match(/\b([A-Za-z_][A-Za-z0-9_]*)=("?)\$\(/);
    if (!m) continue;
    // Join continuation lines until the substitution closes (balanced parens).
    let cmd = lines[i].slice(m.index + m[0].length);
    let depth = 1;
    let j = i;
    const count = (t) => {
      for (const ch of t) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
    };
    count(cmd);
    while (depth > 0 && j + 1 < lines.length) {
      j++;
      cmd += '\n' + lines[j];
      count(lines[j]);
    }
    if (!TOOL.test(cmd)) continue;
    const pipedToJq = /\|\s*jq\b/.test(cmd);
    const laterJq = new RegExp(`\\$\\{?${m[1]}\\}?["']?\\s*\\|\\s*jq\\b`).test(
      lines.slice(j + 1).join('\n'),
    );
    if (JSON_FLAG.test(cmd) || pipedToJq || laterJq) {
      found.push({ line: i + 1, text: lines[i].trim() });
    }
  }
  return found;
}

describe('workflows never capture tool JSON through a shell pipe (AISDLC-797)', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'));

  for (const file of files) {
    it(`${file} has no tool-JSON command-substitution capture`, () => {
      const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
      assert.deepEqual(
        findJsonCaptures(text),
        [],
        `${file}: redirect to "$RUNNER_TEMP/<name>.json" and validate with jq -e instead`,
      );
    });
  }

  it('the detector flags the offending shapes and passes the accepted one', () => {
    assert.equal(findJsonCaptures('json="$(npx backlog-drift check --json)"').length, 1);
    assert.equal(findJsonCaptures('R=$(node tool.mjs --format json)').length, 1);
    assert.equal(findJsonCaptures('R=$(node cli-x.mjs run)\necho "$R" | jq .a').length, 1);
    assert.equal(
      findJsonCaptures('R=$(node cli-x.mjs \\\n  --a b)\nprintf %s "$R" | jq .a').length,
      1,
    );
    assert.equal(findJsonCaptures('R=$(node x.mjs | jq .a)').length, 1);
    assert.equal(
      findJsonCaptures('npx backlog-drift check --json > "$RUNNER_TEMP/d.json"').length,
      0,
    );
    assert.equal(findJsonCaptures('N=$(git rev-parse HEAD)').length, 0);
    assert.equal(findJsonCaptures('# json="$(npx tool --json)"').length, 0);
  });
});
