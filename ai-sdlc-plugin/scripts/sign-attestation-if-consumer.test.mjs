/**
 * Tests for `ai-sdlc-plugin/scripts/sign-attestation-if-consumer.sh` — AISDLC-598.
 *
 * `/ai-sdlc execute` writes the reviewer verdicts file at
 * `<worktree>/.ai-sdlc/verdicts/<task-id-lower>.json` and historically relied
 * on the MONOREPO's own husky `pre-push` hook to auto-sign the DSSE
 * attestation at push time (AISDLC-133 / `check-attestation-sign.sh`). In a
 * consumer/adopter repo, `.husky/pre-push` is the adopter's OWN hook and does
 * not reach the ai-sdlc signer — this script closes that gap by signing
 * in-process, BEFORE push, whenever the current repo's push path does not
 * already reach the signer.
 *
 * Detection is a push-path PROBE (grep `.husky/pre-push`, transitively via
 * `scripts/pre-push-fixups.sh`, for a reference to `check-attestation-sign.sh`)
 * — not a hardcoded "is this the ai-sdlc monorepo" check and not an operator
 * env flag (AC #4).
 *
 * Covers:
 *   (a) monorepo push path (signer reachable directly, or via
 *       pre-push-fixups.sh) → no-op, no sign, no commit.
 *   (b) consumer push path (no signer anywhere on .husky/pre-push) → signs +
 *       commits + self-verifies successfully.
 *   (c) verify-red → aborts non-zero with an actionable message, without
 *       silently letting the caller push.
 *
 * The signer + verifier commands are overridable via
 * AI_SDLC_SIGN_ATTESTATION_CMD / AI_SDLC_VERIFY_ATTESTATION_CMD so these
 * tests are fully hermetic — no orchestrator build, no signing key, no real
 * DSSE crypto.
 *
 * Run with: node --test ai-sdlc-plugin/scripts/sign-attestation-if-consumer.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'sign-attestation-if-consumer.sh');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.AI_SDLC_BYPASS_ALL_GATES;
  delete env.AI_SDLC_SKIP_ATTESTATION_SIGN;
  delete env.AI_SDLC_SIGN_ATTESTATION_CMD;
  delete env.AI_SDLC_ALLOW_SIGNER_OVERRIDE;
  delete env.AI_SDLC_VERIFY_ATTESTATION_CMD;
  delete env.AI_SDLC_ITERATION_COUNT;
  delete env.AI_SDLC_HARNESS_NOTE;
  delete env.AI_SDLC_SCHEMA_VERSION;
  delete env.AI_SDLC_V6_CUTOVER_ACTIVE;
  if (!('AI_SDLC_V6_CUTOVER_ACTIVE' in extra)) {
    env.AI_SDLC_V6_CUTOVER_ACTIVE = '1';
  }
  delete env.CODEX_VERSION;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-sign-if-consumer-'));
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

/** Install a monorepo-style `.husky/pre-push` that directly references check-attestation-sign.sh. */
function installMonorepoPushPathDirect(root) {
  mkdirSync(join(root, '.husky'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'check-attestation-sign.sh'),
    '#!/usr/bin/env bash\nexit 0\n',
  );
  writeFileSync(
    join(root, '.husky', 'pre-push'),
    '#!/usr/bin/env bash\n./scripts/check-attestation-sign.sh\n',
  );
}

/** Install a monorepo-style push path where pre-push delegates via pre-push-fixups.sh. */
function installMonorepoPushPathViaFixups(root) {
  mkdirSync(join(root, '.husky'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'check-attestation-sign.sh'),
    '#!/usr/bin/env bash\nexit 0\n',
  );
  writeFileSync(
    join(root, 'scripts', 'pre-push-fixups.sh'),
    '#!/usr/bin/env bash\n./scripts/check-attestation-sign.sh\n',
  );
  writeFileSync(
    join(root, '.husky', 'pre-push'),
    '#!/usr/bin/env bash\n./scripts/pre-push-fixups.sh\n',
  );
}

