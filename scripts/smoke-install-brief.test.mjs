/**
 * Tests for the install-brief smoke script (AISDLC-1236).
 * Run with: node --test scripts/smoke-install-brief.test.mjs
 * Never invokes `claude`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs,
  buildClaudeArgs,
  mapExitCode,
  childEnv,
  main,
  findUnknownKeyringKeys,
  DEFAULT_BRIEF,
  DEFAULT_PERMISSION_MODE,
} from './smoke-install-brief.mjs';

describe('parseArgs', () => {
  it('defaults to the published brief and bypassPermissions', () => {
    const o = parseArgs([]);
    assert.equal(o.brief, DEFAULT_BRIEF);
    assert.ok(existsSync(o.brief));
    assert.equal(o.permissionMode, DEFAULT_PERMISSION_MODE);
    assert.equal(o.keep, false);
  });
  it('parses all flags', () => {
    const o = parseArgs([
      '--brief',
      '/x/b.md',
      '--permission-mode',
      'acceptEdits',
      '--model',
      'sonnet',
      '--keep',
      '-h',
    ]);
    assert.deepEqual(o, {
      brief: '/x/b.md',
      permissionMode: 'acceptEdits',
      model: 'sonnet',
      keep: true,
      help: true,
    });
  });
  it('rejects unknown and valueless flags', () => {
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
    assert.throws(() => parseArgs(['--brief']), /requires a value/);
    assert.throws(() => parseArgs(['--model', '--keep']), /requires a value/);
  });
});

describe('buildClaudeArgs', () => {
  it('passes -p and permission mode, optional model', () => {
    assert.deepEqual(buildClaudeArgs({ permissionMode: 'm', model: null }), [
      '-p',
      '--permission-mode',
      'm',
    ]);
    assert.deepEqual(buildClaudeArgs({ permissionMode: 'm', model: 'x' }), [
      '-p',
      '--permission-mode',
      'm',
      '--model',
      'x',
    ]);
  });
});

describe('mapExitCode', () => {
  it('maps doctor status', () => {
    assert.equal(mapExitCode(0), 0);
    assert.equal(mapExitCode(1), 1);
    assert.equal(mapExitCode(7), 1);
    assert.equal(mapExitCode(null), 2);
  });
});

describe('childEnv', () => {
  it('drops ANTHROPIC_API_KEY only', () => {
    const e = childEnv({ ANTHROPIC_API_KEY: 'k', PATH: '/p' });
    assert.deepEqual(e, { PATH: '/p' });
  });
});

describe('main (no claude invoked)', () => {
  it('prints usage with --help and returns 0', () => {
    assert.equal(main(['--help']), 0);
  });
  it('returns 2 on a bad argument', () => {
    assert.equal(main(['--bogus']), 2);
  });
  it('returns 2 when the brief is unreadable', () => {
    assert.equal(main(['--brief', join(mkdtempSync(join(tmpdir(), 'smk-')), 'missing.md')]), 2);
  });
  it('maps a stub claude + stub doctor on PATH to exit codes', () => {
    const bin = mkdtempSync(join(tmpdir(), 'smk-bin-'));
    const brief = join(bin, 'brief.md');
    writeFileSync(brief, 'brief');
    const stub = (name, code) => {
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\n[ "$1" = doctor ] || cat >/dev/null\nexit ${code}\n`,
        { mode: 0o755 },
      );
    };
    stub('claude', 0);
    stub('ai-sdlc', 0);
    const env = { PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: 'k' };
    assert.equal(main(['--brief', brief], env), 0);
    stub('ai-sdlc', 3);
    assert.equal(main(['--brief', brief], env), 1);
  });
});

describe('keyring block key names (AISDLC-1239)', () => {
  it('flags a key outside the trusted-reviewers schema', () => {
    assert.deepEqual(findUnknownKeyringKeys('paste it under `signingKeys:`'), ['signingKeys']);
    assert.deepEqual(findUnknownKeyringKeys('paste it under `reviewers:`'), []);
  });
  it('the shipped docs use only schema keys and no stale signingKeys', () => {
    for (const f of [
      'docs/getting-started/install-agent-brief.md',
      'docs/getting-started/onboarding.md',
      'docs/ucvg-test-repo-setup/signing-key-setup.md',
    ]) {
      const text = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
      assert.deepEqual(findUnknownKeyringKeys(text), [], f);
      assert.ok(!text.includes('signingKeys'), f);
    }
  });
  it('the brief commit step lists .gitignore', () => {
    assert.match(readFileSync(DEFAULT_BRIEF, 'utf8'), /git add [^`]*\.gitignore/);
  });
});
