/**
 * `cli-init` — scaffold the required consumer configuration (AISDLC-910).
 *
 *   cli-init [--project-dir <dir>] [--non-interactive] [--force]
 *   cli-init --check [--format json]   report missing entries (doctor, SessionStart)
 *   cli-init --fix                     scaffold entries that need no operator input
 *
 * Everything comes from `REQUIRED_CONFIG_MANIFEST`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  configVersionNotice,
  formatMissingConfig,
  formatMissingEntry,
  missingConfigEntries,
  missingConfigRemediation,
  scaffoldConfig,
  type PromptFn,
} from '../config-manifest/manifest.js';

function git(projectDir: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

/** Defaults an operator would otherwise type: git remote, git email, local public key. */
export function gatherDefaults(projectDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const remote = git(projectDir, ['remote', 'get-url', 'origin']);
  const m = remote.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (m) {
    out.org = m[1];
    out.repo = m[2];
  }
  const email = git(projectDir, ['config', 'user.email']);
  if (email) out.identity = email;
  const keyPath = join(homedir(), '.ai-sdlc', 'signing-key.pub.pem');
  if (existsSync(keyPath)) out.pubkey = readFileSync(keyPath, 'utf8');
  return out;
}

export async function runInitCli(argv: string[] = hideBin(process.argv)): Promise<number> {
  const args = await yargs(argv)
    .option('project-dir', { type: 'string', default: process.cwd() })
    .option('non-interactive', { type: 'boolean', default: false })
    .option('force', { type: 'boolean', default: false })
    .option('check', { type: 'boolean', default: false })
    .option('fix', { type: 'boolean', default: false })
    .option('notice', { type: 'boolean', default: false })
    .option('format', { type: 'string', choices: ['text', 'json'], default: 'text' })
    .strict()
    .help()
    .parseAsync();
  const projectDir = resolve(args['project-dir']);

  if (args.notice) {
    const n = configVersionNotice(projectDir);
    if (n) process.stdout.write(`${n}\n`);
    return 0;
  }

  if (args.check) {
    const missing = missingConfigEntries(projectDir);
    if (args.format === 'json') {
      process.stdout.write(
        `${JSON.stringify({
          missing: missing.map((e) => ({
            id: e.id,
            path: e.path,
            since: e.since,
            operatorInput: e.operatorInput,
            title: formatMissingEntry(e),
          })),
          remediation: missingConfigRemediation(),
        })}\n`,
      );
    } else if (missing.length > 0) {
      process.stdout.write(`${formatMissingConfig(missing)}\n`);
    }
    return missing.length === 0 ? 0 : 1;
  }

  const defaults = gatherDefaults(projectDir);
  const interactive = !args['non-interactive'] && !args.fix && process.stdin.isTTY === true;
  let prompt: PromptFn | undefined;
  let rl: ReturnType<typeof createInterface> | undefined;
  if (interactive) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    prompt = async (q, def) => {
      const shown = def && def.length < 60 && !def.includes('\n') ? ` [${def}]` : '';
      const a = (await rl!.question(`${q}${shown}: `)).trim();
      return a || def || '';
    };
  }
  try {
    const res = await scaffoldConfig({
      projectDir,
      defaults,
      force: args.force,
      skipOperatorInput: args.fix,
      ...(prompt ? { prompt } : {}),
    });
    for (const p of res.created) process.stdout.write(`created ${p}\n`);
    for (const p of res.skipped) process.stdout.write(`exists  ${p}\n`);
    for (const f of res.failed) {
      process.stderr.write(`failed  ${f.path}: ${f.reason}\n`);
    }
    return res.failed.length === 0 ? 0 : 1;
  } finally {
    rl?.close();
  }
}