/** Install a consumer-style `.husky/pre-push` — the adopter's own hook, no ai-sdlc signer anywhere. */
function installConsumerPushPath(root) {
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(join(root, '.husky', 'pre-push'), '#!/usr/bin/env bash\nnpx lint-staged\n');
}

/**
 * Install a `.husky/pre-push` that ONLY mentions check-attestation-sign.sh in
 * a comment (or a dead/disabled `#`-prefixed line) — never actually invokes
 * it. MAJOR #2 round-2 review fix: a literal substring grep without comment
 * stripping would false-positive this as "monorepo owns signing", causing
 * BOTH this script AND the (non-existent) hook to skip signing — the exact
 * silent-no-envelope failure this script exists to prevent.
 */
function installCommentOnlyMentionPushPath(root) {
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(
    join(root, '.husky', 'pre-push'),
    [
      '#!/usr/bin/env bash',
      '# This repo used to run scripts/check-attestation-sign.sh here, but we',
      '# disabled it — see the incident writeup.',
      '# ./scripts/check-attestation-sign.sh',
      'npx lint-staged',
      '',
    ].join('\n'),
  );
}

function installFakeSigner(root, { fail = false, valid = true } = {}) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, 'signer.log');
  const shimPath = join(binDir, 'fake-signer.sh');
  const failBlock = fail ? 'exit 7' : '';
  const shim = `#!/usr/bin/env bash
echo "fake-signer $*" >> "${logPath}"
${failBlock}
WT_ROOT=$(git rev-parse --show-toplevel)
HEAD=$(git rev-parse HEAD)
mkdir -p "$WT_ROOT/.ai-sdlc/attestations"
SCHEMA_VERSION_ARG="v6"
if echo "$*" | grep -q -- "--schema-version v5"; then
  SCHEMA_VERSION_ARG="v5"
fi
if [ "$SCHEMA_VERSION_ARG" = "v6" ]; then
  EXT=".v6.dsse.json"
else
  EXT=".dsse.json"
fi
FAKE_MERGE_BASE=$(git merge-base "origin/main" HEAD 2>/dev/null || echo '')
FAKE_PATCH_ID=""
if [ -n "$FAKE_MERGE_BASE" ] && [ \${#FAKE_MERGE_BASE} -eq 40 ]; then
  FAKE_DIFF=$(git diff-tree --no-color -p "\${FAKE_MERGE_BASE}..HEAD" -- ':!.ai-sdlc/attestations/' ':!.ai-sdlc/transcript-leaves/' ':!.ai-sdlc/transcript-leaves.jsonl' 2>/dev/null || echo '')
  if [ -n "$FAKE_DIFF" ]; then
    FAKE_PATCH_ID_LINE=$(printf '%s' "$FAKE_DIFF" | git patch-id --stable 2>/dev/null | head -1 || echo '')
    FAKE_PATCH_ID=$(printf '%s' "$FAKE_PATCH_ID_LINE" | cut -c1-40 2>/dev/null || echo '')
    if ! printf '%s' "$FAKE_PATCH_ID" | grep -qE '^[0-9a-f]{40}$'; then
      FAKE_PATCH_ID=""
    fi
  fi
fi
if [ -n "$FAKE_PATCH_ID" ]; then
  ENVELOPE_KEY="$FAKE_PATCH_ID"
else
  ENVELOPE_KEY="$HEAD"
fi
printf '{"_test":"stub","head":"%s","schemaVersion":"%s","valid":${valid}}\\n' "$HEAD" "$SCHEMA_VERSION_ARG" > "$WT_ROOT/.ai-sdlc/attestations/$ENVELOPE_KEY$EXT"
exit 0
`;
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return { cmd: `bash ${shimPath}`, logPath };
}

