/**
 * AISDLC-1293: extra sandbox suites (python, go) selected by the paths a PR changes.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  DEFAULT_SANDBOX_CONFIG,
  DEFAULT_SANDBOX_IMAGE,
  DIFFERENTIAL_RESULT_SENTINEL,
  DockerSandboxDriver,
  MockSandboxDriver,
  buildDifferentialTestScript,
  buildSuiteFetchScript,
  changedPathsFromDiff,
  loadSandboxConfig,
  parseSandboxSuites,
  runSandbox,
  selectSuites,
  type SandboxConfig,
  type SandboxSpawnInput,
  type SandboxSuite,
} from './sandbox-runner.js';

const DIGEST = '@sha256:' + 'a'.repeat(64);
const PY: SandboxSuite = {
  name: 'python',
  paths: ['sdk-python/**'],
  image: `python:3.13-bookworm${DIGEST}`,
  fetchCommand: 'pip install x',
  testCommand: "cd sdk-python && python -m pytest -k 'a b'",
};
const GO: SandboxSuite = {
  name: 'go',
  paths: ['sdk-go/**'],
  image: `golang:1.26-bookworm${DIGEST}`,
  fetchCommand: 'go mod download',
  testCommand: 'go test ./...',
};
const CONFIG: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxSuites: [PY, GO] };

const diffOf = (...paths: string[]) =>
  paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n+x\n`).join('');

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean {
    return true;
  }
}

interface Call {
  args: string[];
  env: Record<string, string | undefined>;
}

/** Real driver, fake docker. `failImages` lists images whose run container fails the head suite. */
class FakeDockerDriver extends DockerSandboxDriver {
  readonly calls: Call[] = [];
  constructor(private readonly failImages: string[] = []) {
    super();
  }
  protected _spawnProcess(_cmd: string, args: string[], options: SpawnOptions): ChildProcess {
    const proc = new FakeProc();
    if (args[0] === 'run') {
      this.calls.push({ args, env: (options.env ?? {}) as Record<string, string | undefined> });
    }
    setImmediate(() => {
      if (args[0] === 'run' && args.includes('--network=none')) {
        const head = !this.failImages.some((i) => args.includes(i));
        proc.stdout.emit(
          'data',
          Buffer.from(
            `${DIFFERENTIAL_RESULT_SENTINEL}\n` +
              JSON.stringify({
                upstreamPassed: true,
                upstreamOutput: 'base ok',
                headPassed: head,
                headOutput: head ? 'head ok' : 'head boom',
                coveragePct: 80,
              }) +
              '\n',
          ),
        );
      }
      proc.emit('close', 0);
    });
    return proc as unknown as ChildProcess;
  }
  get runs(): Call[] {
    return this.calls.filter((c) => c.args.includes('--network=none'));
  }
  get fetches(): Call[] {
    return this.calls.filter((c) => !c.args.includes('--network=none'));
  }
}

async function run(config: SandboxConfig, diff: string, driver: FakeDockerDriver) {
  const prev = process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'];
  process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] = '1';
  try {
    return await runSandbox({
      prNumber: 7,
      prDiff: diff,
      upstreamMainRef: 'a'.repeat(40),
      config,
      driverOverride: driver,
      baseTreeDir: mkdtempSync(join(tmpdir(), 'suites-base-')),
    });
  } finally {
    if (prev === undefined) delete process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'];
    else process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] = prev;
  }
}

const imagesOf = (calls: Call[]) =>
  calls.map((c) => c.args.find((a) => /@sha256:/.test(a)) ?? DEFAULT_SANDBOX_IMAGE);

