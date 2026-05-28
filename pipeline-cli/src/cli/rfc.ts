/**
 * `cli-rfc` — RFC-0036 adopter RFC tooling.
 *
 * Subcommands:
 *   index   — list adopter RFCs + cross-reference them against the
 *             RFC-0035 Decision Catalog (decisions-resolved / pending
 *             per RFC). Shipped in Phase 9 (AISDLC-334).
 *   init    — scaffold a new adopter RFC from the framework template.
 *             Shipped in Phase 2 (AISDLC-327).
 *
 * ## How RFC ↔ Decision cross-referencing works (index)
 *
 * RFC-0035 Decision records carry a free-form `metadata.scope` field
 * (e.g. `rfc:RFC-0035`, `issue:AISDLC-285`, `workspace`). This CLI
 * groups decisions by the RFC id embedded in their scope and reports
 * per-RFC counts:
 *
 *   - **decisionsResolved** — decisions whose lifecycle is `answered`
 *     (operator picked an option) or `superseded`/`archived`. These
 *     are no longer in the operator's queue.
 *   - **decisionsPending** — everything else: `proposed`, `open`,
 *     `deferred`. The operator still owes a call on these.
 *
 * The cross-reference is intentionally one-directional (Decisions →
 * RFCs via scope) — adopter RFC bodies are not parsed for explicit
 * Decision back-links because that surface isn't standardised yet.
 *
 * ## How the init scaffold works (Phase 2 / AISDLC-327)
 *
 * `cli-rfc init <slug>` materialises a new adopter RFC at
 * `<rfcDir>/<slug>.md` (defaulting to `rfcs/<slug>.md`) from
 * `pipeline-cli/templates/framework-rfc.md` — a single template per
 * RFC-0036 OQ-5 (variants are a future Decision in the Catalog when
 * adopter demand justifies them). Resolution order for `<rfcDir>` is
 * the same as `index`: `--rfc-dir` flag > `.ai-sdlc/adopter-authoring.yaml`
 * `rfc-scaffold.rfcDir` > `rfcs/` default. The scaffold refuses to
 * overwrite an existing file unless `--force` is passed; the slug is
 * validated for filesystem safety before writing.
 *
 * Per OQ-12 the same surface ships as the `/ai-sdlc rfc init <slug>`
 * slash command in the plugin — the slash command body shells out to
 * this binary.
 *
 * @module cli/rfc
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  decisionCatalogDisabledMessage,
  isDecisionCatalogEnabled,
  listDecisions,
  type Decision,
  type DecisionLifecycle,
} from '../decisions/index.js';
import { extractRfcLifecycle } from '../dor/upstream-oq-gate.js';
import { loadAdopterAuthoringConfig } from '../import-spec/config.js';

// ── Output helpers ────────────────────────────────────────────────────────────

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function warnToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

// ── RFC discovery ─────────────────────────────────────────────────────────────

/**
 * Resolve the adopter RFC directory. Resolution order:
 *
 *   1. Explicit `--rfc-dir <path>` flag (passed through `optsOverride`).
 *   2. `.ai-sdlc/adopter-authoring.yaml` `rfc-scaffold.rfcDir`.
 *   3. Default `rfcs/`.
 *   4. If `rfcs/` does not exist AND `spec/rfcs/` does, fall back to
 *      `spec/rfcs/` — this lets the dogfood repo (`ai-sdlc/ai-sdlc`)
 *      use the same CLI without per-repo config, and it's safe because
 *      `spec/rfcs/` is the framework's own convention.
 *
 * Returns the resolved absolute path; does NOT check whether the
 * directory exists (callers report 'no rfcs found' when it doesn't).
 */
