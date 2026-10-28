/**
 * AI-SDLC format-on-write Hook (PostToolUse, matcher Edit|Write) - AISDLC-938
 *
 * Runs `prettier --write` on the single file an Edit or Write just touched, using the
 * project's installed Prettier (never a global one). No-op when the file is gone, the
 * path is excluded by .prettierignore (Prettier skips it), no Prettier config resolves,
 * or Prettier is not installed. Fails open: any error is logged to stderr, exit 0.
 * Opt out with AI_SDLC_SKIP_FORMAT_ON_WRITE=1.
 */

const { readFileSync, existsSync, statSync } = require('fs');
const { join, dirname, resolve, isAbsolute } = require('path');
const { spawnSync } = require('child_process');

const CONFIG_FILES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.json5',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
];

function hasConfig(file, root) {
  let dir = dirname(file);
  for (;;) {
    for (const name of CONFIG_FILES) if (existsSync(join(dir, name))) return true;
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf-8')).prettier) return true;
      } catch {
        /* unreadable package.json: keep walking */
      }
    }
    if (dir === root || dirname(dir) === dir) return false;
    dir = dirname(dir);
  }
}

function findPrettierBin(root) {
  try {
    const pkgPath = require.resolve('prettier/package.json', { paths: [root] });
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.prettier;
    return bin ? join(dirname(pkgPath), bin) : null;
  } catch {
    return null;
  }
}

function main() {
  if (process.env.AI_SDLC_SKIP_FORMAT_ON_WRITE === '1') return;
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    return;
  }
  if (input?.tool_name !== 'Edit' && input?.tool_name !== 'Write') return;
  const raw = input?.tool_input?.file_path;
  if (typeof raw !== 'string' || !raw) return;

  const root = resolve(input.cwd || process.cwd());
  const file = isAbsolute(raw) ? raw : resolve(root, raw);
  try {
    if (!statSync(file).isFile()) return;
  } catch {
    return;
  }
  if (!hasConfig(file, root)) return;
  const bin = findPrettierBin(root);
  if (!bin) return;

  const res = spawnSync(process.execPath, [bin, '--write', '--log-level', 'warn', file], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 20000,
  });
  if (res.error || res.status !== 0) {
    process.stderr.write(
      `[format-on-write] prettier failed for ${file}: ${(res.stderr || res.error?.message || '').trim()}\n`,
    );
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`[format-on-write] ${err?.message ?? err}\n`);
}
process.exit(0);
