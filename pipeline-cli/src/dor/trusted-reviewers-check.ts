/**
 * Trusted-reviewer membership check (RFC-0009 + RFC-0011 §7.4).
 *
 * The DoR `dor-bypass` label handler (Phase 6 / AISDLC-115.7) uses this
 * module to decide whether the actor who applied the label is allowed to
 * bypass the gate. We DO NOT verify the DSSE signature here — the
 * attestation verifier (`scripts/verify-attestation.mjs`) already covers
 * the cryptographic side. The bypass-label flow only needs to know
 * "is this actor named in `.ai-sdlc/trusted-reviewers.yaml`?" which the
 * GitHub Action / orchestration layer can then combine with its own
 * actor authentication (the actor identity comes from a verified token,
 * not user input).
 *
 * Implementation notes:
 *
 *   - The trusted-reviewers file lives under `.ai-sdlc/` and ships a
 *     handcrafted YAML loader (per file header — `scripts/verify-
 *     attestation.mjs` keeps the install footprint minimal). We mirror
 *     the same minimal-loader approach here so this check can run from
 *     any TypeScript context (CLI, GitHub Action, Claude Code subagent)
 *     without pulling in `js-yaml`.
 *   - Identities in the file are free-form strings (typically email or
 *     GitHub handle). The caller is responsible for passing the right
 *     identity shape — we only do exact-match lookup.
 *   - The file's "role" axis is implicit today: every entry in
 *     `reviewers:` is a maintainer (the trust grant is uniform — adding
 *     someone is a maintainer-reviewed PR). Phase 6 keeps that contract;
 *     when RFC-0009 grows finer-grained roles, this module's
 *     `requiredRole` parameter is the extension point.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TrustedReviewer {
  /** Free-form identity (typically email or GitHub handle). */
  identity: string;
  /** Free-form machine label — one identity may register multiple keys. */
  machine?: string;
  /** ISO-8601 date the entry was added. */
  addedAt?: string;
  /** GitHub handle of the maintainer who approved this entry's PR. */
  addedBy?: string;
}

export interface LoadTrustedReviewersOpts {
  /** Project root. Defaults to `process.cwd()`. */
  workDir?: string;
  /** Override the on-disk path entirely (tests). */
  filePath?: string;
}

/**
 * Resolve the canonical path: explicit override > `<workDir>/.ai-sdlc/
 * trusted-reviewers.yaml`.
 */
export function resolveTrustedReviewersPath(opts: LoadTrustedReviewersOpts = {}): string {
  if (opts.filePath) return opts.filePath;
  const workDir = opts.workDir ?? process.cwd();
  return join(workDir, '.ai-sdlc', 'trusted-reviewers.yaml');
}

/**
 * Load + parse the trusted-reviewers list. Returns `[]` when the file is
 * missing — a brand-new repo has no trusted reviewers and bypass MUST
 * therefore be denied (the safe default; no actor can pass the role check).
 */
export function loadTrustedReviewers(opts: LoadTrustedReviewersOpts = {}): TrustedReviewer[] {
  const path = resolveTrustedReviewersPath(opts);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  return parseTrustedReviewersYaml(raw);
}

/**
 * Parse the trusted-reviewers YAML subset. Public so tests can drive the
 * parser without touching the filesystem.
 *
 * Supported shape (per the file header in `.ai-sdlc/trusted-reviewers.yaml`):
 *
 *   reviewers:
 *     - identity: 'a@b.com'
 *       machine: 'doms-macbook'
 *       addedAt: '2026-04-28'
 *       addedBy: 'deefactorial'
 *       pubkey: |
 *         -----BEGIN PUBLIC KEY-----
 *         ...
 *         -----END PUBLIC KEY-----
 *     - identity: 'ci-attestor'
 *       ...
 *
 * We DO NOT extract `pubkey:` block scalars — the cryptographic surface
 * is the verifier's job. This loader cares only about the identity rows.
 */
