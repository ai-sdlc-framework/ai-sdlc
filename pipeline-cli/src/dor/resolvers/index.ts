/**
 * Resolver registry — RFC-0011 §13 Q2 pluggable design.
 *
 * `extractReferences()` walks a markdown body and emits a tagged list
 * of references; `resolveReference()` dispatches each tagged reference
 * to the registered resolver that handles its shape.
 *
 * Registry order matters: resolvers earlier in the list win the
 * `supports()` check. We keep github-issue first because `#NN` would
 * otherwise be mistaken for a bare path by some heuristics.
 */

import { fileExistenceResolver } from './file-existence.js';
import { githubIssueResolver } from './github-issue.js';
import { urlHeadResolver } from './url-head.js';
import type { Reference, ResolveResult, Resolver, ResolverOpts } from '../types.js';

export { fileExistenceResolver } from './file-existence.js';
export { githubIssueResolver } from './github-issue.js';
export { urlHeadResolver } from './url-head.js';

/**
 * Default resolver registry — the 3 resolvers RFC-0011 Phase 2a ships
 * with. Future shims (Linear, Forge, Slack) plug in at this list.
 */
export const DEFAULT_RESOLVERS: Resolver[] = [
  githubIssueResolver,
  fileExistenceResolver,
  urlHeadResolver,
];

/**
 * Dispatch a reference to the first resolver in the registry that
 * supports it. Returns `{resolved: false, reason: 'no resolver registered'}`
 * when no resolver matches — the rubric treats unresolvable references
 * as gate-3 failures.
 */
export async function resolveReference(
  ref: Reference,
  opts: ResolverOpts,
  resolvers: Resolver[] = DEFAULT_RESOLVERS,
): Promise<ResolveResult> {
  for (const r of resolvers) {
    if (r.supports(ref)) {
      try {
        return await r.resolve(ref, opts);
      } catch (err) {
        return {
          ref,
          resolved: false,
          reason: `${r.name} resolver threw: ${(err as Error).message}`,
        };
      }
    }
  }
  return { ref, resolved: false, reason: 'no resolver registered for reference shape' };
}

/**
 * Markdown link / bare reference extractor used by Gate 3.
 *
 * Recognises:
 *   - `[label](https://...)` markdown links (URL kind)
 *   - bare `https://...` URLs in text (URL kind, github-issue takes precedence
 *     for github.com/.../issues/ + /pull/ paths)
 *   - GitHub issue refs `#42`, `gh#42`, `owner/repo#42`
 *   - RFC IDs `RFC-NNNN`
 *   - AISDLC backlog IDs `AISDLC-NN`
 *   - Backtick-quoted repo paths (`pipeline-cli/src/foo.ts`) — file kind
 *
 * Returns a stable, deduped list of tagged references.
 */
export function extractReferences(body: string): Reference[] {
  const seen = new Set<string>();
  const out: Reference[] = [];

  function add(raw: string, kind: Reference['kind']): void {
    const key = `${kind}:${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ raw, kind });
  }

  // 1. Markdown links: [label](url) — capture the URL only.
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const url = m[1];
    if (/^https?:\/\//i.test(url)) {
      add(url, classifyUrl(url));
    } else {
      // Relative link inside markdown — treat as repo file path.
      add(url, 'file-existence');
    }
  }

  // 2. Bare URLs not already captured — `(?<!\()` to skip the markdown-link case.
  for (const m of body.matchAll(/(?<!\()(https?:\/\/\S+)/g)) {
    const url = m[1].replace(/[)),.;:]+$/g, '');
    add(url, classifyUrl(url));
  }

  // 3. GitHub issue refs `#42`, `gh#42`, `owner/repo#42`.
  for (const m of body.matchAll(/(?<![\w/])((?:gh)?#\d+)\b/gi)) {
    add(m[1], 'github-issue');
  }
  for (const m of body.matchAll(/\b([\w.-]+\/[\w.-]+#\d+)\b/g)) {
    add(m[1], 'github-issue');
  }

  // 4. RFC IDs.
  for (const m of body.matchAll(/\b(RFC-\d{4})\b/g)) {
    add(m[1], 'file-existence');
  }

  // 5. AISDLC IDs.
  for (const m of body.matchAll(/\b(AISDLC-\d+(?:\.\d+)?)\b/g)) {
    add(m[1], 'file-existence');
  }

  // 6. Backtick-quoted repo paths.
  for (const m of body.matchAll(/`([\w./-]+\/[\w./-]+\.[a-zA-Z0-9]+)`/g)) {
    add(m[1], 'file-existence');
  }

  return out;
}

function classifyUrl(url: string): Reference['kind'] {
  if (/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+/i.test(url)) {
    return 'github-issue';
  }
  return 'url';
}