export function resolveRfcDir(
  workDir: string,
  optsOverride?: { rfcDir?: string },
): { rfcDir: string; source: 'cli-flag' | 'config' | 'default' | 'spec-rfcs-fallback' } {
  if (optsOverride?.rfcDir && optsOverride.rfcDir.trim()) {
    return { rfcDir: join(workDir, optsOverride.rfcDir), source: 'cli-flag' };
  }

  // Config lookup — may fall through to defaults when the file is absent.
  let configuredRel: string | null = null;
  try {
    const cfg = loadAdopterAuthoringConfig({ workDir });
    configuredRel = cfg.rfcScaffold.rfcDir;
  } catch {
    // Malformed config — fall through to the default + fallback below.
    configuredRel = null;
  }

  // When the config slice is at its default value, treat as 'default'
  // for source attribution. Otherwise the caller explicitly set it.
  const isDefault = configuredRel === 'rfcs/';
  const candidate = join(workDir, configuredRel ?? 'rfcs/');

  // If the configured/default directory exists, prefer it.
  if (existsSync(candidate)) {
    return { rfcDir: candidate, source: isDefault ? 'default' : 'config' };
  }

  // Fall back to spec/rfcs/ when the configured rfcs/ is absent. This is
  // a convenience for the framework's own repo where adopter-style RFCs
  // don't apply — operators running `cli-rfc index` in the dogfood repo
  // still get a useful index of the framework RFCs.
  const specRfcs = join(workDir, 'spec', 'rfcs');
  if (existsSync(specRfcs)) {
    return { rfcDir: specRfcs, source: 'spec-rfcs-fallback' };
  }

  // Neither exists — return the original candidate so the caller can
  // produce a helpful "no rfcs found at <path>" message.
  return { rfcDir: candidate, source: isDefault ? 'default' : 'config' };
}

/** RFC scan result for one file. */
export interface RfcIndexEntry {
  /** RFC id — `RFC-NNNN`, or filename when the id can't be extracted. */
  rfcId: string;
  /** Best-effort title (frontmatter `title:` or first H1). */
  title: string;
  /** Lifecycle from frontmatter (Draft / Ready for Review / Signed Off / etc.) or 'unknown'. */
  lifecycle: string;
  /** Absolute path to the RFC file. */
  filePath: string;
  /** Number of Decisions scoped to this RFC that are resolved/superseded/archived. */
  decisionsResolved: number;
  /** Number of Decisions scoped to this RFC that are proposed/open/deferred. */
  decisionsPending: number;
  /** All Decision ids scoped to this RFC (for `--json` consumers). */
  decisionIds: string[];
}

/**
 * Extract RFC id from filename. Accepts `RFC-NNNN-*.md` and the bare
 * uppercased form `RFC-NNNN`. Returns the bare id (uppercased) when
 * matched.
 */
