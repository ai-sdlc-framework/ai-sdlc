/**
 * AISDLC-1449 (DEC-0440 option b): an RFC that declares `reviewAuthorities` in its
 * frontmatter is never merged by the machine. Every automatic merge path goes through
 * `runMergeIfEligible`, which calls `reviewAuthorityRefusal` once the PR's changed files
 * are known. The declaration is read from the BASE commit, never the PR head, so a PR
 * cannot remove the declaration and then merge itself. The only release is the
 * operator's hand merge once the declared authorities have replied.
 *
 * Opt-in: an RFC with no `reviewAuthorities` (or an empty list) is not affected, so an
 * adopter with no declarations sees no change in behaviour.
 */

import { load as loadYaml } from 'js-yaml';

/** One declared review authority: the role that owns the area, and optionally its GitHub login. */
export interface ReviewAuthority {
  role: string;
  login?: string;
}

/** The closing words of every refusal; the reconciler and lander recognise a hold by them. */
export const REVIEW_AUTHORITY_HOLD_SUFFIX = 'merge by hand after they reply (DEC-0440)';

/** True when a merge-gate refusal text is a review-authority hold. */
export function isReviewAuthorityHold(text: string | undefined): boolean {
  return typeof text === 'string' && text.includes(REVIEW_AUTHORITY_HOLD_SUFFIX);
}

/** RFC files the hold applies to (the template included: it never declares authorities). */
export const RFC_FILE_RE = /^spec\/rfcs\/RFC-[^/]+\.md$/;

const LOGIN_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export type ParsedAuthorities =
  { ok: true; authorities: ReviewAuthority[] } | { ok: false; error: string };

/**
 * Validate a `reviewAuthorities` value. `undefined` (field absent) is an empty list;
 * anything else must be a list of mappings with a non-empty string `role` and an
 * optional GitHub `login`.
 */
export function validateReviewAuthorities(value: unknown): ParsedAuthorities {
  if (value === undefined || value === null) return { ok: true, authorities: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: "'reviewAuthorities' must be a list of { role, login? } entries" };
  }
  const authorities: ReviewAuthority[] = [];
  for (const [i, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `'reviewAuthorities' entry ${i + 1} must be a mapping` };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['role'] !== 'string' || e['role'].trim() === '') {
      return { ok: false, error: `'reviewAuthorities' entry ${i + 1} is missing 'role'` };
    }
    const login = e['login'];
    if (login !== undefined && (typeof login !== 'string' || !LOGIN_RE.test(login))) {
      return {
        ok: false,
        error: `'reviewAuthorities' entry ${i + 1} has an invalid 'login' (expected a GitHub login)`,
      };
    }
    authorities.push({ role: e['role'].trim(), ...(login === undefined ? {} : { login }) });
  }
  return { ok: true, authorities };
}

/**
 * The `reviewAuthorities` an RFC source declares. A file with no frontmatter declares
 * none; a frontmatter that is unclosed, not a mapping or not valid YAML is an error.
 */
export function parseReviewAuthorities(source: string): ParsedAuthorities {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { ok: true, authorities: [] };
  let end = text.indexOf('\n---\n', 4);
  if (end === -1 && text.endsWith('\n---')) end = text.length - 4;
  if (end === -1) return { ok: false, error: 'the frontmatter has no closing --- fence' };
  const block = text.slice(4, end);
  // js-yaml refuses an empty document; a frontmatter of blanks and comments declares nothing.
  if (block.split('\n').every((l) => l.trim() === '' || l.trim().startsWith('#'))) {
    return { ok: true, authorities: [] };
  }
  let parsed: unknown;
  try {
    parsed = loadYaml(block);
  } catch {
    return { ok: false, error: 'the frontmatter is not valid YAML' };
  }
  if (parsed === undefined || parsed === null) return { ok: true, authorities: [] };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'the frontmatter is not a mapping' };
  }
  return validateReviewAuthorities((parsed as Record<string, unknown>)['reviewAuthorities']);
}

/** One changed file, as the compare endpoint reports it. */
export interface ChangedPath {
  path: string;
  previousPath?: string;
  status: string;
}

/**
 * RFC paths whose base copy this change touches: a modified or removed RFC at its
 * own path, a renamed RFC at its previous path. A newly added or copied file has no
 * base copy that changes, so it is not listed.
 */
export function rfcBasePaths(files: readonly ChangedPath[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.status === 'added' || f.status === 'copied') continue;
    const base = f.status === 'renamed' && f.previousPath !== undefined ? f.previousPath : f.path;
    if (RFC_FILE_RE.test(base) && !out.includes(base)) out.push(base);
  }
  return out;
}

function rfcName(path: string): string {
  return /RFC-\d+/.exec(path)?.[0] ?? path;
}

function describe(a: ReviewAuthority): string {
  return a.login ? `${a.role} (${a.login})` : a.role;
}

/**
 * The refusal for a change to an RFC whose base copy declares review authorities, or
 * `null` when none does. `readBase(path)` returns the base copy, or `null` when it
 * cannot be read; an unreadable or unparseable base copy refuses (fail closed).
 */
export async function reviewAuthorityRefusal(
  files: readonly ChangedPath[],
  readBase: (path: string) => Promise<string | null>,
): Promise<string | null> {
  const held: string[] = [];
  for (const path of rfcBasePaths(files)) {
    let source: string | null;
    try {
      source = await readBase(path);
    } catch {
      source = null;
    }
    if (source === null) {
      held.push(`${path}: the base copy could not be read, so its review authorities are unknown`);
      continue;
    }
    const parsed = parseReviewAuthorities(source);
    if (!parsed.ok) {
      held.push(`${path}: the base copy could not be parsed (${parsed.error})`);
      continue;
    }
    if (parsed.authorities.length > 0) {
      held.push(
        `${rfcName(path)} (${path}) declares review authorities ${parsed.authorities.map(describe).join(', ')}`,
      );
    }
  }
  if (held.length === 0) return null;
  return (
    `PR changes an RFC held for review authorities: ${held.join('; ')} — ` +
    REVIEW_AUTHORITY_HOLD_SUFFIX
  );
}
