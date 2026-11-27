/**
 * AISDLC-1398: the MCP server launcher waits for (or runs) the runtime-dependency
 * install before starting the server, so a fresh install shows the tools on the
 * first session. Uses a stub `npm` that materialises a full tree and a stub
 * server bin.js that prints a marker to stdout.
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
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(__dirname, 'mcp-server-launcher.sh');
const SERVER_REL = '@ai-sdlc/plugin-mcp-server/dist/bin.js';
const SERVER_BODY = 'process.stdout.write("MCP_STARTED " + process.argv.slice(2).join(" "));';

const FULL_TREE = {
  '@ai-sdlc/pipeline-cli/bin/cli-deps.mjs': '//',
  '@ai-sdlc/pipeline-cli/package.json': JSON.stringify({
    dependencies: { '@ai-sdlc/reference': '1.0.0' },
  }),
  '@ai-sdlc/reference/package.json': '{}',
  [SERVER_REL]: SERVER_BODY,
  '@ai-sdlc/orchestrator/dist/runtime/attestations.js': '//',
};

function writeTree(pluginDir, tree) {
  for (const [rel, body] of Object.entries(tree)) {
    const f = join(pluginDir, 'node_modules', rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, body);
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aisdlc-1398-'));
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
  writeFileSync(treeJson, JSON.stringify(FULL_TREE));
  writeFileSync(
    join(binDir, 'npm'),
    `#!/usr/bin/env bash
[ "$1" = "view" ] && exit 1
echo run >> "${log}"
echo "npm stub output line"
node -e '
const fs=require("fs"),p=require("path");
const tree=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for(const [rel,body] of Object.entries(tree)){const f=p.join(process.argv[2],"node_modules",rel);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,body);}
' "${treeJson}" "${pluginDir}"
`,
  );
  chmodSync(join(binDir, 'npm'), 0o755);
  const env = {
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: process.env.HOME,
    CLAUDE_PLUGIN_ROOT: pluginDir,
  };
  return { root, pluginDir, log, env, lock: join(pluginDir, '.ai-sdlc-install.lock') };
}

function launch(c, { timeout, args = [] } = {}) {
  const env = { ...c.env };
  if (timeout !== undefined) env.AI_SDLC_MCP_LAUNCH_TIMEOUT = String(timeout);
  const started = Date.now();
  const p = spawn('bash', [LAUNCHER, ...args], { env });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve) =>
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - started })),
  );
  return { done };
}

/** A live process to stand in for an installer that holds the lock. */
function liveHolder() {
  const h = spawn('sleep', ['60']);
  return h;
}

const npmRuns = (c) =>
  existsSync(c.log) ? readFileSync(c.log, 'utf-8').trim().split('\n').filter(Boolean).length : 0;

describe('AISDLC-1398 MCP server launcher', () => {
  it('AC1: with bin.js present, starts the server at once without installing', async () => {
    const c = setup();
    try {
      writeTree(c.pluginDir, FULL_TREE);
      const r = await launch(c, { args: ['--flag'] }).done;
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, 'MCP_STARTED --flag');
      assert.equal(r.err, '', 'no wait or install message on the fast path');
      assert.equal(npmRuns(c), 0);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('AC2: with the install in progress (lock held), waits and starts the server when it completes', async () => {
    const c = setup();
    const holder = liveHolder();
    try {
      writeFileSync(c.lock, `${holder.pid}\n`);
      const run = launch(c, { timeout: 30 });
      await new Promise((r) => setTimeout(r, 800));
      // The other installer finishes: tree lands, lock is released.
      writeTree(c.pluginDir, FULL_TREE);
      rmSync(c.lock);
      const r = await run.done;
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, 'MCP_STARTED ');
      assert.match(r.err, /install in progress/);
      assert.ok(r.ms >= 700, `launcher waited for the install (${r.ms}ms)`);
      assert.equal(npmRuns(c), 0, 'the launcher must not start a second install');
    } finally {
      holder.kill();
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('AC2: waits for a held lock even when an older bin.js is present', async () => {
    const c = setup();
    const holder = liveHolder();
    try {
      writeTree(c.pluginDir, FULL_TREE);
      writeFileSync(c.lock, `${holder.pid}\n`);
      const run = launch(c, { timeout: 30 });
      await new Promise((r) => setTimeout(r, 500));
      rmSync(c.lock);
      const r = await run.done;
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, 'MCP_STARTED ');
      assert.match(r.err, /install in progress/);
    } finally {
      holder.kill();
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('AC3: with no install running and modules missing, runs the install under the lock, then starts the server', async () => {
    const c = setup();
    try {
      const r = await launch(c, { timeout: 60 }).done;
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, 'MCP_STARTED ', 'install output must not reach the MCP stdout channel');
      assert.equal(npmRuns(c), 1);
      assert.match(r.err, /no install running; installing runtime dependencies/);
      assert.match(r.err, /npm stub output line/);
      assert.ok(!existsSync(c.lock), 'the installer releases its lock');
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('AC3: a lock left by a dead pid does not block; the install runs and the server starts', async () => {
    const c = setup();
    try {
      writeFileSync(c.lock, '999999\n');
      const r = await launch(c, { timeout: 60 }).done;
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, 'MCP_STARTED ');
      assert.equal(npmRuns(c), 1);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('AC4: past the bound while the lock is held, exits non-zero with a reason on stderr', async () => {
    const c = setup();
    const holder = liveHolder();
    try {
      writeFileSync(c.lock, `${holder.pid}\n`);
      const r = await launch(c, { timeout: 1 }).done;
      assert.notEqual(r.code, 0);
      assert.equal(r.out, '');
      assert.match(r.err, /gave up after 1s waiting for the runtime dependency install/);
    } finally {
      holder.kill();
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('AC4: a failed install exits non-zero with a reason on stderr', async () => {
    const c = setup();
    try {
      writeFileSync(join(c.root, 'tree.json'), JSON.stringify({ 'x/y.js': '//' }));
      const r = await launch(c, { timeout: 60 }).done;
      assert.notEqual(r.code, 0);
      assert.equal(r.out, '');
      assert.match(r.err, /is still missing; the MCP server was not started/);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('AC4: an install that outlasts the bound is stopped and the launcher exits non-zero', async () => {
    const c = setup();
    try {
      writeFileSync(
        join(c.root, 'bin', 'npm'),
        '#!/usr/bin/env bash\n[ "$1" = "view" ] && exit 1\nsleep 30\n',
      );
      const r = await launch(c, { timeout: 2 }).done;
      assert.notEqual(r.code, 0);
      assert.match(r.err, /gave up after 2s: the runtime dependency install did not finish/);
      assert.ok(r.ms < 15_000, `bounded (${r.ms}ms)`);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('both plugin manifests start the MCP server through the launcher', () => {
    for (const rel of ['plugin.json', '.claude-plugin/plugin.json']) {
      const m = JSON.parse(readFileSync(join(__dirname, '..', rel), 'utf-8'));
      assert.deepEqual(
        { command: m.mcpServers['ai-sdlc'].command, args: m.mcpServers['ai-sdlc'].args },
        { command: 'bash', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server-launcher.sh'] },
        rel,
      );
    }
  });
});
