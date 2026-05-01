/**
 * File-existence resolver. Handles RFC IDs, AISDLC backlog task IDs,
 * and bare repo-relative file paths.
 *
 * Resolution: walks `<workDir>` for matching files using the same
 * patterns the rest of the pipeline-cli relies on (`spec/rfcs/RFC-NNNN-*.md`,
 * `backlog/(tasks|completed)/<aisdlc-id-lower> -*.md`, plain
 * `existsSync(join(workDir, <path>))`).
 *
 * RFC-0011 §13 Q2 — pluggable resolver registry. This is the
 * file-existence resolver; sister resolvers handle GitHub issues and
 * URL HEAD.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Reference, ResolveResult, Resolver, ResolverOpts } from '../types.js';

const RFC_RE = /^RFC-\d{4}$/i;
const AISDLC_RE = /^AISDLC-\d+(?:\.\d+)?$/i;

export const fileExistenceResolver: Resolver = {
  name: 'file-existence',
  supports(ref: Reference): boolean {
    if (ref.kind === 'file-existence') return true;
    if (ref.kind === 'url' || ref.kind === 'github-issue') return false;
    const raw = ref.raw.trim();
    if (RFC_RE.test(raw)) return true;
    if (AISDLC_RE.test(raw)) return true;
    // Heuristic: looks like a repo-relative path (contains `/` and an
    // alphanumeric, ASCII only). Skip absolute paths and anything URL-y.
    if (raw.startsWith('/') || raw.startsWith('http')) return false;
    if (raw.includes('://')) return false;
    return /^[\w./-]+\/[\w./-]+$/.test(raw);
  },
  async resolve(ref: Reference, opts: ResolverOpts): Promise<ResolveResult> {
    const raw = ref.raw.trim();
    const workDir = opts.workDir;

    // RFC-NNNN — look in spec/rfcs/.
    if (RFC_RE.test(raw)) {
      const rfcDir = join(workDir, 'spec', 'rfcs');
      if (!existsSync(rfcDir)) {
        return { ref, resolved: false, reason: `no spec/rfcs/ dir under ${workDir}` };
      }
      const wanted = raw.toUpperCase();
      const entries = safeReaddir(rfcDir);
      const found = entries.some(
        (e) => e.toUpperCase().startsWith(`${wanted}-`) || e.toUpperCase().startsWith(`${wanted}.`),
      );
      return found
        ? { ref, resolved: true }
        : { ref, resolved: false, reason: `no file under spec/rfcs/ matches ${wanted}-*` };
    }

    // AISDLC-NN — look in backlog/tasks/ + backlog/completed/.
    if (AISDLC_RE.test(raw)) {
      const lower = raw.toLowerCase();
      for (const sub of ['tasks', 'completed']) {
        const dir = join(workDir, 'backlog', sub);
        if (!existsSync(dir)) continue;
        const entries = safeReaddir(dir);
        if (entries.some((e) => e.toLowerCase().startsWith(`${lower} -`))) {
          return { ref, resolved: true };
        }
      }
      return { ref, resolved: false, reason: `no backlog file matches ${lower}` };
    }

    // Bare path.
    const candidate = join(workDir, raw);
    if (existsSync(candidate)) {
      try {
        statSync(candidate);
        return { ref, resolved: true };
      } catch {
        return { ref, resolved: false, reason: `path exists but stat failed: ${raw}` };
      }
    }
    return { ref, resolved: false, reason: `no file at ${raw}` };
  },
};

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