export function extractRfcIdFromFilename(filename: string): string | null {
  const m = filename.match(/^(RFC-\d{4,})/i);
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * Extract the `title:` field from a YAML frontmatter block (no full YAML
 * parser — adopter RFCs may omit frontmatter entirely, in which case the
 * caller falls back to the first H1).
 */
export function extractRfcTitle(content: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    // Try several common quote styles.
    const m = fm[1]!.match(/^title:\s*(.+?)\s*$/m);
    if (m) {
      const raw = m[1]!;
      return raw.replace(/^['"]|['"]$/g, '').trim();
    }
  }
  // Fall back to the first H1 line.
  const h1 = content.match(/^#\s+(.+?)\s*$/m);
  return h1 ? h1[1]!.trim() : null;
}

/**
 * Decision lifecycle states that count as "resolved" for the index.
 * Per RFC-0035 §4.2, these are the terminal states for the operator's
 * point of view — no further decision is required.
 */
const RESOLVED_LIFECYCLES = new Set<DecisionLifecycle>(['answered', 'superseded', 'archived']);

/**
 * Pull an RFC id (`RFC-NNNN`) out of a Decision's `metadata.scope`.
 *
 * Accepts the canonical `rfc:RFC-NNNN` form AND a bare `RFC-NNNN` form
 * (operators in the field sometimes drop the prefix). Returns the
 * normalised uppercase id, or `null` when the scope isn't RFC-scoped.
 */
export function extractRfcIdFromScope(scope: string): string | null {
  const m = scope.match(/RFC-(\d{4,})/i);
  return m ? `RFC-${m[1]}` : null;
}

/**
 * Group decisions by the RFC id in their scope. Decisions with non-RFC
 * scopes (`issue:`, `workspace`, etc.) are skipped.
 */
export function groupDecisionsByRfc(decisions: Decision[]): Map<string, Decision[]> {
  const map = new Map<string, Decision[]>();
  for (const d of decisions) {
    const rfcId = extractRfcIdFromScope(d.metadata.scope);
    if (!rfcId) continue;
    const existing = map.get(rfcId);
    if (existing) existing.push(d);
    else map.set(rfcId, [d]);
  }
  return map;
}

/**
 * Scan the resolved RFC directory and compute per-RFC index entries.
 * When `decisions` is provided, the entries carry resolved/pending
 * counts; otherwise both counts are 0 (decision catalog disabled).
 */
export function buildRfcIndex(opts: { rfcDir: string; decisions: Decision[] }): RfcIndexEntry[] {
  if (!existsSync(opts.rfcDir)) return [];

  const stat = statSync(opts.rfcDir);
  if (!stat.isDirectory()) return [];

  const byRfc = groupDecisionsByRfc(opts.decisions);
  const entries: RfcIndexEntry[] = [];

  for (const filename of readdirSync(opts.rfcDir).sort()) {
    if (!filename.endsWith('.md')) continue;
    // Skip obvious non-RFC files (README.md, index.md, CONTRIBUTING.md, etc.).
    // The convention is filenames start with `RFC-` (case-insensitive); when
    // a filename violates that we treat it as bookkeeping documentation
    // rather than an actual RFC. Adopters following a different convention
    // can use `--rfc-dir` to point at their own directory.
    if (!/^rfc-/i.test(filename)) continue;
    const filePath = join(opts.rfcDir, filename);
    let content = '';
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      // Unreadable — skip silently; the operator's permissions errors
      // surface via `ls`, not via this CLI.
      continue;
    }

    const fromName = extractRfcIdFromFilename(filename);
    // Frontmatter `id:` can override the filename id when the two diverge
    // (rare but legal — supports adopter RFCs that aren't filename-numbered).
    const fromFrontmatter = (() => {
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) return null;
      const m = fm[1]!.match(/^id:\s*(.+?)\s*$/m);
      if (!m) return null;
      return m[1]!.replace(/^['"]|['"]$/g, '').trim();
    })();
    const rfcId = (fromFrontmatter ?? fromName ?? filename).toString();

    const title = extractRfcTitle(content) ?? filename.replace(/\.md$/, '');
    const lifecycle = extractRfcLifecycle(content);

    const matched = byRfc.get(rfcId) ?? [];
    let resolved = 0;
    let pending = 0;
    const decisionIds: string[] = [];
    for (const d of matched) {
      decisionIds.push(d.metadata.id);
      if (RESOLVED_LIFECYCLES.has(d.status.lifecycle)) resolved++;
      else pending++;
    }

    entries.push({
      rfcId,
      title,
      lifecycle,
      filePath,
      decisionsResolved: resolved,
      decisionsPending: pending,
      decisionIds,
    });
  }

  return entries;
}

// ── Text rendering ────────────────────────────────────────────────────────────

/**
 * Render the index as an aligned text table. Columns: RFC, lifecycle,
 * decisions-resolved, decisions-pending, title.
 */
export function renderIndexTable(entries: RfcIndexEntry[]): string {
  if (entries.length === 0) return '(no RFCs found)\n';
  const headers = ['rfc', 'lifecycle', 'resolved', 'pending', 'title'] as const;
  const rows = entries.map((e) => [
    e.rfcId,
    e.lifecycle,
    String(e.decisionsResolved),
    String(e.decisionsPending),
    e.title.length > 80 ? e.title.slice(0, 77) + '...' : e.title,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [fmt(headers as unknown as string[]), sep, ...rows.map(fmt)];
  return lines.join('\n') + '\n';
}

// ── init scaffold (Phase 2 / AISDLC-327) ─────────────────────────────────────

/**
 * Validate an RFC slug. Returns the normalised (lowercased) slug or
 * throws an `Error` with a human-actionable message. Rules:
 *
 *   - Non-empty after trimming.
 *   - Lowercase ASCII letters, digits, and hyphens only (allow the
 *     uppercase form on input — it's normalised).
 *   - Must not start or end with a hyphen.
 *   - No path separators or traversal sequences.
 *   - Length ≤ 80 chars (keeps filenames + URL paths sane).
 *
 * The slug is the filename stem (`<slug>.md`); the validation is a
 * filesystem-safety gate, not a style enforcer.
 */
export function validateRfcSlug(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    throw new Error('[cli-rfc init] slug is required (got empty string)');
  }
  if (trimmed.length > 80) {
    throw new Error(`[cli-rfc init] slug too long (${trimmed.length} chars; max 80)`);
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error(
      `[cli-rfc init] slug must not contain path separators or '..': ${JSON.stringify(trimmed)}`,
    );
  }
  const lower = trimmed.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(lower)) {
    throw new Error(
      `[cli-rfc init] slug must be lowercase alphanumeric + hyphens (no leading/trailing hyphens): ${JSON.stringify(raw)}`,
    );
  }
  return lower;
}

/**
 * Compute the absolute destination path for `<slug>.md` under the
 * resolved RFC directory. Pure — does no I/O.
 */
export function computeRfcInitPath(rfcDir: string, slug: string): string {
  return join(rfcDir, `${slug}.md`);
}

/**
 * Locate the framework RFC template (`framework-rfc.md`). Resolution
 * order:
 *
 *   1. Explicit `templatePath` override (tests / advanced operators).
 *   2. `pipeline-cli/templates/framework-rfc.md` resolved relative to
 *      this module's location — robust across `src/cli/rfc.ts` (dev /
 *      tsx) and `dist/cli/rfc.js` (compiled).
 *
 * Returns the absolute path. Throws when the template cannot be found
 * so the operator gets a precise error rather than a malformed RFC.
 */
export function resolveTemplatePath(
  opts: { templatePath?: string; moduleUrl?: string } = {},
): string {
  if (opts.templatePath && opts.templatePath.trim()) {
    const abs = isAbsolute(opts.templatePath) ? opts.templatePath : resolve(opts.templatePath);
    if (!existsSync(abs)) {
      throw new Error(`[cli-rfc init] template not found at ${abs}`);
    }
    return abs;
  }

  const here = dirname(fileURLToPath(opts.moduleUrl ?? import.meta.url));
  // Search ancestors of `here` for `templates/framework-rfc.md`. This
  // walks up at most a handful of levels (src/cli → src → pipeline-cli;
  // dist/cli → dist → pipeline-cli) so the template ships next to the
  // package at `pipeline-cli/templates/framework-rfc.md` regardless of
  // whether the CLI is invoked via tsx (src) or node (dist).
  const candidates: string[] = [];
  let cursor = here;
  for (let i = 0; i < 6; i++) {
    candidates.push(join(cursor, 'templates', 'framework-rfc.md'));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  throw new Error(
    `[cli-rfc init] could not locate framework-rfc.md template; searched: ${candidates.join(', ')}`,
  );
}

/**
 * Render the framework RFC template by substituting placeholders.
 * Pure — string-only; the caller writes the file.
 *
 * Placeholders honoured:
 *   - `{{title}}`       — human-readable title (derived from slug if not provided).
 *   - `{{slug}}`        — the validated lowercase slug.
 *   - `{{author}}`      — author name (defaults to `<your-name>` placeholder).
 *   - `{{createdDate}}` — ISO 8601 calendar date (YYYY-MM-DD).
 */
export function renderRfcTemplate(opts: {
  template: string;
  slug: string;
  title?: string;
  author?: string;
  createdDate?: string;
}): string {
  const title = (opts.title?.trim() || slugToTitle(opts.slug)).trim();
  const author = (opts.author?.trim() || '<your-name>').trim();
  const createdDate = (opts.createdDate?.trim() || new Date().toISOString().slice(0, 10)).trim();
  return opts.template
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{slug\}\}/g, opts.slug)
    .replace(/\{\{author\}\}/g, author)
    .replace(/\{\{createdDate\}\}/g, createdDate);
}

/**
 * Convert a kebab-case slug to a Title Case heading. Pure helper.
 */
export function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export interface InitRfcOpts {
  workDir: string;
  slug: string;
  title?: string;
  author?: string;
  rfcDir?: string;
  force?: boolean;
  templatePath?: string;
  /** Override `new Date()` for hermetic tests. */
  now?: () => Date;
}

export interface InitRfcResult {
  filePath: string;
  rfcDir: string;
  rfcDirSource: 'cli-flag' | 'config' | 'default' | 'spec-rfcs-fallback';
  slug: string;
  title: string;
  createdDate: string;
  created: boolean;
  templatePath: string;
}

/**
 * Materialise a new adopter RFC. Validates the slug, resolves the RFC
 * directory (cli-flag > config > default), creates the directory if
 * absent, refuses to overwrite an existing file unless `force` is set,
 * and writes the rendered template.
 *
 * Returns the resolved metadata (paths + final values used). Throws on
 * validation errors and on existing-file conflicts; the CLI handler
 * formats the error for the operator.
 */
export function initRfc(opts: InitRfcOpts): InitRfcResult {
  const slug = validateRfcSlug(opts.slug);
  const { rfcDir, source } = resolveRfcDir(opts.workDir, {
    rfcDir: opts.rfcDir && opts.rfcDir.trim() ? opts.rfcDir : undefined,
  });
  const filePath = computeRfcInitPath(rfcDir, slug);

  if (existsSync(filePath) && !opts.force) {
    throw new Error(
      `[cli-rfc init] refusing to overwrite existing file at ${filePath} — pass --force to replace it`,
    );
  }

  const templatePath = resolveTemplatePath({ templatePath: opts.templatePath });
  const template = readFileSync(templatePath, 'utf8');
  const createdDate = (opts.now ? opts.now() : new Date()).toISOString().slice(0, 10);
  const title = (opts.title?.trim() || slugToTitle(slug)).trim();
  const rendered = renderRfcTemplate({
    template,
    slug,
    title,
    author: opts.author,
    createdDate,
  });

  mkdirSync(rfcDir, { recursive: true });
  writeFileSync(filePath, rendered, 'utf8');

  return {
    filePath,
    rfcDir,
    rfcDirSource: source,
    slug,
    title,
    createdDate,
    created: true,
    templatePath,
  };
}

// ── CLI builder ──────────────────────────────────────────────────────────────

export function buildRfcCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-rfc')
    .usage(
      'Usage: $0 <command> [options]\n\nRFC-0036 adopter RFC tooling (init = Phase 2 / AISDLC-327; index = Phase 9 / AISDLC-334).',
    )
    .option('work-dir', {
      alias: 'w',
      describe:
        'Project root (defaults to cwd). Resolves the RFC dir via adopter-authoring.yaml (rfc-scaffold.rfcDir) — default rfcs/, falling back to spec/rfcs/ when rfcs/ is absent.',
      type: 'string',
      default: process.cwd(),
    })
    .command(
      'index',
      'List adopter RFCs and cross-reference them against the RFC-0035 Decision Catalog (resolved/pending decision counts per RFC).',
      (y) =>
        y
          .option('format', {
            type: 'string',
            choices: ['table', 'json'] as const,
            default: 'table' as const,
            describe: 'Output format. `json` is intended for programmatic consumers (AC #4).',
          })
          .option('rfc-dir', {
            type: 'string',
            describe:
              'Override the RFC directory (relative to --work-dir). Otherwise read from adopter-authoring.yaml rfc-scaffold.rfcDir; defaults to rfcs/, falling back to spec/rfcs/.',
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const rfcDirOverride = typeof argv['rfc-dir'] === 'string' ? String(argv['rfc-dir']) : '';
        const { rfcDir, source } = resolveRfcDir(workDir, { rfcDir: rfcDirOverride || undefined });

        // RFC-0035 Phase 1 dependency: cross-references require the
        // catalog to be readable. When the feature flag is off we degrade
        // open (per the cli-decisions convention) — index still lists
        // RFCs but the decision counts are zero and we explain why.
        let decisions: Decision[] = [];
        let catalogEnabled = false;
        if (isDecisionCatalogEnabled()) {
          catalogEnabled = true;
          const { decisions: ds } = listDecisions({ workDir });
          decisions = ds;
        } else {
          warnToStderr(decisionCatalogDisabledMessage());
          warnToStderr(
            '[cli-rfc] note: decision counts will be 0 — cross-reference requires the Decision Catalog.',
          );
        }

        const entries = buildRfcIndex({ rfcDir, decisions });

        if (String(argv.format) === 'json') {
          emit({
            ok: true,
            rfcDir,
            rfcDirSource: source,
            catalogEnabled,
            entries,
            count: entries.length,
          });
          return;
        }

        // Text mode — render the table preceded by the resolved rfcDir
        // (so the operator can see at a glance which directory was
        // scanned, especially when the spec/rfcs/ fallback fired).
        emitText(`RFC index — scanned ${rfcDir} (source: ${source})`);
        if (!catalogEnabled) {
          emitText(
            '  (decision catalog feature flag is off — counts default to 0; pass AI_SDLC_DECISION_CATALOG=on to enable cross-references)',
          );
        }
        process.stdout.write(renderIndexTable(entries));
      },
    )
    .command(
      'init <slug>',
      'Scaffold a new adopter RFC from the framework template (RFC-0036 Phase 2 / AISDLC-327).',
      (y) =>
        y
          .positional('slug', {
            type: 'string',
            describe:
              'RFC slug (filename stem). Lowercase alphanumeric + hyphens, no path separators, max 80 chars.',
            demandOption: true,
          })
          .option('title', {
            type: 'string',
            describe:
              'Human-readable RFC title. Defaults to a Title-Case rendering of the slug (e.g. multi-tenancy-model → "Multi Tenancy Model").',
          })
          .option('author', {
            type: 'string',
            describe:
              'Author name written into the template. Defaults to "<your-name>" placeholder so the operator notices it on first read.',
          })
          .option('rfc-dir', {
            type: 'string',
            describe:
              'Override the RFC directory (relative to --work-dir). Otherwise read from adopter-authoring.yaml rfc-scaffold.rfcDir; defaults to rfcs/, falling back to spec/rfcs/.',
          })
          .option('force', {
            type: 'boolean',
            default: false,
            describe:
              'Overwrite an existing file at the destination. By default, the scaffold refuses to clobber existing content.',
          })
          .option('template', {
            type: 'string',
            describe:
              'Absolute or relative path to a template file. Defaults to the framework-rfc.md shipped with @ai-sdlc/pipeline-cli.',
          })
          .option('format', {
            type: 'string',
            choices: ['text', 'json'] as const,
            default: 'text' as const,
            describe: 'Output format. `json` is intended for programmatic consumers.',
          }),
      async (argv) => {
        const workDir = String(argv['work-dir']);
        const slug = String(argv.slug);
        const rfcDirOverride = typeof argv['rfc-dir'] === 'string' ? String(argv['rfc-dir']) : '';
        const templatePath = typeof argv.template === 'string' ? String(argv.template) : '';
        try {
          const result = initRfc({
            workDir,
            slug,
            title: typeof argv.title === 'string' ? String(argv.title) : undefined,
            author: typeof argv.author === 'string' ? String(argv.author) : undefined,
            rfcDir: rfcDirOverride || undefined,
            force: Boolean(argv.force),
            templatePath: templatePath || undefined,
          });

          if (String(argv.format) === 'json') {
            emit({ ok: true, ...result });
            return;
          }

          emitText(`Scaffolded adopter RFC at ${result.filePath}`);
          emitText(`  slug:       ${result.slug}`);
          emitText(`  title:      ${result.title}`);
          emitText(`  rfcDir:     ${result.rfcDir} (source: ${result.rfcDirSource})`);
          emitText(`  template:   ${result.templatePath}`);
          emitText(`  createdAt:  ${result.createdDate}`);
          emitText('');
          emitText('Next steps:');
          emitText('  1. Open the file and replace the scaffold notice + placeholders.');
          emitText(
            '  2. Capture Open Questions as you draft; resolve them in the Decisions section.',
          );
          emitText('  3. Commit the RFC; cross-link from any backlog tasks via `references:`.');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnToStderr(msg);
          if (String(argv.format) === 'json') {
            emit({ ok: false, error: msg });
          }
          process.exit(1);
        }
      },
    )
    .demandCommand(1, 'A subcommand is required. Run with --help for the list.')
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runRfcCli(): Promise<void> {
  await buildRfcCli().parseAsync();
}
