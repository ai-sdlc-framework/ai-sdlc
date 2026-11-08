import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReviewerResourceNames,
  buildInternalNetworkCreateArgs,
  buildRelayRunArgs,
  buildRelayConnectArgs,
  buildReviewerContainerArgs,
  assertNoCredentialInEnv,
  readReviewerVerdicts,
  runReviewerEntrypoint,
  runReviewerMatrixInContainer,
  defaultDockerExec,
  REVIEWER_VERDICTS_FILE,
  REVIEWER_INPUT_FILE,
  type DockerExec,
} from './reviewer-container.js';
import { buildReviewerProxyEnv } from './inference-proxy.js';
import { FakeModelClient } from './reviewer-runner.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const dt = {
  upstreamSuitePassed: true,
  upstreamSuiteOutput: '',
  newTestsPassed: true,
  newTestsOutput: '',
  newCodeCoveragePct: 90,
};
const RUN = 'abcdef0123456789';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rc-test-'));
}

describe('reviewer container arg builders', () => {
  it('validates run id and names resources', () => {
    expect(buildReviewerResourceNames(RUN).network).toBe(`ucvg-rev-net-${RUN}`);
    expect(() => buildReviewerResourceNames('../x')).toThrow();
  });

  it('creates an internal network and relays only one port', () => {
    expect(buildInternalNetworkCreateArgs('n')).toContain('--internal');
    const relay = buildRelayRunArgs({ relayName: 'r', proxyPort: 9090 });
    expect(relay).toContain('TCP:host.docker.internal:9090');
    expect(() => buildRelayRunArgs({ relayName: 'r', proxyPort: 0 })).toThrow();
    expect(buildRelayConnectArgs('n', 'r')).toEqual([
      'network',
      'connect',
      '--alias',
      'inference.local',
      'n',
      'r',
    ]);
  });

  it('reviewer container is on the internal net only, no key, verdict volume rw', () => {
    const env = buildReviewerProxyEnv({ port: 9090, sessionToken: 't' });
    const args = buildReviewerContainerArgs({
      name: 'c',
      network: 'n',
      inDir: '/i',
      outDir: '/o',
      appDir: '/a',
      env,
    });
    expect(args).toContain('--network=n');
    expect(args).not.toContain('--network=none');
    expect(args.join(' ')).not.toMatch(/--network=(host|bridge)/);
    expect(args).toContain('/o:/sandbox/out:rw');
    expect(args).toContain('/i:/sandbox/in:ro');
    expect(args.join(' ')).not.toContain('ANTHROPIC_API_KEY');
    expect(args).toContain('--cap-drop=ALL');
  });

  it('refuses credential env', () => {
    expect(() => assertNoCredentialInEnv({ ANTHROPIC_API_KEY: 'x' })).toThrow(/credential/);
    expect(() =>
      buildReviewerContainerArgs({
        name: 'c',
        network: 'n',
        inDir: '/i',
        outDir: '/o',
        appDir: '/a',
        env: { ANTHROPIC_API_KEY: 'x' },
      }),
    ).toThrow();
    expect(() =>
      assertNoCredentialInEnv(buildReviewerProxyEnv({ port: 1, sessionToken: 's' })),
    ).not.toThrow();
  });
});

describe('verdict return contract', () => {
  it('parses verdicts from the mounted file', () => {
    const d = tmp();
    const v = { approved: true, findings: [], promptInjectionDetected: false };
    writeFileSync(
      join(d, REVIEWER_VERDICTS_FILE),
      JSON.stringify({ code: v, test: v, security: v }),
    );
    expect(readReviewerVerdicts(d).consensus.approved).toBe(true);
    removeFixtureDir(d);
  });

  it('fails closed on missing, corrupt, or partial files', () => {
    const d = tmp();
    expect(readReviewerVerdicts(d).consensus.approved).toBe(false);
    writeFileSync(join(d, REVIEWER_VERDICTS_FILE), 'not json');
    expect(readReviewerVerdicts(d).consensus.approved).toBe(false);
    writeFileSync(join(d, REVIEWER_VERDICTS_FILE), '"str"');
    expect(readReviewerVerdicts(d).consensus.approved).toBe(false);
    removeFixtureDir(d);
  });
});

