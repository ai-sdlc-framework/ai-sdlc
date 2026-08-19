/**
 * Tests for `ai-sdlc-plugin/scripts/check-attestation-sign.sh` — AISDLC-555.
 *
 * This is the PLUGIN-SHIPPED copy of `scripts/check-attestation-sign.sh`
 * (the monorepo-root copy, tested separately by
 * `scripts/check-attestation-sign.test.mjs`, is unchanged by AISDLC-555).
 * The two copies share almost all of their behaviour — this suite focuses
 * on the gate conditions, idempotency, and the one thing that's actually
 * different here: Step 5 resolves `sign-attestation.mjs` relative to THIS
 * SCRIPT's own on-disk directory rather than `<worktree>/ai-sdlc-plugin/
 * scripts/sign-attestation.mjs`. That's what makes the plugin copy work
 * when it's installed OUTSIDE the monorepo (plugin cache, CLAUDE_PLUGIN_ROOT
 * checkout) — see the "self-location resolution" describe block below.
 *
 * Run with: node --test ai-sdlc-plugin/scripts/check-attestation-sign.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  chmodSync,
  cpSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-attestation-sign.sh');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.AI_SDLC_BYPASS_ALL_GATES;
  delete env.AI_SDLC_SKIP_ATTESTATION_SIGN;
  delete env.AI_SDLC_SIGN_ATTESTATION_CMD;
  delete env.AI_SDLC_ITERATION_COUNT;
  delete env.AI_SDLC_HARNESS_NOTE;
  delete env.AI_SDLC_SCHEMA_VERSION;
  delete env.AI_SDLC_V6_CUTOVER_ACTIVE;
  if (!('AI_SDLC_V6_CUTOVER_ACTIVE' in extra)) {
    env.AI_SDLC_V6_CUTOVER_ACTIVE = '1';
  }
  delete env.CODEX_VERSION;
  // AISDLC-555: never let the real plugin env vars leak into a test that's
  // deliberately exercising the "neither var is set" resolution path.
  if (!('CLAUDE_PLUGIN_ROOT' in extra)) delete env.CLAUDE_PLUGIN_ROOT;
  if (!('CLAUDE_PLUGIN_DIR' in extra)) delete env.CLAUDE_PLUGIN_DIR;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-plugin-attestation-sign-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], root);
  return root;
}

/**
 * Install a fake signer at `<root>/bin/fake-signer.sh` that writes a stub
 * v6 (or v5) envelope, mirroring the upstream test helper in
 * `scripts/check-attestation-sign.test.mjs`.
 */
function installFakeSigner(root, { fail = false, silent = false } = {}) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, 'signer.log');
  const shimPath = join(binDir, 'fake-signer.sh');
  const failBlock = fail ? 'exit 7' : '';
  const writeBlock = silent
    ? '# silent mode: do not write the file'
    : `mkdir -p "$WT_ROOT/.ai-sdlc/attestations"
SCHEMA_VERSION_ARG="v6"
if echo "$*" | grep -q -- "--schema-version v5"; then
  SCHEMA_VERSION_ARG="v5"
fi
if [ "$SCHEMA_VERSION_ARG" = "v6" ]; then
  EXT=".v6.dsse.json"
else
  EXT=".dsse.json"
fi
printf '{"_test":"stub","head":"%s","schemaVersion":"%s"}\\n' "$HEAD" "$SCHEMA_VERSION_ARG" > "$WT_ROOT/.ai-sdlc/attestations/$HEAD$EXT"`;
  const shim = `#!/usr/bin/env bash
echo "fake-signer $*" >> "${logPath}"
${failBlock}
WT_ROOT=$(git rev-parse --show-toplevel)
HEAD=$(git rev-parse HEAD)
${writeBlock}
exit 0
`;
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return { cmd: `bash ${shimPath}`, logPath };
}

function writeVerdictFile(root, taskId) {
  const dir = join(root, '.ai-sdlc', 'verdicts');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${taskId.toLowerCase()}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      [
        {
          agentId: 'code-reviewer',
          harness: 'claude-code',
          approved: true,
          findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        },
      ],
      null,
      2,
    ) + '\n',
  );
  return path;
}

function runHook(scriptPath, cwd, env = {}) {
  return spawnSync('bash', [scriptPath], {
    cwd,
    env: cleanEnv(env),
    encoding: 'utf-8',
  });
}