export function parseTrustedReviewersYaml(yaml: string): TrustedReviewer[] {
  const out: TrustedReviewer[] = [];
  const lines = yaml.split('\n');

  let inReviewers = false;
  let current: Partial<TrustedReviewer> | null = null;
  // True when the current line is inside a `pubkey: |` block scalar — we
  // skip those lines entirely so they can't be misread as identity entries.
  let inBlockScalar = false;
  let blockScalarIndent = -1;

  const flush = (): void => {
    if (current && current.identity) {
      out.push({ ...current } as TrustedReviewer);
    }
    current = null;
  };

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    if (inBlockScalar) {
      const indent = rawLine.length - rawLine.trimStart().length;
      // Block scalar continues while the line is indented strictly deeper
      // than the key that opened it. The first less-indented line ends it.
      if (indent > blockScalarIndent) continue;
      inBlockScalar = false;
      blockScalarIndent = -1;
      // Fall through to process this line normally.
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();

    if (!inReviewers) {
      if (/^reviewers:\s*$/.test(trimmed)) {
        inReviewers = true;
      }
      continue;
    }

    // A new top-level key (indent 0) ends the reviewers section.
    if (indent === 0 && !trimmed.startsWith('-')) {
      flush();
      inReviewers = false;
      continue;
    }

    if (trimmed.startsWith('- ')) {
      flush();
      current = {};
      const after = trimmed.slice(2);
      const colonIdx = after.indexOf(':');
      if (colonIdx > 0) {
        applyField(current, after.slice(0, colonIdx).trim(), after.slice(colonIdx + 1).trim(), {
          openBlock: () => {
            inBlockScalar = true;
            blockScalarIndent = indent;
          },
        });
      }
      continue;
    }

    if (!current) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    applyField(current, key, value, {
      openBlock: () => {
        inBlockScalar = true;
        blockScalarIndent = indent;
      },
    });
  }

  flush();
  return out;
}

function applyField(
  target: Partial<TrustedReviewer>,
  key: string,
  raw: string,
  hooks: { openBlock: () => void },
): void {
  // `pubkey: |` opens a block scalar that we want to skip.
  if (key === 'pubkey' && (raw === '|' || raw === '|+' || raw === '|-' || raw === '')) {
    if (raw === '|' || raw === '|+' || raw === '|-') hooks.openBlock();
    return;
  }
  const value = stripQuotes(raw);
  switch (key) {
    case 'identity':
      target.identity = value;
      return;
    case 'machine':
      target.machine = value;
      return;
    case 'addedAt':
      target.addedAt = value;
      return;
    case 'addedBy':
      target.addedBy = value;
      return;
    default:
      // Silently ignore unknown keys (forward-compat).
      return;
  }
}

function stripQuotes(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

export interface CheckActorOpts extends LoadTrustedReviewersOpts {
  /**
   * Pre-loaded reviewer list. When provided, skips the on-disk read.
   * Used by callers that batch many actor checks against the same file
   * (e.g. a sweep over multiple `dor-bypass` events) to avoid re-reading
   * the file once per actor.
   */
  reviewers?: TrustedReviewer[];
  /**
   * Required role label. RFC-0009's role axis is implicit today (every
   * entry in `reviewers:` is a maintainer). The parameter exists so the
   * caller can pass `cfg.bypassRequiresRole` through unchanged; the
   * default `'maintainer'` matches the schema default. Future role
   * grants will land here without changing the call sites.
   */
  requiredRole?: string;
}

export interface CheckActorResult {
  allowed: boolean;
  /** Human-readable reason — useful for the calling shim's log line. */
  reason: string;
  /** The matched reviewer entry when `allowed` is true. */
  matched?: TrustedReviewer;
}

/**
 * Decide whether an actor is allowed to perform a trust-gated action
 * (currently only `dor-bypass` per RFC-0011 §7.4).
 *
 * The check is:
 *   1. Load the trusted-reviewers list (or use the pre-loaded list).
 *   2. Look up the actor by exact identity match.
 *   3. Allow when the entry exists; deny otherwise.
 *
 * Role-based gating is a no-op today (every entry is a maintainer); the
 * `requiredRole` parameter is the extension point for RFC-0009's
 * forthcoming role axis.
 */
export function checkActorAllowed(actor: string, opts: CheckActorOpts = {}): CheckActorResult {
  if (!actor || !actor.trim()) {
    return { allowed: false, reason: 'empty actor identity' };
  }
  const reviewers = opts.reviewers ?? loadTrustedReviewers(opts);
  if (reviewers.length === 0) {
    return {
      allowed: false,
      reason:
        'no trusted reviewers configured (.ai-sdlc/trusted-reviewers.yaml missing or empty); bypass denied as the safe default',
    };
  }
  const matched = reviewers.find((r) => r.identity === actor);
  if (!matched) {
    return {
      allowed: false,
      reason: `actor '${actor}' is not in .ai-sdlc/trusted-reviewers.yaml`,
    };
  }
  return {
    allowed: true,
    reason: `actor '${actor}' is a trusted reviewer (role=${opts.requiredRole ?? 'maintainer'})`,
    matched,
  };
}