describe('runReviewerEntrypoint', () => {
  const env = {
    INFERENCE_PROXY_HOST: 'h',
    INFERENCE_PROXY_PORT: '1',
    INFERENCE_PROXY_SESSION: 's',
  };

  it('writes verdicts.json from the staged input', async () => {
    const inDir = tmp();
    const outDir = tmp();
    writeFileSync(
      join(inDir, REVIEWER_INPUT_FILE),
      JSON.stringify({ prDiff: 'diff', prNumber: 1, differentialTest: dt }),
    );
    await runReviewerEntrypoint(env, { inDir, outDir }, () => new FakeModelClient() as never);
    expect(existsSync(join(outDir, REVIEWER_VERDICTS_FILE))).toBe(true);
    const out = JSON.parse(readFileSync(join(outDir, REVIEWER_VERDICTS_FILE), 'utf8'));
    expect(out.code.approved).toBe(true);
    removeFixtureDir(inDir);
    removeFixtureDir(outDir);
  });

  it('refuses without proxy env', async () => {
    await expect(runReviewerEntrypoint({}, { inDir: '/x', outDir: '/y' })).rejects.toThrow(
      /missing/,
    );
  });

  it('constructs the default proxy client', async () => {
    const inDir = tmp();
    const outDir = tmp();
    writeFileSync(join(inDir, REVIEWER_INPUT_FILE), '{bad');
    await expect(runReviewerEntrypoint(env, { inDir, outDir })).rejects.toThrow();
    writeFileSync(
      join(inDir, REVIEWER_INPUT_FILE),
      JSON.stringify({ prDiff: 'd', prNumber: 1, differentialTest: dt }),
    );
    // Port 1 refuses connections: model calls fail closed, file is still written.
    await runReviewerEntrypoint(env, { inDir, outDir });
    expect(readReviewerVerdicts(outDir).consensus.approved).toBe(false);
    removeFixtureDir(inDir);
    removeFixtureDir(outDir);
  });
});

describe('runReviewerMatrixInContainer', () => {
  const base = {
    prDiff: 'd',
    prNumber: 3,
    differentialTest: dt,
    proxyPort: 9090,
    sessionToken: 's',
    appDir: '/app',
    runId: RUN,
  };

  it('sequences docker calls and reads verdicts from the volume', async () => {
    const calls: string[][] = [];
    const parent = tmp();
    const exec: DockerExec = async (args) => {
      calls.push(args);
      if (args[0] === 'run' && !args.includes('-d')) {
        const out = args.find((a) => a.endsWith(':/sandbox/out:rw'))!.split(':')[0]!;
        const v = { approved: true, findings: [], promptInjectionDetected: false };
        writeFileSync(
          join(out, REVIEWER_VERDICTS_FILE),
          JSON.stringify({ code: v, test: v, security: v }),
        );
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await runReviewerMatrixInContainer({ ...base, exec, scratchParent: parent });
    expect(r.consensus.approved).toBe(true);
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual([
      'network create',
      'run -d',
      'network connect',
      'run --rm',
      'rm -f',
      'rm -f',
      'network rm',
    ]);
    expect(readdirSync(parent)).toEqual([]);
    removeFixtureDir(parent);
  });

  it('fails closed and tears down when network creation fails', async () => {
    const calls: string[][] = [];
    const exec: DockerExec = async (args) => {
      calls.push(args);
      return {
        code: args[0] === 'network' && args[1] === 'create' ? 1 : 0,
        stdout: '',
        stderr: '',
      };
    };
    const r = await runReviewerMatrixInContainer({ ...base, exec });
    expect(r.consensus.approved).toBe(false);
    expect(
      calls.some(
        (c) => c[0] === 'run' && !c.includes('-d') && c.includes('--rm') && c.includes('-v'),
      ),
    ).toBe(false);
    expect(calls.some((c) => c[0] === 'network' && c[1] === 'rm')).toBe(false);
  });

  it.each(['run -d', 'network connect'])('fails closed when %s fails', async (which) => {
    const exec: DockerExec = async (args) => ({
      code: args.slice(0, 2).join(' ') === which ? 1 : 0,
      stdout: '',
      stderr: '',
    });
    const r = await runReviewerMatrixInContainer({ ...base, exec });
    expect(r.consensus.approved).toBe(false);
  });

  it('uses a random run id by default', async () => {
    const names: string[] = [];
    const exec: DockerExec = async (args) => {
      names.push(args.join(' '));
      return { code: 1, stdout: '', stderr: '' };
    };
    const { runId: _r, ...rest } = base;
    void _r;
    await runReviewerMatrixInContainer({ ...rest, exec });
    expect(names[0]).toMatch(/ucvg-rev-net-[a-f0-9]{16}/);
  });
});

describe('defaultDockerExec', () => {
  it('reports a spawn failure as non-zero', async () => {
    const orig = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const r = await defaultDockerExec(['version']);
      expect(r.code).not.toBe(0);
    } finally {
      process.env['PATH'] = orig;
    }
  });
});
