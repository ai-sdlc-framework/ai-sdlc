import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUSKY_PREPUSH_SIGN_SNIPPET } from './init-templates.js';

/**
 * AISDLC-555 round-1 review: every existing assertion on this snippet was
 * string-containment against in-memory stub content, so reverting the
 * resolution chain to the pre-fix monorepo-only guard broke NOTHING —
 * 128 orchestrator tests and 8 plugin tests all still passed. The defect this
 * task closes is a hook that installs and then silently never fires, so a
 * test that never EXECUTES the snippet cannot observe it.
 *
 * These tests run the snippet as real bash, in a real temp repo.
 */
describe('HUSKY_PREPUSH_SIGN_SNIPPET — executed as bash (AISDLC-555)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'aisdlc-555-snippet-'));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** Run the snippet with `repo` as cwd and a controlled env. */
  function runSnippet(env: Record<string, string> = {}): { stdout: string; stderr: string } {
    const hookPath = join(repo, 'hook.sh');
    writeFileSync(
      hookPath,
      `#!/usr/bin/env bash\nset -euo pipefail\n${HUSKY_PREPUSH_SIGN_SNIPPET}`,
    );
    chmodSync(hookPath, 0o755);
    const res = spawnSync('bash', [hookPath], {
      cwd: repo,
      encoding: 'utf-8',
      // HOME is redirected so the cache-probe glob cannot find the real
      // operator's plugin install and make a test pass by accident.
      env: { PATH: process.env.PATH ?? '', HOME: join(repo, 'fake-home'), ...env },
    });
    // spawnSync (not execFileSync): these paths exit 0, and execFileSync
    // discards stderr on success — which silently hid the very diagnostics
    // these tests exist to assert.
    return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  /** A fake plugin dir whose signer just announces itself. */
  function makePluginDir(marker: string): string {
    const dir = join(repo, `plugin-${marker}`);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    const signer = join(dir, 'scripts', 'check-attestation-sign.sh');
    writeFileSync(signer, `#!/usr/bin/env bash\necho "SIGNED-BY-${marker}"\n`);
    chmodSync(signer, 0o755);
    return dir;
  }

  function withVerdict(): void {
    mkdirSync(join(repo, '.ai-sdlc', 'verdicts'), { recursive: true });
    writeFileSync(join(repo, '.ai-sdlc', 'verdicts', 'aisdlc-1.json'), '[]');
  }

  it('resolves and runs the signer via CLAUDE_PLUGIN_ROOT', () => {
    const plugin = makePluginDir('root');
    withVerdict();
    const { stdout, stderr } = runSnippet({ CLAUDE_PLUGIN_ROOT: plugin });
    expect(stdout).toContain('SIGNED-BY-root');
    expect(stderr).toContain('attestation signer:');
  });

  it('resolves via CLAUDE_PLUGIN_DIR when CLAUDE_PLUGIN_ROOT is unset', () => {
    const plugin = makePluginDir('dir');
    withVerdict();
    const { stdout } = runSnippet({ CLAUDE_PLUGIN_DIR: plugin });
    expect(stdout).toContain('SIGNED-BY-dir');
  });

  // THE case that had no coverage: hook installed, verdicts present, nothing
  // resolves. Pre-fix this exited 0 with no output and the operator learned
  // months later that no attestation was ever produced.
  it('is LOUD when verdicts exist but no signer resolves', () => {
    withVerdict();
    const { stderr } = runSnippet();
    expect(stderr).toContain('NO attestation signer');
    expect(stderr).toContain('CLAUDE_PLUGIN_ROOT');
  });

  it('stays quiet when there is nothing to sign', () => {
    // No verdicts: silence is correct, and must not become noise on every push.
    const { stdout, stderr } = runSnippet();
    expect(stdout.trim()).toBe('');
    expect(stderr.trim()).toBe('');
  });

  it('does NOT execute a signer from the working tree', () => {
    // Security review: the repo-relative tier put repo-tracked content on the
    // push-time path with the operator's signing key in scope.
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    const planted = join(repo, 'scripts', 'check-attestation-sign.sh');
    writeFileSync(planted, '#!/usr/bin/env bash\necho "PLANTED-IN-REPO"\n');
    chmodSync(planted, 0o755);
    withVerdict();

    const { stdout } = runSnippet();
    expect(stdout).not.toContain('PLANTED-IN-REPO');
  });

  it('honours AI_SDLC_SKIP_ATTESTATION_SIGN', () => {
    const plugin = makePluginDir('skip');
    withVerdict();
    const { stdout } = runSnippet({
      CLAUDE_PLUGIN_ROOT: plugin,
      AI_SDLC_SKIP_ATTESTATION_SIGN: '1',
    });
    expect(stdout).not.toContain('SIGNED-BY-skip');
  });
});
