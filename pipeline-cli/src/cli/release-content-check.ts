/**
 * `cli-release-content-check` (AISDLC-717): re-runs the release content allowlist
 * against the release-please branch. CI runs it on every push so a release PR armed
 * for auto-merge cannot merge content that was not eligible when it was armed.
 * Exit 0 when eligible, 1 with the offending path named otherwise.
 */
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { releaseContentRefusal } from '../governance/release-merge.js';

export interface ReleaseContentCheckOptions {
  argv: string[];
  runner?: Runner;
  stderr?: (text: string) => void;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

export async function runReleaseContentCheckCli(
  opts: ReleaseContentCheckOptions = { argv: process.argv.slice(2) },
): Promise<number> {
  const err = opts.stderr ?? ((t: string) => void process.stderr.write(t));
  const base = flag(opts.argv, '--base');
  const head = flag(opts.argv, '--head');
  const repo = flag(opts.argv, '--repository');
  if (!base || !head || !repo) {
    err('usage: cli-release-content-check --base <sha> --head <sha> --repository <owner/repo>\n');
    return 2;
  }
  const why = await releaseContentRefusal(base, head, repo, opts.runner ?? defaultRunner);
  if (why) {
    err(`release content check failed: ${why}\n`);
    return 1;
  }
  return 0;
}
