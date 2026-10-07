/**
 * Tests for /ai-sdlc hierarchy (AISDLC-751) and its dispatch script.
 *
 * Run with: node --test ai-sdlc-plugin/commands/hierarchy.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, REFUSED, INSTALL_HINT } from '../scripts/hierarchy-dispatch.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const body = readFileSync(join(dir, 'hierarchy.md'), 'utf-8');

function fakeBin() {
  const d = mkdtempSync(join(tmpdir(), 'hier-'));
  writeFileSync(
    join(d, 'cli-hierarchy.mjs'),
    `const a=process.argv.slice(2);console.log(a[0]==='--help'?'FAKE HELP':'ARGS:'+JSON.stringify(a));`,
  );
  return d;
}
function capture(args, env) {
  const out = [];
  const err = [];
  const code = run(args, {
    env: { ...process.env, ...env },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('hierarchy command body', () => {
  it('has frontmatter and calls the dispatch script with $ARGUMENTS', () => {
    assert.match(body, /^---\nname: hierarchy$/m);
    assert.match(body, /hierarchy-dispatch\.mjs" \$ARGUMENTS/);
    assert.match(body, /--confirmed/);
  });
});

describe('hierarchy dispatch script', () => {
  it('passes arguments through unchanged', () => {
    const bin = fakeBin();
    try {
      const r = capture(['up', '--executors', '1', '--no-planner'], { PIPELINE_CLI_BIN: bin });
      assert.equal(r.code, 0);
      assert.equal(r.out, 'ARGS:["up","--executors","1","--no-planner"]');
    } finally {
      rmSync(bin, { recursive: true });
    }
  });

  it('passes output through (status)', () => {
    const bin = fakeBin();
    try {
      const r = capture(['status'], { PIPELINE_CLI_BIN: bin });
      assert.equal(r.code, 0);
      assert.equal(r.out, 'ARGS:["status"]');
    } finally {
      rmSync(bin, { recursive: true });
    }
  });

  it('refuses every loop-body subcommand with a one-line explanation', () => {
    assert.deepEqual(REFUSED, ['clear', 'tick', 'route-decision', 'check-sender', 'check-repo']);
    for (const sub of REFUSED) {
      const r = capture([sub, 'x'], { PIPELINE_CLI_BIN: '/nonexistent' });
      assert.equal(r.code, 2, sub);
      assert.equal(r.err.split('\n').length, 1);
      assert.match(r.err, new RegExp(`'${sub}'`));
    }
  });

  it('no arguments prints help then the recipes block', () => {
    const bin = fakeBin();
    try {
      const r = capture([], { PIPELINE_CLI_BIN: bin });
      assert.equal(r.code, 0);
      assert.match(r.out, /FAKE HELP[\s\S]*Common recipes/);
      assert.match(r.out, /up --executors 1 --no-planner/);
      assert.match(r.out, /status/);
      assert.match(r.out, /down, then up/);
    } finally {
      rmSync(bin, { recursive: true });
    }
  });

  it('prints the install hint when no bin resolves', () => {
    const d = mkdtempSync(join(tmpdir(), 'hier-res-'));
    try {
      const resolver = join(d, 'resolve.sh');
      writeFileSync(resolver, '#!/usr/bin/env bash\nexit 1\n');
      const out = [];
      const err = [];
      const code = run(['status'], {
        env: { ...process.env, PIPELINE_CLI_BIN: '' },
        resolver,
        out: (s) => out.push(s),
        err: (s) => err.push(s),
      });
      assert.equal(code, 1);
      assert.deepEqual(err, [INSTALL_HINT]);
      assert.match(INSTALL_HINT, /install-runtime-deps\.sh/);
      assert.match(INSTALL_HINT, /pnpm --filter @ai-sdlc\/pipeline-cli build/);
    } finally {
      rmSync(d, { recursive: true });
    }
  });

  it('attach and up --attach print the shell command and do not run', () => {
    const bin = fakeBin();
    try {
      const a = capture(['attach', 'executor-alpha'], { PIPELINE_CLI_BIN: bin });
      assert.equal(a.code, 0);
      assert.match(a.out, /Run this in a shell/);
      assert.match(a.out, /cli-hierarchy\.mjs" attach executor-alpha/);
      const u = capture(['up', '--attach'], { PIPELINE_CLI_BIN: bin });
      assert.match(u.out, /cli-hierarchy\.mjs" up --attach/);
    } finally {
      rmSync(bin, { recursive: true });
    }
  });

  it('down without --role needs confirmation; --confirmed and --role proceed', () => {
    const bin = fakeBin();
    try {
      assert.equal(capture(['down'], { PIPELINE_CLI_BIN: bin }).code, 3);
      const c = capture(['down', '--confirmed'], { PIPELINE_CLI_BIN: bin });
      assert.equal(c.code, 0);
      assert.equal(c.out, 'ARGS:["down"]');
      assert.equal(capture(['down', '--role', 'executor'], { PIPELINE_CLI_BIN: bin }).code, 0);
    } finally {
      rmSync(bin, { recursive: true });
    }
  });
});
