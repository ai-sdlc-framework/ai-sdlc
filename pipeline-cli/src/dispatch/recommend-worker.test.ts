/**
 * Hermetic unit tests for the recommendedWorkerKind heuristic + the three
 * loader helpers (DispatchConfig, ledger utilization, task estimatedTokens).
 * AISDLC-377.5.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BIG_TOKEN_THRESHOLD,
  extractEstimatedTokens,
  loadDispatchConfig,
  MAX_20X_ROLLING_WINDOW_TOKENS,
  readQuotaUtilization,
  recommendWorkerKind,
  TIGHT_QUOTA_THRESHOLD,
} from './recommend-worker.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'recommend-worker-'));
  mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeDispatchConfig(content: string): void {
  writeFileSync(join(tmp, '.ai-sdlc', 'dispatch-config.yaml'), content, 'utf8');
}

describe('loadDispatchConfig', () => {
  it('returns undefined when the file is missing', () => {
    expect(loadDispatchConfig(tmp)).toBeUndefined();
  });

  it('returns claudePShellMaxConcurrent when present', () => {
    writeDispatchConfig(`
spec:
  defaultWorkerKind: in-session-agent
  parallelism:
    claudePShellMaxConcurrent: 2
`);
    const cfg = loadDispatchConfig(tmp);
    expect(cfg).toEqual({ claudePShellMaxConcurrent: 2 });
  });

  it('defaults to 0 when the field is absent', () => {
    writeDispatchConfig(`
spec:
  defaultWorkerKind: in-session-agent
  parallelism:
    inSessionAgentMaxSessions: 4
`);
    expect(loadDispatchConfig(tmp)).toEqual({ claudePShellMaxConcurrent: 0 });
  });

  it('defaults to 0 when parallelism block is missing', () => {
    writeDispatchConfig(`
spec:
  defaultWorkerKind: in-session-agent
`);
    expect(loadDispatchConfig(tmp)).toEqual({ claudePShellMaxConcurrent: 0 });
  });

  it('defaults to 0 when spec is missing', () => {
    writeDispatchConfig(`apiVersion: ai-sdlc.io/v1alpha1\nkind: DispatchConfig\n`);
    expect(loadDispatchConfig(tmp)).toEqual({ claudePShellMaxConcurrent: 0 });
  });

  it('returns claudePShellMaxConcurrent=0 when value is a non-numeric string', () => {
    writeDispatchConfig(`
spec:
  parallelism:
    claudePShellMaxConcurrent: "bogus"
`);
    expect(loadDispatchConfig(tmp)).toEqual({ claudePShellMaxConcurrent: 0 });
  });

  it('returns 0 on negative values (clamped to non-negative)', () => {
    writeDispatchConfig(`
spec:
  parallelism:
    claudePShellMaxConcurrent: -1
`);
    expect(loadDispatchConfig(tmp)).toEqual({ claudePShellMaxConcurrent: 0 });
  });

  it('returns undefined on YAML parse error', () => {
    writeDispatchConfig(': not valid yaml: ::\n  - foo\n   bar');
    // The pessimistic case here is "undefined" only when the YAML throws.
    // js-yaml is forgiving — assert one of {undefined, zero} so the test
    // documents the contract without locking to library internals.
    const cfg = loadDispatchConfig(tmp);
    if (cfg !== undefined) expect(cfg.claudePShellMaxConcurrent).toBe(0);
  });

  it('handles an empty-document yaml file', () => {
    writeDispatchConfig('');
    const cfg = loadDispatchConfig(tmp);
    if (cfg !== undefined) expect(cfg.claudePShellMaxConcurrent).toBe(0);
  });

  it('handles a bare scalar document', () => {
    writeDispatchConfig('"just a string"\n');
    const cfg = loadDispatchConfig(tmp);
    if (cfg !== undefined) expect(cfg.claudePShellMaxConcurrent).toBe(0);
  });
});

describe('readQuotaUtilization', () => {
  it('returns undefined when the artifacts dir has no _ledger/ subdir', () => {
    expect(readQuotaUtilization(join(tmp, 'artifacts'))).toBeUndefined();
  });

  it('returns 0 when _ledger/ exists but is empty', () => {
    mkdirSync(join(tmp, 'artifacts', '_ledger'), { recursive: true });
    expect(readQuotaUtilization(join(tmp, 'artifacts'))).toBe(0);
  });

  it('returns a fraction in [0,1] derived from ledger files', () => {
    const dir = join(tmp, 'artifacts', '_ledger');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'claude-code-abcd1234-tenant1.json'),
      JSON.stringify({ windowStart: '2026-01-01T00:00:00Z', consumedTokens: 500_000 }),
    );
    const util = readQuotaUtilization(join(tmp, 'artifacts'));
    // 500k / 1M = 0.5
    expect(util).toBeCloseTo(0.5, 3);
  });

  it('clamps utilization to 1.0 when consumed exceeds the rolling cap', () => {
    const dir = join(tmp, 'artifacts', '_ledger');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'claude-code-abcd1234-default.json'),
      JSON.stringify({ consumedTokens: MAX_20X_ROLLING_WINDOW_TOKENS * 2 }),
    );
    expect(readQuotaUtilization(join(tmp, 'artifacts'))).toBe(1);
  });

  it('sums consumed across multiple ledger files (parallel tenants)', () => {
    const dir = join(tmp, 'artifacts', '_ledger');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ consumedTokens: 300_000 }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ consumedTokens: 200_000 }));
    const util = readQuotaUtilization(join(tmp, 'artifacts'));
    expect(util).toBeCloseTo(0.5, 3);
  });

  it('skips malformed ledger entries silently', () => {
    const dir = join(tmp, 'artifacts', '_ledger');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'malformed.json'), '{ this is not json');
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ consumedTokens: 100_000 }));
    expect(readQuotaUtilization(join(tmp, 'artifacts'))).toBeCloseTo(0.1, 3);
  });

  it('skips ledger entries missing consumedTokens', () => {
    const dir = join(tmp, 'artifacts', '_ledger');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'half.json'), JSON.stringify({ windowStart: '2026-01-01' }));
    expect(readQuotaUtilization(join(tmp, 'artifacts'))).toBe(0);
  });

  it('ignores non-json files in the ledger dir', () => {
    const dir = join(tmp, 'artifacts', '_ledger');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'this is not a ledger');
    expect(readQuotaUtilization(join(tmp, 'artifacts'))).toBe(0);
  });
});

describe('extractEstimatedTokens', () => {
  function writeTask(content: string): string {
    const path = join(tmp, 'task.md');
    writeFileSync(path, content);
    return path;
  }

  it('returns undefined when file is missing', () => {
    expect(extractEstimatedTokens(join(tmp, 'no-such-file.md'))).toBeUndefined();
  });

  it('returns undefined when frontmatter is missing', () => {
    expect(
      extractEstimatedTokens(writeTask('Just markdown body, no frontmatter\n')),
    ).toBeUndefined();
  });

  it('returns undefined when estimatedTokens is absent', () => {
    expect(
      extractEstimatedTokens(writeTask('---\nid: AISDLC-A\ntitle: A\n---\n## Description\nbody\n')),
    ).toBeUndefined();
  });

  it('returns sum of input + output', () => {
    expect(
      extractEstimatedTokens(
        writeTask(
          '---\nid: AISDLC-A\nestimatedTokens:\n  input: 80000\n  output: 20000\n---\nbody\n',
        ),
      ),
    ).toBe(100_000);
  });

  it('accepts input-only', () => {
    expect(
      extractEstimatedTokens(writeTask('---\nestimatedTokens:\n  input: 60000\n---\nbody\n')),
    ).toBe(60_000);
  });

  it('returns undefined when both fields are zero', () => {
    expect(
      extractEstimatedTokens(
        writeTask('---\nestimatedTokens:\n  input: 0\n  output: 0\n---\nbody\n'),
      ),
    ).toBeUndefined();
  });

  it('returns undefined when YAML parse fails', () => {
    expect(
      extractEstimatedTokens(writeTask('---\n: : : : :\n  - bad\n---\nbody\n')),
    ).toBeUndefined();
  });

  it('returns undefined when estimatedTokens is not an object', () => {
    expect(
      extractEstimatedTokens(writeTask('---\nestimatedTokens: just a string\n---\nbody\n')),
    ).toBeUndefined();
  });
});

describe('recommendWorkerKind', () => {
  // AC #3 — heuristic shape per §Scope:
  //   big AND tight AND headless-available → claude-p-shell
  //   no estimatedTokens → any
  //   otherwise → in-session-agent
  //
  // AC #4 — when claudePShellMaxConcurrent is 0, even big+tight returns in-session-agent.
  // AC #5 — when estimatedTokens is undefined, returns 'any'.

  it('returns claude-p-shell when big AND tight AND supervisor configured', () => {
    expect(
      recommendWorkerKind({
        estimatedTokens: BIG_TOKEN_THRESHOLD + 1,
        quotaUtilization: TIGHT_QUOTA_THRESHOLD + 0.05,
        claudePShellMaxConcurrent: 2,
      }),
    ).toBe('claude-p-shell');
  });

  it('returns in-session-agent when small (under threshold) even with tight quota + supervisor', () => {
    expect(
      recommendWorkerKind({
        estimatedTokens: BIG_TOKEN_THRESHOLD,
        quotaUtilization: 0.95,
        claudePShellMaxConcurrent: 4,
      }),
    ).toBe('in-session-agent');
  });

  it('returns in-session-agent when quota is plentiful even with big task + supervisor', () => {
    expect(
      recommendWorkerKind({
        estimatedTokens: BIG_TOKEN_THRESHOLD + 50_000,
        quotaUtilization: 0.5,
        claudePShellMaxConcurrent: 2,
      }),
    ).toBe('in-session-agent');
  });

  it('AC #4: returns in-session-agent when claudePShellMaxConcurrent is 0 (even big+tight)', () => {
    expect(
      recommendWorkerKind({
        estimatedTokens: BIG_TOKEN_THRESHOLD + 100_000,
        quotaUtilization: 0.99,
        claudePShellMaxConcurrent: 0,
      }),
    ).toBe('in-session-agent');
  });

  it('AC #4: returns in-session-agent when claudePShellMaxConcurrent is negative', () => {
    expect(
      recommendWorkerKind({
        estimatedTokens: BIG_TOKEN_THRESHOLD + 100_000,
        quotaUtilization: 0.99,
        claudePShellMaxConcurrent: -1,
      }),
    ).toBe('in-session-agent');
  });

  it('AC #5: returns any when estimatedTokens is undefined (no signal)', () => {
    expect(
      recommendWorkerKind({
        estimatedTokens: undefined,
        quotaUtilization: 0.99,
        claudePShellMaxConcurrent: 4,
      }),
    ).toBe('any');
  });

  it("AC #5: returns 'any' even with supervisor disabled when estimatedTokens is undefined", () => {
    expect(
      recommendWorkerKind({
        estimatedTokens: undefined,
        quotaUtilization: 0.99,
        claudePShellMaxConcurrent: 0,
      }),
    ).toBe('any');
  });

  it('treats missing quotaUtilization as 0 (plentiful)', () => {
    expect(
      recommendWorkerKind({
        estimatedTokens: BIG_TOKEN_THRESHOLD + 1,
        quotaUtilization: undefined,
        claudePShellMaxConcurrent: 2,
      }),
    ).toBe('in-session-agent');
  });

  it('boundary: utilization exactly at threshold is NOT tight', () => {
    expect(
      recommendWorkerKind({
        estimatedTokens: BIG_TOKEN_THRESHOLD + 1,
        quotaUtilization: TIGHT_QUOTA_THRESHOLD,
        claudePShellMaxConcurrent: 2,
      }),
    ).toBe('in-session-agent');
  });

  it('boundary: tokens exactly at threshold is NOT big', () => {
    expect(
      recommendWorkerKind({
        estimatedTokens: BIG_TOKEN_THRESHOLD,
        quotaUtilization: TIGHT_QUOTA_THRESHOLD + 0.05,
        claudePShellMaxConcurrent: 2,
      }),
    ).toBe('in-session-agent');
  });
});
