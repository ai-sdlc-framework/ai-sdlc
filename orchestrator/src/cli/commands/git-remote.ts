/**
 * git remote parsing — extract org/repo from `git remote get-url origin`
 * to substitute into pipeline.yaml during init.
 *
 * Why this exists: AISDLC-78 — fresh installs got a literal `your-org`
 * placeholder in their pipeline.yaml, which made the file unrunnable
 * until the user noticed and edited it. We auto-detect the org/repo
 * from the git remote and only fall back to placeholders when no
 * remote is configured (e.g. a brand-new local-only repo).
 */

import { execSync } from 'node:child_process';

export interface RemoteInfo {
  /** Organization or user name. */
  org: string;
  /** Repository name (without `.git` suffix). */
  repo: string;
  /** Whether the values came from a real git remote (vs the fallback). */
  detected: boolean;
}

const FALLBACK: RemoteInfo = { org: 'your-org', repo: 'your-repo', detected: false };

/**
 * Parse a single remote URL into org/repo. Supports:
 *  - https://github.com/foo/bar.git
 *  - https://github.com/foo/bar
 *  - git@github.com:foo/bar.git
 *  - ssh://git@github.com/foo/bar.git
 *  - git@gitlab.example.com:group/subgroup/repo.git (org=group, repo=repo)
 */
export function parseRemoteUrl(url: string): RemoteInfo | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SSH shorthand: git@host:org/repo.git
  const sshShort = /^[^@\s]+@[^:\s]+:(.+?)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  if (sshShort) {
    return { org: sshShort[1].split('/').slice(-1)[0], repo: sshShort[2], detected: true };
  }

  // SSH or HTTPS with a scheme
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }
  if (parsed) {
    const path = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
    const segments = path.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const repo = segments[segments.length - 1];
      const org = segments[segments.length - 2];
      return { org, repo, detected: true };
    }
  }

  return null;
}

export interface DetectRemoteOptions {
  /** Override `execSync` for tests. */
  execImpl?: (cmd: string, opts: { cwd: string; encoding: 'utf-8'; stdio: unknown }) => string;
  /** Project directory (defaults to process.cwd). */
  cwd?: string;
}

/**
 * Detect the GitHub-style org/repo from the project's git origin remote.
 * Returns FALLBACK with detected=false when no remote is configured or
 * when the URL cannot be parsed.
 */
export function detectGitRemote(opts: DetectRemoteOptions = {}): RemoteInfo {
  const cwd = opts.cwd ?? process.cwd();
  const exec = opts.execImpl ?? defaultExec;
  let url: string;
  try {
    url = exec('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return FALLBACK;
  }
  const parsed = parseRemoteUrl(url);
  return parsed ?? FALLBACK;
}

function defaultExec(
  cmd: string,
  opts: { cwd: string; encoding: 'utf-8'; stdio: unknown },
): string {
  return execSync(cmd, {
    cwd: opts.cwd,
    encoding: opts.encoding,
    stdio: opts.stdio as Parameters<typeof execSync>[1] extends infer T
      ? T extends { stdio?: infer S }
        ? S
        : never
      : never,
  });
}

/**
 * Substitute `your-org` (and optionally `your-repo`) placeholders in a
 * template body with detected values.
 */
export function applyRemoteToPipelineYaml(template: string, info: RemoteInfo): string {
  // Replace the literal `org: your-org` config line with the detected
  // org. We deliberately match the exact YAML key shape rather than a
  // bare token so we don't smear the placeholder if it appears elsewhere.
  let out = template.replace(/(\borg:\s*)your-org(\b)/g, `$1${info.org}$2`);
  // If the template ever introduces a repo: placeholder, substitute it too.
  out = out.replace(/(\brepo:\s*)your-repo(\b)/g, `$1${info.repo}$2`);
  return out;
}
