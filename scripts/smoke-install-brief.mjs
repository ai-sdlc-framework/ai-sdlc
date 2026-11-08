#!/usr/bin/env node
/**
 * First-run smoke at the brief level (AISDLC-1236, AC-4 of AISDLC-1179).
 *
 * Creates a fresh temporary git repository, feeds the published standalone
 * install brief (docs/getting-started/install-agent-brief.md) to a
 * non-interactive Claude Code session, then runs `ai-sdlc doctor` in that
 * repository and exits with doctor's pass/fail.
 *
 * Invocation recorded (printed at run time too):
 *   cwd:   the fresh temp repo
 *   claude -p --permission-mode <mode> [--model <m>]   (brief text on stdin)
 * Uses the operator's Claude Code login (subscription billing). The script
 * reads no credentials and strips ANTHROPIC_API_KEY from the child env so a
 * run never falls back to API billing. It writes only inside the temp repo.
 *
 * Usage: node scripts/smoke-install-brief.mjs [--brief <path>]
 *          [--permission-mode <mode>] [--model <name>] [--keep] [--help]
 * Exit: 0 doctor passed, 1 doctor failed, 2 usage error / run could not execute.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BRIEF = resolve(HERE, '..', 'docs/getting-started/install-agent-brief.md');
export const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

export function parseArgs(argv) {
  const opts = {
    brief: DEFAULT_BRIEF,
    permissionMode: DEFAULT_PERMISSION_MODE,
    model: null,
    keep: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === '--brief') opts.brief = resolve(value());
    else if (a === '--permission-mode') opts.permissionMode = value();
    else if (a === '--model') opts.model = value();
    else if (a === '--keep') opts.keep = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

/** Arguments for `claude`; the brief itself is passed on stdin. */
export function buildClaudeArgs(opts) {
  const args = ['-p', '--permission-mode', opts.permissionMode];
  if (opts.model) args.push('--model', opts.model);
  return args;
}

/** Map doctor's exit status to the script exit code: 0 pass, 1 fail, 2 could not run. */
export function mapExitCode(doctorStatus) {
  if (doctorStatus === 0) return 0;
  if (typeof doctorStatus === 'number') return 1;
  return 2;
}

/** Child environment without API-key fallback. */
export function childEnv(env) {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  return out;
}

const USAGE = `Usage: node scripts/smoke-install-brief.mjs [--brief <path>] [--permission-mode <mode>] [--model <name>] [--keep]`;

export function main(argv, env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  let brief;
  try {
    brief = readFileSync(opts.brief, 'utf8');
  } catch (e) {
    console.error(`cannot read brief ${opts.brief}: ${e.message}`);
    return 2;
  }
  const repo = mkdtempSync(join(tmpdir(), 'ai-sdlc-brief-smoke-'));
  const cenv = childEnv(env);
  const run = (cmd, args, input) =>
    spawnSync(cmd, args, {
      cwd: repo,
      env: cenv,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  try {
    for (const g of [
      ['init', '-q'],
      [
        '-c',
        'user.name=smoke',
        '-c',
        'user.email=smoke@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'initial',
      ],
    ]) {
      const r = run('git', g);
      if (r.status !== 0) return 2;
    }
    const claudeArgs = buildClaudeArgs(opts);
    console.log(`[smoke] cwd=${repo}\n[smoke] claude ${claudeArgs.join(' ')} < ${opts.brief}`);
    const c = run('claude', claudeArgs, brief);
    if (c.status !== 0)
      console.error(`[smoke] claude exited ${c.status ?? c.error?.message}; running doctor anyway`);
    console.log('[smoke] ai-sdlc doctor');
    const d = spawnSync('ai-sdlc', ['doctor'], { cwd: repo, env: cenv, encoding: 'utf8' });
    process.stdout.write(d.stdout ?? '');
    process.stderr.write(d.stderr ?? '');
    const code = mapExitCode(d.status);
    console.log(`[smoke] doctor ${code === 0 ? 'PASSED' : 'did not pass'} (exit ${code})`);
    return code;
  } finally {
    if (opts.keep) console.log(`[smoke] kept ${repo}`);
    else rmSync(repo, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