describe('sandboxSuites (AISDLC-1293)', () => {
  it('AC1: without sandboxSuites the Node run is unchanged', async () => {
    const seen: SandboxSpawnInput[] = [];
    class Spy extends MockSandboxDriver {
      protected async doSpawn(input: SandboxSpawnInput) {
        seen.push(input);
        return super.doSpawn(input);
      }
    }
    await runSandbox({
      prNumber: 1,
      prDiff: diffOf('sdk-python/a.py'),
      upstreamMainRef: 'a'.repeat(40),
      config: DEFAULT_SANDBOX_CONFIG,
      driverOverride: new Spy(),
    });
    expect(seen).toHaveLength(1);
    expect('suite' in seen[0]!).toBe(false);

    const driver = new FakeDockerDriver();
    await run(DEFAULT_SANDBOX_CONFIG, diffOf('sdk-python/a.py'), driver);
    expect(driver.fetches).toHaveLength(1);
    expect(driver.runs).toHaveLength(1);
    expect(driver.runs[0]!.args).toContain(DEFAULT_SANDBOX_IMAGE);
    const script = driver.runs[0]!.args.at(-1)!;
    expect(script).toBe(buildDifferentialTestScript('a'.repeat(40), undefined));
    expect(script).toContain("sh -c 'pnpm test --coverage 2>&1 || npm test --coverage 2>&1'");
    expect(driver.fetches[0]!.args.join(' ')).toContain('corepack');
  });

  it('AC2: sdk-python only starts the python suite alone', async () => {
    const driver = new FakeDockerDriver();
    const r = await run(CONFIG, diffOf('sdk-python/src/a.py'), driver);
    expect(r.outcome).toBe('success');
    expect(imagesOf(driver.fetches)).toEqual([PY.image]);
    expect(imagesOf(driver.runs)).toEqual([PY.image]);
  });

  it('AC2: orchestrator only starts Node alone', async () => {
    const driver = new FakeDockerDriver();
    await run(CONFIG, diffOf('orchestrator/a.ts'), driver);
    expect(imagesOf(driver.fetches)).toEqual([DEFAULT_SANDBOX_IMAGE]);
    expect(imagesOf(driver.runs)).toEqual([DEFAULT_SANDBOX_IMAGE]);
  });

  it('AC2: orchestrator plus sdk-go starts Node and go', async () => {
    const driver = new FakeDockerDriver();
    const r = await run(CONFIG, diffOf('orchestrator/a.ts', 'sdk-go/a.go'), driver);
    expect(imagesOf(driver.fetches)).toEqual([DEFAULT_SANDBOX_IMAGE, GO.image]);
    expect(imagesOf(driver.runs)).toEqual([DEFAULT_SANDBOX_IMAGE, GO.image]);
    expect(r.outcome === 'success' && r.differentialTest.newTestsPassed).toBe(true);
  });

  it('AC4: extra suite run containers are hardened; fetch containers get no diff or secret', async () => {
    const driver = new FakeDockerDriver();
    await run(CONFIG, diffOf('sdk-python/a.py', 'sdk-go/a.go'), driver);
    expect(driver.runs).toHaveLength(2);
    for (const c of driver.runs) {
      for (const flag of ['--network=none', '--cap-drop=ALL', '--read-only', 'no-new-privileges']) {
        expect(c.args).toContain(flag);
      }
      expect(c.args.some((a) => a.startsWith('seccomp='))).toBe(true);
      expect(c.args[c.args.indexOf('--user') + 1]).toBe('65534:65534');
    }
    expect(driver.fetches).toHaveLength(2);
    for (const c of driver.fetches) {
      expect(Object.keys(c.env)).toEqual(['PATH']);
      expect(c.args).not.toContain('-e');
      expect(c.args.join(' ')).not.toMatch(/SANDBOX_PR_DIFF_B64|TOKEN|SIGNING_KEY|API_KEY/);
      expect(c.args).not.toContain('--network=none');
    }
    // the test command is single-quote escaped into `sh -c '...'`
    expect(driver.runs[0]!.args.at(-1)).toContain("python -m pytest -k '\\''a b'\\''");
  });

  it('AC5: a failing suite makes newTestsPassed false and is named', async () => {
    const driver = new FakeDockerDriver([GO.image]);
    const r = await run(CONFIG, diffOf('sdk-python/a.py', 'sdk-go/a.go'), driver);
    if (r.outcome !== 'success') throw new Error('expected success');
    expect(r.differentialTest.newTestsPassed).toBe(false);
    expect(r.differentialTest.upstreamSuitePassed).toBe(true);
    expect(r.differentialTest.newTestsOutput).toContain('failed suite(s): go');
    expect(r.differentialTest.newTestsOutput).not.toContain('failed suite(s): python');
  });

  it('an error outcome from any suite ends the run', async () => {
    const driver = new MockSandboxDriver('docker', { outcome: 'error', error: 'boom' });
    const r = await runSandbox({
      prNumber: 1,
      prDiff: diffOf('sdk-python/a.py', 'sdk-go/a.go'),
      upstreamMainRef: 'a'.repeat(40),
      config: CONFIG,
      driverOverride: driver,
    });
    expect(r).toEqual({ outcome: 'error', error: 'boom' });
  });

  it('AC3: an image without a digest is refused at load, naming the entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'suites-cfg-'));
    mkdirSync(join(dir, '.ai-sdlc'));
    const yaml = (image: string) =>
      `sandboxSuites:\n  - name: python\n    paths: ['sdk-python/**']\n    image: '${image}'\n    fetchCommand: a\n    testCommand: b\n`;
    writeFileSync(join(dir, '.ai-sdlc', 'untrusted-pr-gate.yaml'), yaml('python:3.13'));
    expect(() => loadSandboxConfig(dir)).toThrow(/sandboxSuites entry "python".*digest/);
    writeFileSync(join(dir, '.ai-sdlc', 'untrusted-pr-gate.yaml'), yaml(PY.image));
    expect(loadSandboxConfig(dir).sandboxSuites).toHaveLength(1);
  });

  it('rejects malformed entries', () => {
    const bad = (e: unknown, re: RegExp) => expect(() => parseSandboxSuites(e)).toThrow(re);
    expect(parseSandboxSuites(undefined)).toEqual([]);
    bad('x', /must be a list/);
    bad([null], /entry #0.*name/);
    bad([PY, PY], /"python".*duplicate/);
    bad([{ ...PY, paths: [] }], /paths/);
    bad([{ ...PY, paths: [''] }], /paths/);
    bad([{ ...PY, fetchCommand: ' ' }], /fetchCommand/);
    bad([{ ...PY, testCommand: undefined }], /testCommand/);
  });

  it('selects by path and parses diff paths', () => {
    expect(changedPathsFromDiff(diffOf('a/b.ts', 'c.md'))).toEqual(['a/b.ts', 'c.md']);
    expect(selectSuites([PY, GO], [])).toEqual({ node: true, suites: [] });
    expect(selectSuites([PY, GO], ['sdk-go/x', 'sdk-python/y'])).toEqual({
      node: false,
      suites: [PY, GO],
    });
    expect(buildSuiteFetchScript('echo hi')).toContain('echo hi');
  });

  it('AC6: the repository config lists python and go pinned by digest', () => {
    const root = resolve(fileURLToPath(import.meta.url), '../../../..');
    const cfg = loadSandboxConfig(root);
    expect(cfg.sandboxSuites?.map((s) => s.name)).toEqual(['python', 'go']);
  });
});
