import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUSKY_PREPUSH_SIGN_SNIPPET } from './init-templates.js';
import { applyFeatureSelection, buildProductionAdapters, NO_FEATURES } from './init-features.js';
import type { WizardFlags } from './init-features.js';

/** Non-interactive flags for the end-to-end install below. */
const E2E_FLAGS: WizardFlags = {
  yes: true,
  withDor: false,
  withAttestation: true,
  withClassifier: false,
  withBranchProtection: false,
  withWorkflows: false,
  withSignalIngestion: false,
  add: undefined,
  dryRun: false,
  force: false,
};

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

  // Round-2 review: the plugin-cache glob's missing `break` (last match wins
  // instead of first) was fixed but nothing would catch a regression, because
  // no test ever plants TWO cache entries.
  it('takes the FIRST plugin-cache match, not the last', () => {
    const home = join(repo, 'fake-home');
    for (const marker of ['aaa-first', 'zzz-last']) {
      const dir = join(home, '.claude', 'plugins', 'cache', marker, 'ai-sdlc', '1.0.0', 'scripts');
      mkdirSync(dir, { recursive: true });
      const signer = join(dir, 'check-attestation-sign.sh');
      writeFileSync(signer, `#!/usr/bin/env bash\necho "SIGNED-BY-${marker}"\n`);
      chmodSync(signer, 0o755);
    }
    withVerdict();
    const { stdout } = runSnippet();
    expect(stdout).toContain('SIGNED-BY-aaa-first');
    expect(stdout).not.toContain('SIGNED-BY-zzz-last');
  });
});

/**
 * End-to-end: install via the real production adapters into a real git repo
 * shaped like husky v9, then run an actual `git push` and assert our block
 * executed.
 *
 * Round-2 security review caught that resolving `core.hooksPath` naively
 * targets `.husky/_` under husky v9 — generated internals whose own
 * `.gitignore` is `*`, regenerated by every `npm install`. That hook works
 * once and then silently disappears. This is the second time a fix for a
 * silently-inert hook was itself silently inert on a common topology, so the
 * husky-v9 case is pinned by EXECUTION rather than by asserting on a path
 * string — the same reason the snippet tests above exist.
 *
 * Hermetic: no network, no npm install. The husky layout (core.hooksPath +
 * the `_/h` wrapper contract `sh -e $(dirname $(dirname $0))/<hook>`) is
 * reproduced from a real husky 9 install.
 */
