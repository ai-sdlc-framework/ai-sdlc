/**
 * Regression test for AISDLC-156 — guard the bin invocation pattern used by
 * `.github/workflows/ai-sdlc-review.yml` and `.github/workflows/dor-ingress.yml`.
 *
 * History: pre-AISDLC-156 the workflow invoked the 3 cost-optimization CLIs
 * (`cli-classify-pr`, `cli-incremental-decide`, `cli-classify-budget`) via
 * `pnpm --filter @ai-sdlc/pipeline-cli exec cli-XXX`. That form silently
 * failed (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`: `Command "cli-XXX" not
 * found`) on EVERY CI run because `pnpm exec` does NOT resolve a workspace
 * package's OWN bin entries — only its DEPENDENCIES' bins are symlinked
 * into `node_modules/.bin/`. The `|| echo <fallback-json>` safety net then
 * fired unconditionally, defeating the AISDLC-141/142/147/149/154 cost
 * optimizations entirely (every PR ran full-budget reviewers, blowing
 * through Anthropic credits, posting CHANGES_REQUESTED on credit
 * exhaustion).
 *
 * AISDLC-181 extension: the AISDLC-156 sweep covered the per-CLI cost-saver
 * bins but missed the umbrella `ai-sdlc-pipeline` binary, which `dor-ingress.yml`
 * was still invoking via `pnpm --filter ... --silent exec ai-sdlc-pipeline`
 * at four call sites. The `--silent` flag swallowed the `Command not found`
 * banner so the failure surfaced only as `exit 1` with empty stderr — the
 * worst possible failure mode for debuggability. This test now also covers
 * the umbrella bin.
 *
 * The fix: invoke the bin shim DIRECTLY via `node ./pipeline-cli/bin/<bin>.mjs`.
 * This test guards two properties:
 *   1. Each bin shim under `pipeline-cli/bin/*.mjs` (per-CLI + umbrella)
 *      exists, is executable as a node entrypoint, and exits 0 on `--help`.
 *      This proves the shim file is present, the compiled `dist/cli/...js`
 *      target it imports is present, and the yargs router accepts `--help`.
 *      A regression that breaks any of these (e.g. someone deletes the
 *      bin file, renames the dist target, or removes the `--help` alias)
 *      fails this test immediately.
 *   2. (Removed by AISDLC-814: a probe asserting `pnpm exec <bin>` still fails
 *      depended on node_modules link state, not repository code. The
 *      workflow scan below is the single enforcement of the rule.)
 *   3. No workflow file under `.github/workflows/` invokes any of the
 *      guarded bins via `pnpm ... exec <bin>` — the workflow files MUST
 *      use the direct `node pipeline-cli/bin/<bin>.mjs` form. This is
 *      the AISDLC-181 framework-coverage-gap fix: the original AISDLC-156
 *      test only proved the bins themselves work, not that the workflows
 *      use the right invocation form. A static scan closes that gap.
 *
 * Both properties exercise the REAL filesystem (no mocks) because the
 * bug we're guarding against is a real-filesystem-resolution bug —
 * mocking `child_process` would defeat the purpose.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the package root from the test file location:
//   <pkg-root>/src/cli/bin-invocation.test.ts → <pkg-root>/
const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(__filename, '..', '..', '..');
const WORKSPACE_ROOT = resolve(PKG_ROOT, '..');
const WORKFLOWS_DIR = resolve(WORKSPACE_ROOT, '.github', 'workflows');

// The 3 per-CLI bins the AISDLC-156 fix targets — these are the cost-saver
// CLIs the review workflow invokes. Adding a new CI-invoked bin? Append
// it here so the regression guard covers it too.
const CI_INVOKED_BINS = [
  'cli-classify-pr',
  'cli-incremental-decide',
  'cli-classify-budget',
] as const;

// AISDLC-181: the umbrella bin invoked by `dor-ingress.yml`. Same failure
// mode as the per-CLI bins under `pnpm exec`, but the workflow used
// `--silent` which suppressed the `Command not found` diagnostic, making
// the failure mode invisible. Track separately from CI_INVOKED_BINS
// because the dist target path differs (`dist/cli/index.js` vs
// `dist/cli/<bin>.js`).
const UMBRELLA_BIN = 'ai-sdlc-pipeline';

// Union of all bins guarded by the static workflow scan + the pnpm-exec
// defense-in-depth probe. Per-CLI bins are checked individually above;
// this list is what we scan workflow YAML for and probe via pnpm.
const ALL_GUARDED_BINS = [...CI_INVOKED_BINS, UMBRELLA_BIN] as const;

// AISDLC-203: atomic task-completion helpers. Not CI-invoked (operators run
// them locally or in workflow steps that use the correct direct-node pattern),
// but we still assert their shims + dist targets exist so a rename/deletion
// doesn't silently strand the atomic-completion contract.
const AISDLC_203_BINS = ['cli-task-complete', 'cli-backlog-verify', 'cli-hierarchy'] as const;

// Match `pnpm ... exec <bin>` where `...` may include flags like
// `--filter @ai-sdlc/pipeline-cli` and `--silent`. The bin must be a
// separate token to avoid matching a substring (e.g. `cli-classify-pr-foo`).
const buildBannedPattern = (binName: string): RegExp => {
  const escaped = binName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`pnpm\\b[^\\n]*\\bexec\\b[^\\n]*\\b${escaped}\\b`);
};

// Scan workflow text for banned invocations of a guarded bin, skipping
// YAML comment lines. Returns `<label>:<line>: <text>` offenders.
const findBannedInvocations = (binName: string, label: string, lines: string[]): string[] => {
  const bannedRe = buildBannedPattern(binName);
  const offenders: string[] = [];
  lines.forEach((line, idx) => {
    if (/^\s*#/.test(line)) return;
    if (bannedRe.test(line)) offenders.push(`${label}:${idx + 1}: ${line.trim()}`);
  });
  return offenders;
};

describe('AISDLC-156 + AISDLC-181: bin invocation pattern (CI cost-saver + umbrella bin guard)', () => {
  // The bins import from `dist/cli/*.js` so the dist must exist before we
  // can exercise them. `pnpm test` runs after `pnpm build` in the standard
  // workflow, but local `pnpm --filter ... test` invocations may skip the
  // build. Trigger a build here if dist is missing — single-shot, idempotent.
  // We check two markers (per-CLI dist + umbrella router dist) so a partial
  // build doesn't slip through.
  beforeAll(() => {
    const distMarkers = [
      join(PKG_ROOT, 'dist', 'cli', 'classify-budget.js'),
      join(PKG_ROOT, 'dist', 'cli', 'index.js'),
    ];
    if (distMarkers.some((m) => !existsSync(m))) {
      const build = spawnSync('pnpm', ['build'], {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (build.status !== 0) {
        throw new Error(
          `pre-test build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`,
        );
      }
    }
  }, 60_000);

  describe.each(CI_INVOKED_BINS)('%s (per-CLI bin)', (binName) => {
    const binPath = join(PKG_ROOT, 'bin', `${binName}.mjs`);

    it('bin shim file exists at the expected path', () => {
      expect(existsSync(binPath), `missing bin shim: ${binPath}`).toBe(true);
    });

    it('is invokable via `node <pkg-root>/bin/<bin>.mjs --help` and exits 0', () => {
      const result = spawnSync(process.execPath, [binPath, '--help'], {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
        // 10s ceiling — `--help` should return in <500ms; anything longer
        // means the bin is hanging on stdin (regression in yargs config).
        timeout: 10_000,
      });
      const detail = `\n--- exit ${result.status} ---\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
      expect(result.status, `node ${binName}.mjs --help did not exit 0:${detail}`).toBe(0);
      // `--help` always renders the usage banner — sanity check the output
      // looks like a yargs help block (starts with "Usage:" or contains
      // "Options:" or includes the bin name in a Commands list).
      const out = result.stdout + result.stderr;
      const looksLikeHelp =
        /^Usage:/m.test(out) || /Options:/.test(out) || new RegExp(binName).test(out);
      expect(looksLikeHelp, `--help output didn't look like a yargs banner:${detail}`).toBe(true);
    });
  });

  // AISDLC-181: same shape as the per-CLI block above but for the umbrella
  // bin invoked by `dor-ingress.yml`. Kept as its own describe so the
  // regression source is obvious from the failure label.
  describe(`${UMBRELLA_BIN} (umbrella bin, AISDLC-181)`, () => {
    const binPath = join(PKG_ROOT, 'bin', `${UMBRELLA_BIN}.mjs`);

    it('bin shim file exists at the expected path', () => {
      expect(existsSync(binPath), `missing bin shim: ${binPath}`).toBe(true);
    });

    it('is invokable via `node <pkg-root>/bin/ai-sdlc-pipeline.mjs --help` and exits 0', () => {
      const result = spawnSync(process.execPath, [binPath, '--help'], {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10_000,
      });
      const detail = `\n--- exit ${result.status} ---\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
      expect(result.status, `node ${UMBRELLA_BIN}.mjs --help did not exit 0:${detail}`).toBe(0);
      const out = result.stdout + result.stderr;
      const looksLikeHelp =
        /^Usage:/m.test(out) || /Options:/.test(out) || new RegExp(UMBRELLA_BIN).test(out);
      expect(looksLikeHelp, `--help output didn't look like a yargs banner:${detail}`).toBe(true);
    });
  });

  // AISDLC-181: static scan of every `.github/workflows/*.yml` file. Asserts
  // that none of the guarded bins are invoked via the banned `pnpm exec`
  // pattern, and that the only invocation form present is `node
  // pipeline-cli/bin/<bin>.mjs`. This is the framework-coverage-gap fix:
  // the original AISDLC-156 test proved the bins themselves work but did
  // NOT prove the workflows use them correctly — so dor-ingress.yml's four
  // banned invocations slipped through silently for months. A static scan
  // is cheap and catches any future regression at PR-test time, before
  // the workflow even runs.
  describe('workflow files invoke guarded bins via direct-node form (AISDLC-181)', () => {
    // Match `pnpm ... exec <bin>` where `...` may include flags like
    // `--filter @ai-sdlc/pipeline-cli` and `--silent`. We anchor on
    // `pnpm` and `exec` with the bin name as the command argument so we
    // don't false-positive on `pnpm --filter ... build` or `pnpm install`.
    // The bin must be a separate token to avoid matching a substring
    // (e.g. `cli-classify-pr-foo`).
    // Read each workflow file once; share across the per-bin assertions.
    const workflowFiles: { path: string; lines: string[] }[] = (() => {
      if (!existsSync(WORKFLOWS_DIR)) {
        // Defensive: if the test runs in a context where the workspace
        // root layout is unexpected (e.g. a CI box that checks out only
        // the package), skip rather than false-fail.
        return [];
      }
      return readdirSync(WORKFLOWS_DIR)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((f) => {
          const path = join(WORKFLOWS_DIR, f);
          return { path, lines: readFileSync(path, 'utf-8').split('\n') };
        });
    })();

    it('discovers at least one workflow file (sanity)', () => {
      expect(
        workflowFiles.length,
        `no workflow files found under ${WORKFLOWS_DIR} — test setup is wrong`,
      ).toBeGreaterThan(0);
    });

    it.each(ALL_GUARDED_BINS)('fixture: scan detects `pnpm --filter exec %s`', (binName) => {
      const fixture = [
        '# pnpm --filter @ai-sdlc/pipeline-cli exec ' + binName + ' (comment, ignored)',
        'steps:',
        '  - run: pnpm --filter @ai-sdlc/pipeline-cli exec ' + binName + ' --help',
        '  - run: node pipeline-cli/bin/' + binName + '.mjs --help',
      ];
      expect(findBannedInvocations(binName, 'fixture.yml', fixture)).toEqual([
        `fixture.yml:3: - run: pnpm --filter @ai-sdlc/pipeline-cli exec ${binName} --help`,
      ]);
    });

    describe.each(ALL_GUARDED_BINS)('%s', (binName) => {
      it('is NEVER invoked via `pnpm ... exec` in any workflow', () => {
        const offenders = workflowFiles.flatMap(({ path, lines }) =>
          findBannedInvocations(binName, path, lines),
        );
        expect(
          offenders,
          `workflow files invoke ${binName} via banned pnpm-exec pattern (AISDLC-156/181):\n${offenders.join('\n')}`,
        ).toEqual([]);
      });
    });
  });
});

describe('AISDLC-203: atomic-completion bin shim existence guard', () => {
  // The AISDLC-203 bins (cli-task-complete, cli-backlog-verify) are NOT
  // CI-invoked (no workflow YAML references them yet), so we do NOT add
  // them to ALL_GUARDED_BINS (which drives the static workflow scan and the
  // pnpm-exec defense-in-depth probe). Instead we assert a simpler property:
  // the shim file exists at the expected path AND is invokable via
  // `node <shim> --help` (proving the dist target compiled correctly and
  // the yargs router is wired up).
  beforeAll(() => {
    const distMarkers = [
      join(PKG_ROOT, 'dist', 'cli', 'complete-task.js'),
      join(PKG_ROOT, 'dist', 'cli', 'backlog-verify.js'),
    ];
    if (distMarkers.some((m) => !existsSync(m))) {
      const build = spawnSync('pnpm', ['build'], {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (build.status !== 0) {
        throw new Error(
          `pre-test build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`,
        );
      }
    }
  }, 60_000);

  describe.each(AISDLC_203_BINS)('%s', (binName) => {
    const binPath = join(PKG_ROOT, 'bin', `${binName}.mjs`);

    it('bin shim file exists at the expected path', () => {
      expect(existsSync(binPath), `missing bin shim: ${binPath}`).toBe(true);
    });

    it('is invokable via `node <pkg-root>/bin/<bin>.mjs --help` and exits 0', () => {
      const result = spawnSync(process.execPath, [binPath, '--help'], {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10_000,
        // Pass the full parent env so the subprocess can resolve node_modules
        // on CI runners (Linux Node 20) where the pnpm-managed PATH must be
        // inherited for ESM module resolution. Without this, the subprocess
        // can receive a null exit status (signal kill) on some Linux CI envs.
        env: process.env,
      });
      const detail =
        `\n--- exit ${result.status} signal ${result.signal ?? 'none'} ---` +
        `\n--- spawn error ---\n${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.error?.message ?? 'none'}` +
        `\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
      expect(result.status, `node ${binName}.mjs --help did not exit 0:${detail}`).toBe(0);
      const out = result.stdout + result.stderr;
      const looksLikeHelp =
        /^Usage:/m.test(out) || /Options:/.test(out) || new RegExp(binName).test(out);
      expect(looksLikeHelp, `--help output didn't look like a yargs banner:${detail}`).toBe(true);
    });
  });
});

describe('cli-judgment: bin shim guard', () => {
  const binPath = join(PKG_ROOT, 'bin', 'cli-judgment.mjs');

  beforeAll(() => {
    if (!existsSync(join(PKG_ROOT, 'dist', 'cli', 'judgment.js'))) {
      const build = spawnSync('pnpm', ['build'], {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (build.status !== 0) {
        throw new Error(
          `pre-test build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`,
        );
      }
    }
  }, 60_000);

  it('bin shim file exists at the expected path', () => {
    expect(existsSync(binPath), `missing bin shim: ${binPath}`).toBe(true);
  });

  it('`--help` exits 0 and lists doctor, list, ask, eval and replay', () => {
    const result = spawnSync(process.execPath, [binPath, '--help'], {
      cwd: PKG_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
      env: process.env,
    });
    const out = result.stdout + result.stderr;
    const detail = `\n--- exit ${result.status} ---\n${out}`;
    expect(result.status, `cli-judgment --help did not exit 0:${detail}`).toBe(0);
    for (const command of ['doctor', 'list', 'ask', 'eval', 'replay']) {
      expect(out, `--help does not list '${command}':${detail}`).toContain(command);
    }
  });

  it('exits non-zero for an unreadable corpus', () => {
    const result = spawnSync(
      process.execPath,
      [binPath, 'eval', 'no.such.judgment', '--corpus', join(tmpdir(), 'no-such-corpus.jsonl')],
      { cwd: PKG_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000, env: process.env },
    );
    expect(result.status).toBe(1);
  });
});

describe('cli-usage: bin shim guard and end-to-end ingest', () => {
  const binPath = join(PKG_ROOT, 'bin', 'cli-usage.mjs');
  let tmp: string;

  beforeAll(() => {
    if (!existsSync(join(PKG_ROOT, 'dist', 'cli', 'usage.js'))) {
      const build = spawnSync('pnpm', ['build'], {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (build.status !== 0) {
        throw new Error(
          `pre-test build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`,
        );
      }
    }
  }, 60_000);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'bin-invocation-usage-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('bin shim file exists at the expected path', () => {
    expect(existsSync(binPath), `missing bin shim: ${binPath}`).toBe(true);
  });

  it('is invokable via `node <pkg-root>/bin/cli-usage.mjs --help` and exits 0', () => {
    const result = spawnSync(process.execPath, [binPath, '--help'], {
      cwd: PKG_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
      env: process.env,
    });
    const detail = `\n--- exit ${result.status} ---\n${result.stdout}\n${result.stderr}`;
    expect(result.status, `cli-usage --help did not exit 0:${detail}`).toBe(0);
    expect(/Usage:/.test(result.stdout + result.stderr), detail).toBe(true);
  });

  it('`ingest --json` reports scanned, written, skipped and error counts', () => {
    const projects = join(tmp, 'projects', 'p1');
    mkdirSync(projects, { recursive: true });
    const call = (id: string): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-02T10:00:00Z',
        sessionId: 's1',
        cwd: join(tmp, 'elsewhere'),
        message: { id, model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 } },
      });
    writeFileSync(
      join(projects, 's1.jsonl'),
      `${call('m1')}\n${call('m1')}\n{broken SENTINEL-CANARY-BIN\n`,
    );
    const env: NodeJS.ProcessEnv = { ...process.env, AI_SDLC_USAGE_DIR: join(tmp, 'usage') };
    delete env['CLAUDE_CODE_ENV'];
    delete env['CLAUDE_REMOTE_EXECUTION'];
    delete env['AI_SDLC_USAGE_INGEST'];
    const result = spawnSync(
      process.execPath,
      [binPath, 'ingest', '--json', '--projects-dir', join(tmp, 'projects')],
      { cwd: PKG_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 20_000, env },
    );
    const detail = `\n--- exit ${result.status} ---\n${result.stdout}\n${result.stderr}`;
    expect(result.status, detail).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('SENTINEL');
    expect(JSON.parse(result.stdout), detail).toMatchObject({
      filesScanned: 1,
      callsWritten: 1,
      repeatsSkipped: 1,
      errors: 1,
    });
  });
  it('two concurrent ingests never duplicate limit events', async () => {
    const projects = join(tmp, 'projects', 'p1');
    mkdirSync(projects, { recursive: true });
    for (let i = 0; i < 60; i++) {
      writeFileSync(
        join(projects, `s${i}.jsonl`),
        `${JSON.stringify({
          type: 'assistant',
          timestamp: `2026-09-02T10:00:${String(i % 60).padStart(2, '0')}Z`,
          sessionId: `s${i}`,
          cwd: join(tmp, 'elsewhere'),
          message: { id: `syn-${i}`, model: '<synthetic>', content: 'Claude usage limit reached' },
        })}\n`,
      );
    }
    // Hermetic: point the Codex ingester at an empty dir so the operator's
    // real ~/.codex sessions never leak into the count (AISDLC-814).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AI_SDLC_USAGE_DIR: join(tmp, 'usage'),
      CODEX_HOME: join(tmp, 'codex-home'),
    };
    delete env['CLAUDE_CODE_ENV'];
    delete env['CLAUDE_REMOTE_EXECUTION'];
    delete env['AI_SDLC_USAGE_INGEST'];
    const run = (): Promise<number | null> =>
      new Promise((resolveRun) => {
        const child = spawn(
          process.execPath,
          [binPath, 'ingest', '--backfill', '--json', '--projects-dir', join(tmp, 'projects')],
          { env, stdio: 'ignore' },
        );
        child.on('close', (code) => resolveRun(code));
      });
    const codes = await Promise.all([run(), run(), run()]);
    expect(codes).toEqual([0, 0, 0]);
    const lines = readFileSync(join(tmp, 'usage', 'limit-events.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(60);
    expect(new Set(lines).size).toBe(60);
  }, 60_000);
});

// ── AISDLC-209: end-to-end bin shim integration tests (AC#6) ─────────
//
// Previous guard (AISDLC-203) only asserted `--help` exits 0.  These tests
// exercise a real invocation with a real task file in a temp-dir fixture to
// prove the full read-patch-rename pipeline works end-to-end through the
// compiled shim.

describe('AISDLC-209: cli-task-complete end-to-end integration (AC#6)', () => {
  const binPath = join(PKG_ROOT, 'bin', 'cli-task-complete.mjs');
  // Use a numeric task ID so it passes TASK_ID_RE (/^[a-z]+-[0-9]+.../i).
  const E2E_TASK_ID = 'AISDLC-209';
  const TASK_FM =
    '---\nid: AISDLC-209\ntitle: integration test task\nstatus: In Progress\n---\n\n## Body\n\nTest.\n';
  const TASK_FILENAME = 'aisdlc-209 - integration-test-task.md';

  let tmpWorkDir: string;

  beforeEach(() => {
    tmpWorkDir = mkdtempSync(join(tmpdir(), 'bin-invocation-e2e-'));
    mkdirSync(join(tmpWorkDir, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(tmpWorkDir, 'backlog', 'completed'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpWorkDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('moves a real task file from tasks/ to completed/ (text output, exit 0)', () => {
    writeFileSync(join(tmpWorkDir, 'backlog', 'tasks', TASK_FILENAME), TASK_FM, 'utf8');

    const result = spawnSync(process.execPath, [binPath, E2E_TASK_ID, '--work-dir', tmpWorkDir], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });
    const detail = `\n--- exit ${result.status} ---\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
    expect(result.status, `cli-task-complete did not exit 0:${detail}`).toBe(0);
    expect(result.stdout).toContain(`${E2E_TASK_ID}: moved`);
    expect(result.stdout).toContain('verified: OK');
    expect(
      existsSync(join(tmpWorkDir, 'backlog', 'completed', TASK_FILENAME)),
      `completed file missing:${detail}`,
    ).toBe(true);
    expect(
      existsSync(join(tmpWorkDir, 'backlog', 'tasks', TASK_FILENAME)),
      `tasks file still present after move:${detail}`,
    ).toBe(false);
  });

  it('patches status to Done in the moved file', () => {
    writeFileSync(join(tmpWorkDir, 'backlog', 'tasks', TASK_FILENAME), TASK_FM, 'utf8');

    spawnSync(process.execPath, [binPath, E2E_TASK_ID, '--work-dir', tmpWorkDir], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });

    const content = readFileSync(join(tmpWorkDir, 'backlog', 'completed', TASK_FILENAME), 'utf8');
    expect(content).toContain('status: Done');
    expect(content).not.toContain('status: In Progress');
  });

  it('exits with JSON output when --format json is passed', () => {
    writeFileSync(join(tmpWorkDir, 'backlog', 'tasks', TASK_FILENAME), TASK_FM, 'utf8');

    const result = spawnSync(
      process.execPath,
      [binPath, E2E_TASK_ID, '--work-dir', tmpWorkDir, '--format', 'json'],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      alreadyDone: boolean;
      taskId: string;
      verified: boolean;
    };
    expect(json.ok).toBe(true);
    expect(json.alreadyDone).toBe(false);
    expect(json.taskId).toBe(E2E_TASK_ID);
    expect(json.verified).toBe(true);
  });

  it('rejects a malformed task ID with exit 1 (AC#3 end-to-end)', () => {
    const result = spawnSync(process.execPath, [binPath, 'not!!valid', '--work-dir', tmpWorkDir], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid task ID');
  });

  it('exits 2 when task already in completed/ (idempotent)', () => {
    writeFileSync(join(tmpWorkDir, 'backlog', 'completed', TASK_FILENAME), TASK_FM, 'utf8');

    const result = spawnSync(process.execPath, [binPath, E2E_TASK_ID, '--work-dir', tmpWorkDir], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });
    expect(result.status).toBe(2);
  });
});

describe('AISDLC-209: cli-backlog-verify end-to-end integration (AC#6)', () => {
  const binPath = join(PKG_ROOT, 'bin', 'cli-backlog-verify.mjs');
  // Use numeric IDs so extractTaskIdFromFilename can parse them.
  const TASK_FILENAME = 'aisdlc-209 - e2e-verify-task.md';
  const TASK_CONTENT = '---\nid: AISDLC-209\nstatus: In Progress\n---\n\nBody.\n';

  let tmpWorkDir: string;

  beforeEach(() => {
    tmpWorkDir = mkdtempSync(join(tmpdir(), 'bin-invocation-verify-e2e-'));
    mkdirSync(join(tmpWorkDir, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(tmpWorkDir, 'backlog', 'completed'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpWorkDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('exits 0 when no duplicates (only in tasks/)', () => {
    writeFileSync(join(tmpWorkDir, 'backlog', 'tasks', TASK_FILENAME), TASK_CONTENT, 'utf8');

    const result = spawnSync(process.execPath, [binPath, '--work-dir', tmpWorkDir], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });
    const detail = `\n--- exit ${result.status} ---\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
    expect(result.status, `cli-backlog-verify should exit 0 when no duplicates:${detail}`).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('exits 1 and reports to stderr when duplicate task ID detected', () => {
    writeFileSync(join(tmpWorkDir, 'backlog', 'tasks', TASK_FILENAME), TASK_CONTENT, 'utf8');
    writeFileSync(join(tmpWorkDir, 'backlog', 'completed', TASK_FILENAME), TASK_CONTENT, 'utf8');

    const result = spawnSync(process.execPath, [binPath, '--work-dir', tmpWorkDir], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });
    const detail = `\n--- exit ${result.status} ---\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
    expect(result.status, `cli-backlog-verify should exit 1 on duplicate:${detail}`).toBe(1);
    expect(result.stderr).toContain('DUPLICATE');
    expect(result.stderr).toContain('aisdlc-209');
  });

  it('exits 0 with JSON output when no duplicates (--format json)', () => {
    writeFileSync(join(tmpWorkDir, 'backlog', 'tasks', TASK_FILENAME), TASK_CONTENT, 'utf8');

    const result = spawnSync(
      process.execPath,
      [binPath, '--work-dir', tmpWorkDir, '--format', 'json'],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      duplicates: string[];
      locations: unknown[];
    };
    expect(json.ok).toBe(true);
    expect(json.duplicates).toHaveLength(0);
    expect(json.locations.length).toBeGreaterThan(0);
  });
});

// ── AISDLC-369: cli-verify-attestation-debug bin shim guard ─────────────────
//
// Standalone .mjs bin (no TypeScript dist — imports orchestrator dist at
// runtime). Guard: shim exists + --help exits 0 without requiring the
// orchestrator to be built (arg parsing happens before the dynamic import).

describe('AISDLC-369: cli-verify-attestation-debug bin shim guard', () => {
  const binPath = join(PKG_ROOT, 'bin', 'cli-verify-attestation-debug.mjs');

  it('bin shim file exists at the expected path', () => {
    expect(existsSync(binPath), `missing bin shim: ${binPath}`).toBe(true);
  });

  it('exits 0 on --help without requiring orchestrator dist', () => {
    const result = spawnSync(process.execPath, [binPath, '--help'], {
      cwd: PKG_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });
    const detail = `\n--- exit ${result.status} ---\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
    expect(result.status, `--help did not exit 0:${detail}`).toBe(0);
    const out = result.stdout + result.stderr;
    expect(
      /Usage:/i.test(out) || /Options:/i.test(out) || /cli-verify-attestation-debug/.test(out),
      `--help output didn't look like a help banner:${detail}`,
    ).toBe(true);
  });

  it('exits non-zero when --head-sha and --base-sha are missing', () => {
    const result = spawnSync(process.execPath, [binPath], {
      cwd: PKG_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });
    // Without orchestrator built the dynamic import fails, but the arg
    // validation (which runs BEFORE the import) should surface a clear error.
    expect(result.status, 'expected non-zero exit when SHAs missing').not.toBe(0);
    const out = result.stdout + result.stderr;
    expect(
      /head-sha/.test(out) || /base-sha/.test(out) || /required/.test(out),
      `expected SHA-missing error in output: ${out}`,
    ).toBe(true);
  });
});

// Coverage hint for callers reading this in isolation: the production
// invocation patterns live in:
//   - `.github/workflows/ai-sdlc-review.yml` — per-CLI cost-saver bins
//     (1× cli-classify-pr, 2× cli-incremental-decide, 1× cli-classify-budget).
//   - `.github/workflows/dor-ingress.yml` — umbrella `ai-sdlc-pipeline`
//     bin (4 call sites: dor-evaluate ×2, dor-render-comment, dor-render-pr-summary).
//   - AISDLC-203: cli-task-complete + cli-backlog-verify invoked by operators
//     locally and in future workflow steps (using the direct-node form).
//   - AISDLC-209: cli-task-complete + cli-backlog-verify end-to-end integration
//     tests added to guard the full read-patch-rename pipeline through the shim.
//   - AISDLC-369: cli-verify-attestation-debug — standalone .mjs debug tool.
// Search for `node pipeline-cli/bin/` to enumerate them.

describe('RFC-0050: cli-usage bin shim', () => {
  beforeAll(() => {
    if (!existsSync(join(PKG_ROOT, 'dist', 'cli', 'usage.js'))) {
      const build = spawnSync('pnpm', ['build'], {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (build.status !== 0) {
        throw new Error(
          `pre-test build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`,
        );
      }
    }
  }, 60_000);

  const binPath = join(PKG_ROOT, 'bin', 'cli-usage.mjs');

  it('bin shim file exists at the expected path', () => {
    expect(existsSync(binPath), `missing bin shim: ${binPath}`).toBe(true);
  });

  it('is invokable via `node <pkg-root>/bin/cli-usage.mjs prices --help` and exits 0', () => {
    const result = spawnSync(process.execPath, [binPath, 'prices', '--help'], {
      cwd: PKG_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
      env: process.env,
    });
    const detail = `\n--- exit ${result.status} ---\n${result.stdout}\n${result.stderr}`;
    expect(result.status, `cli-usage prices --help did not exit 0:${detail}`).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/refresh/);
  });
});
