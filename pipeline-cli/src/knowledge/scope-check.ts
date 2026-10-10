/**
 * Push-time scope gate (RFC-0053 OQ-1): a `protected` entry must never sit in the
 * tracked root, and the configured protected root must be git-ignored and untracked.
 * Uses the real frontmatter parser so flow-mapping, CRLF, BOM and comment forms
 * cannot slip past a line-regex.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { loadKnowledgeConfig, type KnowledgeConfig } from './config.js';
import { parseEntryFile } from './entry.js';

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isDirectory()) out.push(...listMarkdown(full));
    else if (d.isFile() && d.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

function git(projectRoot: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, out };
  } catch (err) {
    const status = (err as { status?: number }).status;
    return { ok: false, out: status === undefined ? 'error' : String(status) };
  }
}

/** Returns human-readable violations; empty means the gate passes. */
export function checkKnowledgeScope(
  projectRoot: string,
  config: KnowledgeConfig = loadKnowledgeConfig(projectRoot),
): string[] {
  const violations: string[] = [];
  const trackedAbs = isAbsolute(config.trackedRoot)
    ? config.trackedRoot
    : join(projectRoot, config.trackedRoot);
  for (const file of listMarkdown(trackedAbs)) {
    const rel = relative(projectRoot, file);
    const parsed = parseEntryFile(readFileSync(file, 'utf-8'));
    if ('error' in parsed) {
      // A file with no frontmatter is not an entry; anything else unparseable fails closed.
      if (parsed.error !== 'missing YAML frontmatter') {
        violations.push(`${rel} (unparseable frontmatter, cannot prove it is not protected)`);
      }
      continue;
    }
    const scope = parsed.fields.scope;
    if (typeof scope === 'string') {
      if (scope.trim().toLowerCase() === 'protected') {
        violations.push(`${rel} (scope: protected in tracked root)`);
      }
    } else if (scope != null) {
      violations.push(`${rel} (non-string scope, cannot prove it is not protected)`);
    }
  }

  const inRepo = git(projectRoot, ['rev-parse', '--git-dir']).ok;
  if (inRepo) {
    const root = config.protectedRoot.replace(/\/+$/, '');
    const tracked = git(projectRoot, ['ls-files', '-z', '--', root]);
    for (const f of tracked.out.split('\0').filter(Boolean)) {
      violations.push(`${f} (file under protected root is tracked by git)`);
    }
    // check-ignore exits 1 when the path is NOT ignored.
    const ignored = git(projectRoot, ['check-ignore', '-q', '--no-index', `${root}/.probe`]);
    if (!ignored.ok) {
      violations.push(`${root}/ (configured protected root is not git-ignored)`);
    }
  }
  return violations;
}