describe('attestation hook install — real git push, husky v9 layout (AISDLC-555)', () => {
  let repo: string;
  let bare: string;
  let fakeHome: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'aisdlc-555-e2e-'));
    repo = join(root, 'work');
    bare = join(root, 'remote.git');
    fakeHome = join(root, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(repo, { recursive: true });
    git(['init', '-q', '-b', 'main', bare, '--bare'], root);
    git(['init', '-q', '-b', 'main', '.'], repo);
    git(['config', 'user.email', 'test@example.invalid'], repo);
    git(['config', 'user.name', 'AISDLC Test'], repo);
    git(['remote', 'add', 'origin', bare], repo);
  });

  afterEach(() => {
    rmSync(join(repo, '..'), { recursive: true, force: true });
  });

  /**
   * Round-3 test review caught this: the first version of this helper passed
   * no `env`, so the spawned `git push` inherited the REAL HOME — and the
   * installed hook's last resort is a glob over the plugin cache under
   * `$HOME/.claude/plugins/cache`.
   * On any machine with a cached plugin install (which this very PR causes to
   * exist) the hook would find and RUN the operator's real signer as a side
   * effect of `pnpm test`, and the assertion below would flip. It passed only
   * because no such path happens to exist here — luck, not isolation.
   *
   * `spawnSync`'s `env` REPLACES the environment rather than merging, so this
   * also drops any inherited GIT_DIR / GIT_WORK_TREE (set when the suite runs
   * under a husky pre-push hook), which would otherwise point git at the real
   * repository instead of `cwd`.
   */
  function git(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: fakeHome,
        // Do not read the operator's system/global git config — a global
        // core.hooksPath would otherwise change what this test exercises.
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(fakeHome, '.gitconfig'),
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? -1 };
  }

  /** Reproduce husky v9's on-disk layout without installing husky. */
  function installHuskyV9Layout(): void {
    const internals = join(repo, '.husky', '_');
    mkdirSync(internals, { recursive: true });
    // husky's own .gitignore — this is WHY installing into `_` is wrong.
    writeFileSync(join(internals, '.gitignore'), '*');
    writeFileSync(join(internals, 'h'), '#!/usr/bin/env sh\n');
    // The generated wrapper: delegate to ../<hookname>, exit 0 if absent.
    const wrapper =
      '#!/usr/bin/env sh\n' +
      'n=$(basename "$0")\n' +
      's=$(dirname "$(dirname "$0")")/$n\n' +
      '[ ! -f "$s" ] && exit 0\n' +
      'sh -e "$s" "$@"\n';
    writeFileSync(join(internals, 'pre-push'), wrapper);
    chmodSync(join(internals, 'pre-push'), 0o755);
    git(['config', 'core.hooksPath', '.husky/_'], repo);
  }

  it('installs to .husky/pre-push (not husky internals) and the hook RUNS on push', async () => {
    installHuskyV9Layout();

    await applyFeatureSelection(
      repo,
      { ...NO_FEATURES, attestation: true },
      { ...E2E_FLAGS },
      buildProductionAdapters(),
    );

    // Durable, adopter-owned location — NOT the gitignored internals that
    // husky regenerates on the next `npm install`.
    expect(existsSync(join(repo, '.husky', 'pre-push'))).toBe(true);
    expect(readFileSync(join(repo, '.husky', 'pre-push'), 'utf-8')).toContain(
      '# ai-sdlc:attestation-sign-block',
    );
    expect(existsSync(join(repo, '.husky', '_', 'pre-push.ai-sdlc'))).toBe(false);
    expect(readFileSync(join(repo, '.husky', '_', 'pre-push'), 'utf-8')).not.toContain(
      'ai-sdlc:attestation-sign-block',
    );

    // A non-empty verdicts dir is the signer's own precondition, so the block
    // must reach its loud "no signer resolved" diagnostic. That message is the
    // observable proof the hook actually executed.
    mkdirSync(join(repo, '.ai-sdlc', 'verdicts'), { recursive: true });
    writeFileSync(join(repo, '.ai-sdlc', 'verdicts', 'aisdlc-1.json'), '[]');
    writeFileSync(join(repo, 'file.txt'), 'hello\n');
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'init'], repo);

    const push = git(['push', 'origin', 'main'], repo);
    expect(
      push.stderr,
      `expected the installed hook to run on push; stderr was:\n${push.stderr}`,
    ).toContain('NO attestation signer');
  });

  it('sets the exec bit without widening a restrictive pre-existing mode', async () => {
    installHuskyV9Layout();
    // An adopter's deliberately-private hook: owner read/write only.
    mkdirSync(join(repo, '.husky'), { recursive: true });
    writeFileSync(join(repo, '.husky', 'pre-push'), '#!/usr/bin/env sh\necho existing\n');
    chmodSync(join(repo, '.husky', 'pre-push'), 0o600);

    await applyFeatureSelection(
      repo,
      { ...NO_FEATURES, attestation: true },
      { ...E2E_FLAGS },
      buildProductionAdapters(),
    );

    const mode = statSync(join(repo, '.husky', 'pre-push')).mode & 0o777;
    // Executable (git ignores a non-executable hook) ...
    expect(mode & 0o100).toBe(0o100);
    // ... but group/other read must NOT have been granted, as a forced 0o755
    // would have done.
    expect(mode & 0o044).toBe(0);
  });
});
