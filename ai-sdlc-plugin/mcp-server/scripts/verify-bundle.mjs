#!/usr/bin/env node
/**
 * CI gate for the committed `dist/bin.js` bundle.
 *
 * The plugin marketplace clones the repo source — it does NOT run
 * `pnpm install`. So the committed `dist/bin.js` MUST be:
 *   1. Present (gitignore exception in repo root .gitignore).
 *   2. Valid ESM (`node --check` passes).
 *   3. Self-contained (runs without any `node_modules/` directory).
 *   4. Fresh (matches a clean rebuild byte-for-byte).
 *
 * If any of these fail, the marketplace install of the plugin will silently
 * miss every governance hook and MCP tool — the exact regression AISDLC-75
 * fixes. This script is the regression guard.
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = resolve(__dirname, '..');
const distBin = join(pkgRoot, 'dist', 'bin.js');

function fail(msg) {
  console.error(`[verify-bundle] FAIL: ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`[verify-bundle] ok: ${msg}`);
}

// ---------- (1) presence ----------
if (!existsSync(distBin)) {
  fail(
    `${distBin} missing. The plugin manifest loads this file at runtime; ` +
      `it MUST be committed. Run \`pnpm --filter @ai-sdlc/plugin-mcp-server build\` ` +
      `and commit the result.`,
  );
}
const sizeBytes = statSync(distBin).size;
ok(`present (${(sizeBytes / 1024).toFixed(1)} KB)`);

// ---------- (2) ESM syntax ----------
const checkResult = spawnSync(process.execPath, ['--check', distBin], {
  encoding: 'utf-8',
});
if (checkResult.status !== 0) {
  fail(`node --check failed:\n${checkResult.stderr}`);
}
ok('valid ESM');

// ---------- (3) shebang + interop banner present ----------
const head = readFileSync(distBin, 'utf-8').slice(0, 400);
if (!head.startsWith('#!/usr/bin/env node')) {
  fail('missing `#!/usr/bin/env node` shebang on first line');
}
if (!head.includes('createRequire')) {
  fail('missing `createRequire` interop banner — bundled CJS deps will break');
}
ok('shebang + createRequire interop banner intact');

// ---------- (4) self-contained (runs with no node_modules) ----------
//
// Quarantine the package's node_modules in a tmpdir, run the bundle, restore.
// If the bundle imports anything Node can't resolve as a built-in, this fails.
const nm = join(pkgRoot, 'node_modules');
const quarantine = mkdtempSync(join(tmpdir(), 'ai-sdlc-verify-bundle-'));
const movedTo = join(quarantine, 'node_modules');
let restored = false;
const restore = () => {
  if (restored) return;
  if (existsSync(movedTo) && !existsSync(nm)) {
    try {
      renameSync(movedTo, nm);
    } catch (e) {
      console.error(`[verify-bundle] WARN: could not restore node_modules: ${e.message}`);
    }
  }
  try {
    rmSync(quarantine, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  restored = true;
};
process.on('exit', restore);
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

if (existsSync(nm)) {
  renameSync(nm, movedTo);
}

try {
  const result = await new Promise((res) => {
    const child = spawn(process.execPath, [distBin], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Strip env vars that might point Node back at the original node_modules
      env: { ...process.env, NODE_PATH: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const initRpc = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'verify-bundle', version: '1.0' },
      },
    });
    child.stdin.write(initRpc + '\n');
    setTimeout(() => {
      child.stdin.end();
    }, 250);
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      res({ code: -1, stdout, stderr, timedOut: true });
    }, 5000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      res({ code, stdout, stderr, timedOut: false });
    });
  });

  if (result.timedOut) {
    fail(`spawned bundle without node_modules but it hung 5s without exiting`);
  }
  if (/Cannot find (module|package)/i.test(result.stderr)) {
    fail(`bundle is NOT self-contained:\n${result.stderr}`);
  }
  if (!result.stdout.includes('"jsonrpc":"2.0"')) {
    fail(
      `bundle ran without errors but did not respond to MCP initialize.\n` +
        `stdout=${JSON.stringify(result.stdout)}\nstderr=${JSON.stringify(result.stderr)}`,
    );
  }
  ok('self-contained (responded to MCP initialize with no node_modules)');
} finally {
  restore();
}

// ---------- (5) freshness (committed bundle matches a clean rebuild) ----------
//
// We hash the current dist/bin.js and re-run the bundle script, then compare.
// If a maintainer edits source and forgets to rebuild, this fails CI.
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const beforeHash = sha256(distBin);

const rebuild = spawnSync('node', [join(pkgRoot, 'scripts', 'bundle.mjs')], {
  cwd: pkgRoot,
  encoding: 'utf-8',
});
if (rebuild.status !== 0) {
  fail(`rebuild failed:\n${rebuild.stderr || rebuild.stdout}`);
}
const afterHash = sha256(distBin);
if (beforeHash !== afterHash) {
  fail(
    `committed dist/bin.js is STALE — does not match a clean rebuild.\n` +
      `  committed: ${beforeHash}\n` +
      `  rebuilt:   ${afterHash}\n` +
      `Run \`pnpm --filter @ai-sdlc/plugin-mcp-server build\` and commit the new dist/bin.js.`,
  );
}
ok('freshness verified (committed bundle matches clean rebuild)');

console.log('[verify-bundle] all checks passed');
