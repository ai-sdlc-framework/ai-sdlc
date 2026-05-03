/**
 * Tests for `cli-classify-budget` (AISDLC-147 patch 2).
 *
 * Drives the CLI against tempfiles to verify that:
 *   - All-3-budget input emits `aggregate: 'skip-with-budget-comment'`.
 *   - Mixed input emits `aggregate: 'proceed-as-normal'`.
 *   - Missing input files (e.g. workflow regression where one reviewer
 *     never produced a file) are tolerated as empty strings.
 *   - The CLI reads the LAST line of each stdout file (matches the
 *     existing `tail -1` shape used by the report job's parser).
 *
 * Hermetic — uses tempdir + spawned child for the stdout-capture test
 * so we exercise the full bin entry, not just the exported function.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClassifyBudgetCli } from './classify-budget.js';

const validVerdict = JSON.stringify({ approved: true, findings: [], summary: 'LGTM' });
const budgetStderr =
  'Error: 400 invalid_request_error: credit balance is too low to access the Anthropic API';

let tmp: string;
let originalArgv: string[];
let captured: string[];
let originalWrite: typeof process.stdout.write;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'aisdlc-147-budget-cli-'));
  originalArgv = process.argv;
  captured = [];
  originalWrite = process.stdout.write.bind(process.stdout);
  // Capture stdout so we can assert on the JSON the CLI emits.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
});

afterEach(async () => {
  process.argv = originalArgv;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = originalWrite;
  await rm(tmp, { recursive: true, force: true });
});

async function runWith(files: {
  testingStdout?: string;
  testingStderr?: string;
  criticStdout?: string;
  criticStderr?: string;
  securityStdout?: string;
  securityStderr?: string;
}): Promise<{ stdout: string; parsed: Record<string, unknown> }> {
  const args: string[] = ['node', 'cli-classify-budget'];
  for (const [k, v] of Object.entries(files)) {
    if (v === undefined) continue;
    // Map camelCase test arg → kebab-case CLI flag (testingStdout → testing-stdout)
    const flag =
      '--' +
      k
        .replace(/([A-Z])/g, '-$1')
        .toLowerCase()
        .replace(/^-/, '');
    const path = join(tmp, k);
    await writeFile(path, v, 'utf-8');
    args.push(flag, path);
  }
  process.argv = args;
  await runClassifyBudgetCli();
  const stdout = captured.join('');
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  return { stdout, parsed };
}

describe('cli-classify-budget', () => {
  it('all-3-budget-exhausted → skip-with-budget-comment', async () => {
    const { parsed } = await runWith({
      testingStderr: budgetStderr,
      criticStderr: budgetStderr,
      securityStderr: budgetStderr,
    });
    expect(parsed.aggregate).toBe('skip-with-budget-comment');
    expect(parsed.budgetExhaustedCount).toBe(3);
  });

  it('all-3-ok → proceed-as-normal', async () => {
    const { parsed } = await runWith({
      testingStdout: validVerdict,
      criticStdout: validVerdict,
      securityStdout: validVerdict,
    });
    expect(parsed.aggregate).toBe('proceed-as-normal');
    expect(parsed.budgetExhaustedCount).toBe(0);
  });

  it('AISDLC-157: mixed (2 budget + 1 ok) → skip-with-budget-comment (broadened from AISDLC-147 all-3 rule)', async () => {
    // Reproduces the PR #202 case where AISDLC-141's classifier wrote
    // an AUTO_APPROVED stub for the unselected reviewer and the other 2
    // hit credit exhaustion. Under the AISDLC-147 "all 3 must be exhausted"
    // gate this fell through to proceed-as-normal and posted a noisy
    // CHANGES_REQUESTED. The AISDLC-157 rule "≥1 budget + 0 other-failure"
    // catches this correctly.
    const { parsed } = await runWith({
      testingStdout: validVerdict,
      criticStderr: budgetStderr,
      securityStderr: budgetStderr,
    });
    expect(parsed.aggregate).toBe('skip-with-budget-comment');
    expect(parsed.budgetExhaustedCount).toBe(2);
  });

  it('AISDLC-157: mixed (1 budget + 1 other-failure + 1 ok) → proceed-as-normal (other-failure surfaces real signal)', async () => {
    // The presence of any other-failure forces proceed-as-normal so the
    // existing CHANGES_REQUESTED safety net surfaces the real failure
    // (here: a malformed verdict that's NOT budget-related).
    const { parsed } = await runWith({
      testingStdout: validVerdict,
      criticStdout: '{ broken json',
      securityStderr: budgetStderr,
    });
    expect(parsed.aggregate).toBe('proceed-as-normal');
    expect(parsed.budgetExhaustedCount).toBe(1);
  });

  it('missing input files tolerated as empty (workflow regression safety)', async () => {
    const { parsed } = await runWith({});
    expect(parsed.aggregate).toBe('proceed-as-normal');
    expect(parsed.budgetExhaustedCount).toBe(0);
    // perReviewer should still report all 3 — the CLI synthesizes
    // entries for missing inputs using empty strings.
    expect(Array.isArray(parsed.perReviewer)).toBe(true);
    expect((parsed.perReviewer as unknown[]).length).toBe(3);
  });

  it('reads LAST non-empty line of stdout (matches existing tail -1 shape)', async () => {
    // The reviewer writes structured logs throughout — only the last line
    // is the JSON verdict. Assert the CLI mirrors this.
    const stdoutWithLogs = `[review/testing] starting…\n[review/testing] analyzing 14 files…\n${validVerdict}`;
    const { parsed } = await runWith({
      testingStdout: stdoutWithLogs,
      criticStdout: validVerdict,
      securityStdout: validVerdict,
    });
    expect(parsed.aggregate).toBe('proceed-as-normal');
    expect(parsed.budgetExhaustedCount).toBe(0);
    // testing should be classified `ok` because we read the last line.
    expect((parsed.perReviewer as Array<{ classification: string }>)[0].classification).toBe('ok');
  });

  it('AISDLC-154: passes WHOLE stdout to classifier — multi-line stdout with budget body → all-3-budget', async () => {
    // PR #196 CI run 25267752415 reproduction: cli-review wrote multi-line
    // pretty-printed JSON containing the credit-exhaustion text inside the
    // body. Without AISDLC-154 the CLI sliced off everything except `}` on
    // the last line, the classifier saw a single `}` plus empty stderr,
    // and returned `other-failure` for all three reviewers — yielding
    // proceed-as-normal and a noisy CHANGES_REQUESTED on the PR.
    //
    // With AISDLC-154 the CLI passes the whole stdout via stdoutRaw, the
    // substring fallback inspects the full body, and the aggregate
    // correctly resolves to skip-with-budget-comment.
    const multiLineBudgetStdout = `{
  "approved": false,
  "findings": [
    {
      "severity": "critical",
      "message": "Review agent failed: Anthropic API error 400: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"Your credit balance is too low to access the Anthropic API.\\"}}"
    }
  ],
  "summary": "review could not be completed"
}`;
    const { parsed } = await runWith({
      testingStdout: multiLineBudgetStdout,
      criticStdout: multiLineBudgetStdout,
      securityStdout: multiLineBudgetStdout,
    });
    expect(parsed.aggregate).toBe('skip-with-budget-comment');
    expect(parsed.budgetExhaustedCount).toBe(3);
    // Sanity — every reviewer classified as budget-exhausted, none as
    // other-failure (which would indicate the whole-stdout plumbing broke).
    expect(
      (parsed.perReviewer as Array<{ classification: string }>).map((p) => p.classification),
    ).toEqual(['budget-exhausted', 'budget-exhausted', 'budget-exhausted']);
  });
});
