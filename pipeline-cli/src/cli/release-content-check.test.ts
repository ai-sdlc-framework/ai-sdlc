import { describe, expect, it } from 'vitest';
import type { ExecResult, Runner } from '../runtime/exec.js';
import { runReleaseContentCheckCli } from './release-content-check.js';

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' }) as ExecResult;

function runnerFor(
  files: { filename: string; status: string }[],
  blob: (path: string, ref: string) => string,
  compareCode = 0,
): Runner {
  return (async (_cmd: string, args: string[]) => {
    const url = args[1] ?? '';
    if (url.includes('/compare/')) {
      return compareCode === 0
        ? ok(files.map((f) => JSON.stringify(f)).join('\n'))
        : ({ code: 1, stdout: '', stderr: 'boom' } as ExecResult);
    }
    const m = /contents\/(.+)\?ref=(\w+)/.exec(url)!;
    const text = blob(m[1], m[2]);
    return ok(JSON.stringify({ type: 'file', content: Buffer.from(text).toString('base64') }));
  }) as unknown as Runner;
}

const argv = ['--base', 'aaaa', '--head', 'bbbb', '--repository', 'o/r'];

async function run(runner: Runner, args = argv) {
  const errs: string[] = [];
  const code = await runReleaseContentCheckCli({ argv: args, runner, stderr: (t) => errs.push(t) });
  return { code, err: errs.join('') };
}

describe('cli-release-content-check', () => {
  it('passes a changelog-only release', async () => {
    const r = await run(runnerFor([{ filename: 'CHANGELOG.md', status: 'modified' }], () => 'x'));
    expect(r.code).toBe(0);
  });

  it('names the offending path', async () => {
    const r = await run(
      runnerFor(
        [
          { filename: 'CHANGELOG.md', status: 'modified' },
          { filename: 'src/evil.ts', status: 'modified' },
        ],
        () => 'x',
      ),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('src/evil.ts');
  });

  it('fails closed when the file list cannot be read', async () => {
    const r = await run(runnerFor([], () => '', 1));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/failing closed/);
  });

  it('refuses an empty change list', async () => {
    const r = await run(runnerFor([], () => ''));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no files/);
  });

  it('refuses non-version content changes in a package manifest', async () => {
    const r = await run(
      runnerFor([{ filename: 'pipeline-cli/package.json', status: 'modified' }], (_p, ref) =>
        ref === 'aaaa' ? '{"version":"1.0.0"}' : '{"version":"1.0.1","scripts":{"x":"y"}}',
      ),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('pipeline-cli/package.json');
  });

  it('prints usage when arguments are missing', async () => {
    const r = await run(
      runnerFor([], () => ''),
      ['--base', 'a'],
    );
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage/);
  });

  it('summarises more than five offenders', async () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ filename: `f${i}.ts`, status: 'added' }));
    const r = await run(runnerFor(files, () => 'x'));
    expect(r.err).toMatch(/\+2 more/);
  });
});
