/**
 * AISDLC-1084: install lock, full-closure health check, and clean-reinstall self-heal.
 * Uses a stub `npm` that materialises a full tree (including @ai-sdlc/reference).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'install-runtime-deps.sh');
const { checkRuntimeDepsHealth } = createRequire(import.meta.url)('./lib/runtime-deps-health.js');

const FULL_TREE = {
  '@ai-sdlc/pipeline-cli/bin/cli-deps.mjs': '//',
  '@ai-sdlc/pipeline-cli/package.json': JSON.stringify({
    dependencies: { '@ai-sdlc/reference': '1.0.0' },
  }),
  '@ai-sdlc/reference/package.json': '{}',
  '@ai-sdlc/plugin-mcp-server/dist/bin.js': '//',
  '@ai-sdlc/orchestrator/dist/runtime/attestations.js': '//',
};

function writeTree(pluginDir, tree) {
  for (const [rel, body] of Object.entries(tree)) {
    const f = join(pluginDir, 'node_modules', rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, body);
  }
}

function setup({ sleep = 0, brokenInstall = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aisdlc-1084-'));
  const pluginDir = join(root, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      runtimeDependencies: {
        '@ai-sdlc/pipeline-cli': '1.0.0',
        '@ai-sdlc/plugin-mcp-server': '1.0.0',
        '@ai-sdlc/orchestrator': '1.0.0',
      },
    }),
  );
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  const log = join(root, 'npm.log');
  const treeJson = join(root, 'tree.json');
  writeFileSync(
    treeJson,
    JSON.stringify(brokenInstall ? { '@ai-sdlc/pipeline-cli/bin/cli-deps.mjs': '//' } : FULL_TREE),
  );
  writeFileSync(
    join(binDir, 'npm'),
    `#!/usr/bin/env bash
[ "$1" = "view" ] && exit 1
echo run >> "${log}"
sleep ${sleep}
echo "npm stub output line" 
node -e '
const fs=require("fs"),p=require("path");
const tree=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for(const [rel,body] of Object.entries(tree)){const f=p.join(process.argv[2],"node_modules",rel);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,body);}
' "${treeJson}" "${pluginDir}"
`,
  );
  chmodSync(join(binDir, 'npm'), 0o755);
  const env = { PATH: `${binDir}:${process.env.PATH}`, HOME: process.env.HOME };
  return { root, pluginDir, log, env };
}

const runSync = (c) =>
  spawnSync('bash', [SCRIPT, c.pluginDir], { env: c.env, encoding: 'utf-8', timeout: 30_000 });

function runAsync(c) {
  return new Promise((resolve) => {
    const p = spawn('bash', [SCRIPT, c.pluginDir], { env: c.env });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, err }));
  });
}

const npmRuns = (c) =>
  existsSync(c.log) ? readFileSync(c.log, 'utf-8').trim().split('\n').filter(Boolean).length : 0;

describe('AISDLC-1084 runtime-deps health + installer', () => {
  it('AC1: two concurrent installers produce one npm install and a healthy tree', async () => {
    const c = setup({ sleep: 2 });
    try {
      const [a, b] = await Promise.all([runAsync(c), runAsync(c)]);
      assert.equal(a.code, 0);
      assert.equal(b.code, 0);
      assert.equal(npmRuns(c), 1);
      const err = a.err + b.err;
      assert.equal(err.match(/installed successfully/g)?.length, 1);
      assert.equal(err.match(/waited for lock/g)?.length, 1);
      assert.ok(checkRuntimeDepsHealth(c.pluginDir).healthy);
      assert.ok(!existsSync(join(c.pluginDir, '.ai-sdlc-install.lock')));
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('AC2: pipeline-cli present but @ai-sdlc/reference absent is unhealthy and healed without --force', () => {
    const c = setup();
    try {
      const partial = { ...FULL_TREE };
      delete partial['@ai-sdlc/reference/package.json'];
      writeTree(c.pluginDir, partial);
      const h = checkRuntimeDepsHealth(c.pluginDir);
      assert.equal(h.healthy, false);
      assert.equal(h.missing[0].pkg, '@ai-sdlc/reference');
      const r = runSync(c);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(npmRuns(c), 1);
      assert.ok(checkRuntimeDepsHealth(c.pluginDir).healthy);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('AC3: a deleted plugin-mcp-server dist/bin.js is healed without --force', () => {
    const c = setup();
    try {
      writeTree(c.pluginDir, FULL_TREE);
      rmSync(join(c.pluginDir, 'node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js'));
      const r = runSync(c);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        existsSync(join(c.pluginDir, 'node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js')),
      );
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('a healthy tree is a no-op (no npm run)', () => {
    const c = setup();
    try {
      writeTree(c.pluginDir, FULL_TREE);
      const r = runSync(c);
      assert.equal(r.status, 0);
      assert.equal(npmRuns(c), 0);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('AC4: failed heal names the missing package and file and includes the npm output tail', () => {
    const c = setup({ brokenInstall: true });
    try {
      const r = runSync(c);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /@ai-sdlc\/plugin-mcp-server \(expected .*dist\/bin\.js\)/);
      assert.match(r.stderr, /npm output tail/);
      assert.match(r.stderr, /npm stub output line/);
      assert.equal(npmRuns(c), 2, 'one clean retry after the first attempt');
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('removes a lock left by a dead pid', () => {
    const c = setup();
    try {
      mkdirSync(join(c.pluginDir, '.ai-sdlc-install.lock'));
      writeFileSync(join(c.pluginDir, '.ai-sdlc-install.lock', 'pid'), '999999');
      const r = runSync(c);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /stale install lock/);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });
});