describe('ai-sdlc-plugin/scripts/check-attestation-sign.sh (AISDLC-555)', () => {
  let root;

  beforeEach(() => {
    root = setupRepo();
    chmodSync(SCRIPT, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('AI_SDLC_BYPASS_ALL_GATES=1 exits 0 immediately even when ready to sign', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-555\n');
    writeVerdictFile(root, 'AISDLC-555');
    const headBefore = git(['rev-parse', 'HEAD'], root).trim();
    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(SCRIPT, root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      AI_SDLC_BYPASS_ALL_GATES: '1',
    });
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
    assert.equal(existsSync(logPath), false, 'signer must NOT run when bypass is set');
    assert.equal(git(['rev-parse', 'HEAD'], root).trim(), headBefore);
  });

  it('exits 0 when the active-task sentinel is absent (chore PR / ad-hoc)', () => {
    const r = runHook(SCRIPT, root);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  });

  it('exits 0 when sentinel present but verdict file is absent', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-555\n');
    const r = runHook(SCRIPT, root);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  });

  it('idempotent — exits 0 when v6 attestation already exists at HEAD', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-555\n');
    writeVerdictFile(root, 'AISDLC-555');
    const head = git(['rev-parse', 'HEAD'], root).trim();
    const attDir = join(root, '.ai-sdlc', 'attestations');
    mkdirSync(attDir, { recursive: true });
    writeFileSync(join(attDir, `${head}.v6.dsse.json`), '{"existing":true,"schemaVersion":"v6"}\n');
    const { cmd, logPath } = installFakeSigner(root, { fail: true });
    const r = runHook(SCRIPT, root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
    assert.equal(existsSync(logPath), false, 'signer must not run when already signed');
  });

  it('signs + commits + exits 1 (re-push required) when sentinel + verdict are present', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-555\n');
    writeVerdictFile(root, 'AISDLC-555');
    const headBefore = git(['rev-parse', 'HEAD'], root).trim();
    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(SCRIPT, root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });
    assert.equal(r.status, 1, `expected 1 (re-push required), got ${r.status}: ${r.stderr}`);
    assert.equal(existsSync(logPath), true, 'signer must have run');
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.notEqual(headAfter, headBefore, 'a new chore commit must have landed');
    const subject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
    assert.match(subject, /^chore: auto-sign attestation for AISDLC-555/);
  });

  it('AI_SDLC_SKIP_ATTESTATION_SIGN=1 skips signing entirely', () => {
    writeFileSync(join(root, '.active-task'), 'AISDLC-555\n');
    writeVerdictFile(root, 'AISDLC-555');
    const { cmd, logPath } = installFakeSigner(root);
    const r = runHook(SCRIPT, root, {
      AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
      AI_SDLC_SKIP_ATTESTATION_SIGN: '1',
    });
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
    assert.equal(existsSync(logPath), false, 'signer must not run when skip flag is set');
  });

  // ── AISDLC-555: self-location resolution ────────────────────────────
  //
  // The whole point of shipping this copy under ai-sdlc-plugin/scripts/ is
  // that it must work when this file (and sign-attestation.mjs next to it)
  // are installed SOMEWHERE OTHER THAN the ai-sdlc monorepo — e.g. a plugin
  // cache directory copied wholesale into a scratch/adopter repo test. These
  // tests copy check-attestation-sign.sh to a throwaway directory alongside
  // a fake sign-attestation.mjs and confirm it's found and invoked WITHOUT
  // any AI_SDLC_SIGN_ATTESTATION_CMD override and WITHOUT CLAUDE_PLUGIN_ROOT
  // / CLAUDE_PLUGIN_DIR being set — proving resolution is anchored to the
  // script's own directory, not the invoking shell's environment.
  describe('self-location resolution (no monorepo, no plugin env vars)', () => {
    let pluginDir;

    beforeEach(() => {
      pluginDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-plugin-selflocation-'));
      // Simulate the real install topology: check-attestation-sign.sh and
      // sign-attestation.mjs always ship side-by-side in the same scripts/ dir.
      cpSync(SCRIPT, join(pluginDir, 'check-attestation-sign.sh'));
      chmodSync(join(pluginDir, 'check-attestation-sign.sh'), 0o755);
    });

    afterEach(() => {
      rmSync(pluginDir, { recursive: true, force: true });
    });

    it('invokes sign-attestation.mjs from its own directory, not $WT_ROOT', () => {
      // A fake sign-attestation.mjs that just writes a stub v6 envelope and
      // exits 0 — proves the hook resolved THIS file (in pluginDir), not
      // some worktree-relative path (which does not exist here at all: the
      // worktree root and pluginDir are deliberately different directories).
      const fakeSignerMjs = join(pluginDir, 'sign-attestation.mjs');
      writeFileSync(
        fakeSignerMjs,
        `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const cwd = process.cwd();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
const dir = join(cwd, '.ai-sdlc', 'attestations');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, head + '.v6.dsse.json'), JSON.stringify({ _test: 'self-location', head }) + '\\n');
process.stdout.write('signed via self-location resolution\\n');
`,
      );

      writeFileSync(join(root, '.active-task'), 'AISDLC-555\n');
      writeVerdictFile(root, 'AISDLC-555');
      const scriptPath = join(pluginDir, 'check-attestation-sign.sh');
      // Deliberately no AI_SDLC_SIGN_ATTESTATION_CMD override, no
      // CLAUDE_PLUGIN_ROOT/CLAUDE_PLUGIN_DIR — proves the resolution is
      // anchored to the script's own on-disk location.
      const r = runHook(scriptPath, root, {});
      assert.equal(
        r.status,
        1,
        `expected 1 (re-push required after successful self-located sign), got ${r.status}: ${r.stderr}`,
      );
      const head = git(['rev-parse', 'HEAD'], root).trim();
      // HEAD moved to the chore commit; the envelope was written against the
      // PRE-chore commit SHA, which is HEAD~1 now.
      const parent = git(['rev-parse', 'HEAD~1'], root).trim();
      assert.equal(
        existsSync(join(root, '.ai-sdlc', 'attestations', `${parent}.v6.dsse.json`)),
        true,
        'the self-located fake signer must have written the envelope',
      );
    });

    it('errors out (exit 2) with a message naming the resolved (missing) path when sign-attestation.mjs is absent', () => {
      // No sign-attestation.mjs written next to the copied script — Step 5
      // must fail loudly (not silently) naming the self-located path it tried.
      writeFileSync(join(root, '.active-task'), 'AISDLC-555\n');
      writeVerdictFile(root, 'AISDLC-555');
      const scriptPath = join(pluginDir, 'check-attestation-sign.sh');
      const r = runHook(scriptPath, root, {});
      assert.equal(r.status, 2, `expected 2 (signer failure), got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /sign-attestation\.mjs/);
    });
  });
});