/** Install a fake verifier that reports valid/invalid based on the `valid` option. */
function installFakeVerifier(root, { valid = true } = {}) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, 'verifier.log');
  const shimPath = join(binDir, 'fake-verifier.sh');
  const shim = `#!/usr/bin/env bash
echo "fake-verifier $*" >> "${logPath}"
if [ "${valid ? '1' : '0'}" = "1" ]; then
  echo "status=valid"
  echo "reason=ok"
  exit 0
else
  echo "status=invalid"
  echo "reason=stub failure for test"
  exit 1
fi
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

function runScript(cwd, env = {}) {
  return spawnSync('bash', [SCRIPT], {
    cwd,
    env: cleanEnv(env),
    encoding: 'utf-8',
  });
}

describe('sign-attestation-if-consumer.sh (AISDLC-598)', () => {
  let root;

  beforeEach(() => {
    root = setupRepo();
    chmodSync(SCRIPT, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('monorepo push path — no-op, never double-signs', () => {
    it('no-ops when .husky/pre-push directly references check-attestation-sign.sh', () => {
      installMonorepoPushPathDirect(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');
      const headBefore = git(['rev-parse', 'HEAD'], root).trim();
      const { cmd, logPath } = installFakeSigner(root);

      const r = runScript(root, {
        AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
      });

      assert.equal(r.status, 0, `expected 0 (monorepo no-op), got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /monorepo-style push path/i);
      assert.equal(existsSync(logPath), false, 'signer must NOT run on monorepo push path');
      assert.equal(git(['rev-parse', 'HEAD'], root).trim(), headBefore, 'no commit must land');
    });

    it('no-ops when .husky/pre-push reaches the signer transitively via pre-push-fixups.sh', () => {
      installMonorepoPushPathViaFixups(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');
      const headBefore = git(['rev-parse', 'HEAD'], root).trim();
      const { cmd, logPath } = installFakeSigner(root);

      const r = runScript(root, {
        AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
      });

      assert.equal(
        r.status,
        0,
        `expected 0 (monorepo no-op via fixups), got ${r.status}: ${r.stderr}`,
      );
      assert.match(r.stderr, /monorepo-style push path/i);
      assert.equal(
        existsSync(logPath),
        false,
        'signer must NOT run when reached via pre-push-fixups.sh',
      );
      assert.equal(git(['rev-parse', 'HEAD'], root).trim(), headBefore, 'no commit must land');
    });

    it('MAJOR #2: a comment-only mention of check-attestation-sign.sh is treated as CONSUMER, not monorepo', () => {
      installCommentOnlyMentionPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');

      const { cmd: signCmd, logPath: signLog } = installFakeSigner(root);
      const { cmd: verifyCmd } = installFakeVerifier(root, { valid: true });

      const r = runScript(root, {
        AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
        AI_SDLC_VERIFY_ATTESTATION_CMD: verifyCmd,
      });

      assert.equal(r.status, 0, `expected 0 (signed as consumer), got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /consumer-style push path/i);
      assert.equal(
        existsSync(signLog),
        true,
        'signer MUST run — a comment-only mention must not be treated as a live signer reference',
      );
    });
  });

  describe('consumer push path — signs in-process', () => {
    it('AC #1: signs + commits + self-verifies (status=valid) when no signer is on the push path', () => {
      installConsumerPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');
      const headBefore = git(['rev-parse', 'HEAD'], root).trim();

      const { cmd: signCmd } = installFakeSigner(root);
      const { cmd: verifyCmd, logPath: verifyLog } = installFakeVerifier(root, { valid: true });

      const r = runScript(root, {
        AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
        AI_SDLC_VERIFY_ATTESTATION_CMD: verifyCmd,
      });

      assert.equal(r.status, 0, `expected 0 (signed + verified), got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /consumer-style push path/i);
      assert.match(r.stderr, /self-verify passed/i);
      assert.equal(existsSync(verifyLog), true, 'verifier must have run');

      const newHead = git(['rev-parse', 'HEAD'], root).trim();
      assert.notEqual(newHead, headBefore, 'a chore commit must have been added');
      const subject = git(['log', '-1', '--format=%s', 'HEAD'], root).trim();
      assert.match(subject, /chore: sign attestation for AISDLC-598/);

      const attPath = join(root, '.ai-sdlc', 'attestations', `${headBefore}.v6.dsse.json`);
      assert.equal(existsSync(attPath), true, 'v6 attestation file must exist after sign');
    });

    it('AC #2: monorepo behaviour unchanged — a repo with NO .husky/pre-push at all is treated as consumer', () => {
      // No .husky directory whatsoever — still must sign (defensive default:
      // "not proven to be monorepo" => consumer path), not silently skip.
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');

      const { cmd: signCmd, logPath: signLog } = installFakeSigner(root);
      const { cmd: verifyCmd } = installFakeVerifier(root, { valid: true });

      const r = runScript(root, {
        AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
        AI_SDLC_VERIFY_ATTESTATION_CMD: verifyCmd,
      });

      assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
      assert.equal(
        existsSync(signLog),
        true,
        'signer must run when there is no push-path hook at all',
      );
    });

    it('exits 0 no-op when no .active-task sentinel exists (nothing to sign yet)', () => {
      installConsumerPushPath(root);
      const r = runScript(root);
      assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /nothing to sign/i);
    });

    it('exits 0 no-op when sentinel present but verdict file is absent', () => {
      installConsumerPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      const r = runScript(root);
      assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /no attestation needed yet/i);
    });

    it('is idempotent — exits 0 without re-signing when the existing envelope re-verifies valid', () => {
      installConsumerPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');
      const head = git(['rev-parse', 'HEAD'], root).trim();
      const attDir = join(root, '.ai-sdlc', 'attestations');
      mkdirSync(attDir, { recursive: true });
      writeFileSync(join(attDir, `${head}.v6.dsse.json`), '{"existing":true}\n');

      const { cmd, logPath } = installFakeSigner(root, { fail: true });
      const { cmd: verifyCmd } = installFakeVerifier(root, { valid: true });
      const r = runScript(root, {
        AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
        AI_SDLC_VERIFY_ATTESTATION_CMD: verifyCmd,
      });

      assert.equal(r.status, 0, `expected 0 (idempotent), got ${r.status}: ${r.stderr}`);
      assert.equal(existsSync(logPath), false, 'signer must NOT run when already signed and valid');
    });

    it('MINOR #3: a retry after a previously-failed self-verify does NOT silently pass', () => {
      // Simulate the failure mode from the round-2 review: run 1 signed an
      // envelope, self-verify failed (exit 1), the bad envelope + chore
      // commit are already on disk. Run 2 must NOT see "envelope exists" and
      // short-circuit to success without re-verifying.
      installConsumerPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');
      const head = git(['rev-parse', 'HEAD'], root).trim();
      const attDir = join(root, '.ai-sdlc', 'attestations');
      mkdirSync(attDir, { recursive: true });
      const badEnvelopePath = join(attDir, `${head}.v6.dsse.json`);
      writeFileSync(badEnvelopePath, '{"existing":true,"bad":true}\n');

      // The signer would succeed if re-invoked (fail:false); the verifier
      // reports invalid, matching the "run 1 failed self-verify" scenario.
      const { cmd: signCmd, logPath: signLog } = installFakeSigner(root, { fail: false });
      const { cmd: verifyCmd, logPath: verifyLog } = installFakeVerifier(root, { valid: false });

      const r = runScript(root, {
        AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
        AI_SDLC_VERIFY_ATTESTATION_CMD: verifyCmd,
      });

      assert.notEqual(
        r.status,
        0,
        'must NOT silently pass when the existing envelope fails re-verify',
      );
      assert.equal(
        existsSync(verifyLog),
        true,
        'verifier must have run against the pre-existing envelope',
      );
      assert.match(r.stderr, /FAILED re-verification|FAILED self-verification/i);
      // The bad envelope must have been removed and a fresh sign attempted
      // (proving this is a real retry, not a rubber-stamp).
      assert.equal(
        existsSync(signLog),
        true,
        'signer must have been re-invoked after the bad envelope was removed',
      );
    });

    it('AC #3: aborts non-zero with an actionable message when self-verify is red', () => {
      installConsumerPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');

      const { cmd: signCmd } = installFakeSigner(root);
      const { cmd: verifyCmd, logPath: verifyLog } = installFakeVerifier(root, { valid: false });

      const r = runScript(root, {
        AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
        AI_SDLC_VERIFY_ATTESTATION_CMD: verifyCmd,
      });

      assert.notEqual(r.status, 0, 'must abort non-zero when self-verify is red');
      assert.match(r.stderr, /FAILED self-verification/i);
      assert.match(r.stderr, /DO NOT push/i);
      assert.equal(existsSync(verifyLog), true, 'verifier must have run before the abort');
    });

    it('signer invocation failure aborts with exit 2', () => {
      installConsumerPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');
      const headBefore = git(['rev-parse', 'HEAD'], root).trim();

      const { cmd } = installFakeSigner(root, { fail: true });
      const r = runScript(root, {
        AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
      });

      assert.equal(r.status, 2, `expected 2 (signer failure), got ${r.status}: ${r.stderr}`);
      assert.equal(
        git(['rev-parse', 'HEAD'], root).trim(),
        headBefore,
        'no commit must land on signer failure',
      );
    });
  });

  describe('global bypasses', () => {
    it('AI_SDLC_BYPASS_ALL_GATES=1 exits 0 immediately, even on a consumer push path ready to sign', () => {
      installConsumerPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');
      const headBefore = git(['rev-parse', 'HEAD'], root).trim();
      const { cmd, logPath } = installFakeSigner(root);

      const r = runScript(root, {
        AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
        AI_SDLC_BYPASS_ALL_GATES: '1',
      });

      assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
      assert.equal(existsSync(logPath), false, 'signer must NOT run under global bypass');
      assert.equal(git(['rev-parse', 'HEAD'], root).trim(), headBefore);
    });

    it('AI_SDLC_SKIP_ATTESTATION_SIGN=1 exits 0 immediately on a consumer push path', () => {
      installConsumerPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');
      const { cmd, logPath } = installFakeSigner(root);

      const r = runScript(root, {
        AI_SDLC_SIGN_ATTESTATION_CMD: cmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
        AI_SDLC_SKIP_ATTESTATION_SIGN: '1',
      });

      assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
      assert.equal(existsSync(logPath), false, 'signer must NOT run when skip var is set');
    });
  });

  describe('security: signer override gate (mirrors AISDLC-555)', () => {
    it('REFUSES a substitute signer unless AI_SDLC_ALLOW_SIGNER_OVERRIDE=1', () => {
      installConsumerPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');
      const headBefore = git(['rev-parse', 'HEAD'], root).trim();
      const { cmd, logPath } = installFakeSigner(root);

      const r = runScript(root, { AI_SDLC_SIGN_ATTESTATION_CMD: cmd });

      assert.equal(r.status, 2, `expected refusal exit 2, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /AI_SDLC_ALLOW_SIGNER_OVERRIDE/);
      assert.equal(existsSync(logPath), false, 'the substitute signer must NOT have run');
      assert.equal(git(['rev-parse', 'HEAD'], root).trim(), headBefore);
    });
  });

  describe('security: verifier override gate (MAJOR #1, round-2 review)', () => {
    it('(a) REFUSES to run a substitute verifier when the allow-flag is absent', () => {
      // Isolate the verifier gate by hitting it via the idempotency
      // short-circuit path (existing envelope), which calls run_self_verify
      // WITHOUT ever needing the signer override at all.
      installConsumerPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');
      const head = git(['rev-parse', 'HEAD'], root).trim();
      const attDir = join(root, '.ai-sdlc', 'attestations');
      mkdirSync(attDir, { recursive: true });
      writeFileSync(join(attDir, `${head}.v6.dsse.json`), '{"existing":true}\n');

      const { cmd: verifyCmd, logPath: verifyLog } = installFakeVerifier(root, { valid: true });

      // No AI_SDLC_ALLOW_SIGNER_OVERRIDE set at all.
      const r = runScript(root, {
        AI_SDLC_VERIFY_ATTESTATION_CMD: verifyCmd,
      });

      assert.equal(r.status, 2, `expected refusal exit 2, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /AI_SDLC_VERIFY_ATTESTATION_CMD/);
      assert.match(r.stderr, /AI_SDLC_ALLOW_SIGNER_OVERRIDE/);
      assert.equal(existsSync(verifyLog), false, 'the substitute verifier must NOT have run');
    });

    it('(b) honors the substitute verifier when AI_SDLC_ALLOW_SIGNER_OVERRIDE=1 is set', () => {
      installConsumerPushPath(root);
      writeFileSync(join(root, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(root, 'AISDLC-598');
      const head = git(['rev-parse', 'HEAD'], root).trim();
      const attDir = join(root, '.ai-sdlc', 'attestations');
      mkdirSync(attDir, { recursive: true });
      writeFileSync(join(attDir, `${head}.v6.dsse.json`), '{"existing":true}\n');

      const { cmd: verifyCmd, logPath: verifyLog } = installFakeVerifier(root, { valid: true });

      const r = runScript(root, {
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
        AI_SDLC_VERIFY_ATTESTATION_CMD: verifyCmd,
      });

      assert.equal(r.status, 0, `expected 0 (idempotent + verified), got ${r.status}: ${r.stderr}`);
      assert.equal(existsSync(verifyLog), true, 'the substitute verifier MUST have run');
    });
  });

  describe('suggestion #4: default branch auto-detection', () => {
    it('resolves the base ref via refs/remotes/origin/HEAD when set (not hardcoded origin/main)', () => {
      // Set up a repo whose default branch is `trunk`, not `main`, and point
      // refs/remotes/origin/HEAD at it the way a real `git clone` would.
      const trunkRoot = mkdtempSync(join(tmpdir(), 'ai-sdlc-sign-if-consumer-trunk-'));
      git(['init', '-q', '-b', 'trunk'], trunkRoot);
      git(['config', 'user.email', 'test@test.com'], trunkRoot);
      git(['config', 'user.name', 'test'], trunkRoot);
      git(['config', 'commit.gpgsign', 'false'], trunkRoot);
      writeFileSync(join(trunkRoot, 'README.md'), 'baseline\n');
      git(['add', '.'], trunkRoot);
      git(['commit', '-q', '-m', 'baseline'], trunkRoot);
      git(['update-ref', 'refs/remotes/origin/trunk', 'HEAD'], trunkRoot);
      git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], trunkRoot);

      installConsumerPushPath(trunkRoot);
      writeFileSync(join(trunkRoot, '.active-task'), 'AISDLC-598\n');
      writeVerdictFile(trunkRoot, 'AISDLC-598');

      const { cmd: signCmd, logPath: signLog } = installFakeSigner(trunkRoot);
      const { cmd: verifyCmd } = installFakeVerifier(trunkRoot, { valid: true });

      const r = runScript(trunkRoot, {
        AI_SDLC_SIGN_ATTESTATION_CMD: signCmd,
        AI_SDLC_ALLOW_SIGNER_OVERRIDE: '1',
        AI_SDLC_VERIFY_ATTESTATION_CMD: verifyCmd,
      });

      try {
        assert.equal(
          r.status,
          0,
          `expected 0 on a trunk-default repo, got ${r.status}: ${r.stderr}`,
        );
        assert.equal(
          existsSync(signLog),
          true,
          'signer must have run against the trunk-based repo',
        );
      } finally {
        rmSync(trunkRoot, { recursive: true, force: true });
      }
    });
  });
});
