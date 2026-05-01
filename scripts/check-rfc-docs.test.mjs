#!/usr/bin/env node
/**
 * check-rfc-docs.test.mjs — node:test coverage for the RFC docs-drift checker.
 *
 * Run with: `node --test scripts/check-rfc-docs.test.mjs`
 *
 * Why node:test (not vitest): same rationale as `scripts/docs-sync.test.mjs` —
 * the script lives at workspace root, has no package.json, and node:test ships
 * with Node >=20 which we already require.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  validateRfc,
  checkAllRfcs,
  reportAndExit,
  listRfcFiles,
  findReferences,
  SURFACE_TO_SUBDIR,
  ENFORCED_STATUSES,
  KNOWN_STATUSES,
  TEMPLATE_FILENAME,
} from './check-rfc-docs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-rfc-docs.mjs');

// ---------------------------------------------------------- parseFrontmatter

describe('parseFrontmatter', () => {
  it('returns empty when no fence present', () => {
    const { frontmatter, body } = parseFrontmatter('# Title\n\nbody\n');
    assert.deepEqual(frontmatter, {});
    assert.equal(body, '# Title\n\nbody\n');
  });

  it('parses scalar string keys', () => {
    const src = '---\nid: RFC-0042\ntitle: Hello\n---\n# Body\n';
    const { frontmatter } = parseFrontmatter(src);
    assert.equal(frontmatter.id, 'RFC-0042');
    assert.equal(frontmatter.title, 'Hello');
  });

  it('strips single and double quotes from scalar values', () => {
    const src = '---\nid: \'RFC-0001\'\ntitle: "Quoted Title"\n---\nbody\n';
    const { frontmatter } = parseFrontmatter(src);
    assert.equal(frontmatter.id, 'RFC-0001');
    assert.equal(frontmatter.title, 'Quoted Title');
  });

  it('parses block lists', () => {
    const src = '---\nrequiresDocs:\n  - tutorial\n  - api-reference\n---\nbody\n';
    const { frontmatter } = parseFrontmatter(src);
    assert.deepEqual(frontmatter.requiresDocs, ['tutorial', 'api-reference']);
  });

  it('parses inline empty list `[]`', () => {
    const src = '---\nrequiresDocs: []\n---\nbody\n';
    const { frontmatter } = parseFrontmatter(src);
    assert.deepEqual(frontmatter.requiresDocs, []);
  });

  it('parses booleans', () => {
    const src = '---\ndeferredDocs: true\nflag: false\n---\nbody\n';
    const { frontmatter } = parseFrontmatter(src);
    assert.equal(frontmatter.deferredDocs, true);
    assert.equal(frontmatter.flag, false);
  });

  it('ignores comment lines inside frontmatter', () => {
    const src = '---\n# this is a comment\nid: RFC-0001\n# another\ntitle: Hi\n---\nbody\n';
    const { frontmatter } = parseFrontmatter(src);
    assert.equal(frontmatter.id, 'RFC-0001');
    assert.equal(frontmatter.title, 'Hi');
  });

  it('throws when opening fence has no closing fence', () => {
    const src = '---\nid: RFC-0001\ntitle: oops\n# body never starts\n';
    assert.throws(() => parseFrontmatter(src), /malformed frontmatter/);
  });

  it('handles CRLF line endings', () => {
    const src = '---\r\nid: RFC-0001\r\n---\r\nbody\r\n';
    const { frontmatter, body } = parseFrontmatter(src);
    assert.equal(frontmatter.id, 'RFC-0001');
    assert.match(body, /body/);
  });

  it('does not confuse `---` inside body for a closing fence', () => {
    // The `---` inside the body shouldn't terminate frontmatter early because
    // the parser scans for `\n---\n` after the OPENING fence — the body's
    // hr separator includes surrounding blank lines but we still want our
    // `requiresDocs:` to be picked up.
    const src = '---\nid: RFC-0001\ntitle: Hi\n---\n# Body\n\n---\n\nmore body\n';
    const { frontmatter, body } = parseFrontmatter(src);
    assert.equal(frontmatter.id, 'RFC-0001');
    assert.match(body, /more body/);
  });
});

// ---------------------------------------------------------------- validateRfc

describe('validateRfc', () => {
  // We don't need a real docs dir for failures that happen before the surface
  // check; for the lookup-style tests we use a temp dir.
  const NO_DOCS_DIR = '/this/dir/does/not/exist';
  const FIXED_TODAY = new Date('2026-05-01T00:00:00Z');

  it('passes vacuously when requiresDocs is empty (strategic RFC)', () => {
    const fm = {
      id: 'RFC-9999',
      status: 'Approved',
      requiresDocs: [],
    };
    const r = validateRfc(fm, { docsDir: NO_DOCS_DIR, today: FIXED_TODAY });
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.warnings, []);
  });

  it('skips Draft RFCs (pre-sign-off)', () => {
    const fm = {
      id: 'RFC-9999',
      status: 'Draft',
      requiresDocs: ['tutorial'],
    };
    const r = validateRfc(fm, { docsDir: NO_DOCS_DIR, today: FIXED_TODAY });
    assert.deepEqual(r.failures, []);
    assert.ok(r.skipped, 'expected Draft to be skipped');
    assert.match(r.skipped.reason, /pre-sign-off/);
  });

  it('skips Under Review, Rejected, Withdrawn', () => {
    for (const status of ['Under Review', 'Rejected', 'Withdrawn']) {
      const fm = { id: 'RFC-9999', status, requiresDocs: ['tutorial'] };
      const r = validateRfc(fm, { docsDir: NO_DOCS_DIR, today: FIXED_TODAY });
      assert.deepEqual(r.failures, [], `status='${status}' should not fail`);
      assert.ok(r.skipped, `status='${status}' should be skipped`);
    }
  });

  it('enforces Approved, Implemented, Final', () => {
    for (const status of ['Approved', 'Implemented', 'Final']) {
      assert.ok(ENFORCED_STATUSES.has(status), `${status} should be in ENFORCED_STATUSES`);
    }
  });

  it('fails on missing docs for an enforced status', () => {
    const fm = {
      id: 'RFC-9999',
      status: 'Approved',
      requiresDocs: ['tutorial', 'api-reference'],
    };
    const r = validateRfc(fm, { docsDir: NO_DOCS_DIR, today: FIXED_TODAY });
    assert.equal(r.failures.length, 2);
    assert.equal(r.failures[0].rfc, 'RFC-9999');
    assert.equal(r.failures[0].surface, 'tutorial');
    assert.match(r.failures[0].reason, /no \.md file under docs\/tutorials\//);
    assert.match(r.failures[0].reason, /RFC-9999/);
    assert.equal(r.failures[1].surface, 'api-reference');
  });

  it('passes when at least one matching doc references the RFC id', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc-check-validate-'));
    mkdirSync(join(root, 'tutorials'), { recursive: true });
    writeFileSync(
      join(root, 'tutorials', 'walkthrough.md'),
      '# Tutorial\n\nThis demonstrates RFC-9999 in action.\n',
    );
    try {
      const fm = { id: 'RFC-9999', status: 'Approved', requiresDocs: ['tutorial'] };
      const r = validateRfc(fm, { docsDir: root, today: FIXED_TODAY });
      assert.deepEqual(r.failures, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns and short-circuits when deferredDocs:true with valid deadline', () => {
    const fm = {
      id: 'RFC-9999',
      status: 'Final',
      requiresDocs: ['tutorial', 'api-reference'],
      deferredDocs: true,
      deferredDocsDeadline: '2026-12-31',
    };
    const r = validateRfc(fm, { docsDir: NO_DOCS_DIR, today: FIXED_TODAY });
    assert.deepEqual(r.failures, []);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].rfc, 'RFC-9999');
    assert.match(r.warnings[0].reason, /deferredDocs=true/);
    assert.match(r.warnings[0].reason, /2026-12-31/);
    assert.match(r.warnings[0].reason, /day\(s\) remaining/);
  });

  it('warns with OVERDUE when deferredDocs deadline has passed', () => {
    const fm = {
      id: 'RFC-9999',
      status: 'Final',
      requiresDocs: ['tutorial'],
      deferredDocs: true,
      deferredDocsDeadline: '2025-01-01',
    };
    const r = validateRfc(fm, { docsDir: NO_DOCS_DIR, today: FIXED_TODAY });
    assert.deepEqual(r.failures, []);
    assert.match(r.warnings[0].reason, /OVERDUE/);
  });

  it('fails when deferredDocs:true but deadline missing', () => {
    const fm = {
      id: 'RFC-9999',
      status: 'Final',
      requiresDocs: ['tutorial'],
      deferredDocs: true,
    };
    const r = validateRfc(fm, { docsDir: NO_DOCS_DIR, today: FIXED_TODAY });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0].reason, /deferredDocsDeadline.*missing/);
  });

  it('fails when deferredDocs:true but deadline is not an ISO date', () => {
    const fm = {
      id: 'RFC-9999',
      status: 'Final',
      requiresDocs: ['tutorial'],
      deferredDocs: true,
      deferredDocsDeadline: 'next quarter',
    };
    const r = validateRfc(fm, { docsDir: NO_DOCS_DIR, today: FIXED_TODAY });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0].reason, /not an ISO date/);
  });

  it('fails when id is missing or malformed', () => {
    for (const id of [undefined, '', 'rfc-1', 'RFC-12']) {
      const r = validateRfc(
        { id, status: 'Approved', requiresDocs: [] },
        { docsDir: NO_DOCS_DIR, today: FIXED_TODAY },
      );
      assert.equal(r.failures.length, 1, `id=${JSON.stringify(id)} should fail`);
      assert.match(r.failures[0].reason, /invalid or missing 'id'/);
    }
  });

  it('fails when status is missing or unknown', () => {
    for (const status of [undefined, 'Frozen', '']) {
      const r = validateRfc(
        { id: 'RFC-0001', status, requiresDocs: [] },
        { docsDir: NO_DOCS_DIR, today: FIXED_TODAY },
      );
      assert.equal(r.failures.length, 1, `status=${JSON.stringify(status)} should fail`);
      assert.match(r.failures[0].reason, /invalid or missing 'status'/);
    }
  });

  it('fails when requiresDocs is not an array (and status is enforced)', () => {
    const fm = { id: 'RFC-0001', status: 'Approved', requiresDocs: 'tutorial' };
    const r = validateRfc(fm, { docsDir: NO_DOCS_DIR, today: FIXED_TODAY });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0].reason, /invalid or missing 'requiresDocs'/);
  });

  it('fails when requiresDocs contains an unknown surface', () => {
    const fm = { id: 'RFC-0001', status: 'Approved', requiresDocs: ['mystery-surface'] };
    const r = validateRfc(fm, { docsDir: NO_DOCS_DIR, today: FIXED_TODAY });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0].reason, /unknown surface 'mystery-surface'/);
  });
});

// ----------------------------------------------------------- findReferences

describe('findReferences', () => {
  const tempDirs = [];
  after(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });

  it('returns true when at least one .md file mentions the RFC id', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc-find-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'a.md'), '# A\n\nNo refs here.\n');
    writeFileSync(join(root, 'b.md'), '# B\n\nThis covers RFC-1234.\n');
    assert.equal(findReferences(root, 'RFC-1234'), true);
  });

  it('returns false when no file mentions the RFC id', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc-find-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'a.md'), '# A\n\nNo refs.\n');
    assert.equal(findReferences(root, 'RFC-9999'), false);
  });

  it('returns false when surface dir does not exist (graceful)', () => {
    assert.equal(findReferences('/no/such/dir', 'RFC-0001'), false);
  });

  it('searches recursively into subdirectories', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc-find-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'deep.md'), 'mentions RFC-7777.\n');
    assert.equal(findReferences(root, 'RFC-7777'), true);
  });

  it('skips non-.md files', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc-find-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'config.yaml'), 'mentions RFC-7777 but is yaml not md\n');
    assert.equal(findReferences(root, 'RFC-7777'), false);
  });
});

// ------------------------------------------------------------- listRfcFiles

describe('listRfcFiles', () => {
  it('skips the template and sorts deterministically', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc-list-'));
    try {
      writeFileSync(join(root, 'RFC-0002-foo.md'), 'x');
      writeFileSync(join(root, 'RFC-0001-template.md'), 'x');
      writeFileSync(join(root, 'RFC-0003-bar.md'), 'x');
      writeFileSync(join(root, 'README.md'), 'x'); // not RFC-prefixed
      const files = listRfcFiles(root);
      assert.equal(files.length, 2);
      assert.match(files[0], /RFC-0002-foo\.md$/);
      assert.match(files[1], /RFC-0003-bar\.md$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws on missing directory', () => {
    assert.throws(() => listRfcFiles('/no/such/dir'), /not found/);
  });

  it('exports the template filename so callers can override gracefully', () => {
    assert.equal(TEMPLATE_FILENAME, 'RFC-0001-template.md');
  });
});

// ----------------------------------------------- checkAllRfcs (integration)

function makeTempProject(rfcs, docs) {
  const root = mkdtempSync(join(tmpdir(), 'rfc-check-'));
  const rfcsDir = join(root, 'spec', 'rfcs');
  const docsDir = join(root, 'docs');
  mkdirSync(rfcsDir, { recursive: true });
  mkdirSync(docsDir, { recursive: true });
  for (const subdir of Object.values(SURFACE_TO_SUBDIR)) {
    mkdirSync(join(docsDir, subdir), { recursive: true });
  }
  for (const [name, content] of Object.entries(rfcs)) {
    writeFileSync(join(rfcsDir, name), content);
  }
  for (const [relPath, content] of Object.entries(docs)) {
    const full = join(docsDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, rfcsDir, docsDir };
}

function rfcFile(id, opts = {}) {
  const status = opts.status ?? 'Approved';
  const surfacesYaml = (opts.requiresDocs ?? []).map((s) => `  - ${s}`).join('\n');
  const requiresDocsBlock =
    opts.requiresDocs && opts.requiresDocs.length === 0
      ? 'requiresDocs: []'
      : `requiresDocs:\n${surfacesYaml}`;
  const deferredBlock = opts.deferredDocs
    ? `deferredDocs: true\ndeferredDocsDeadline: ${opts.deferredDocsDeadline ?? '2026-12-31'}\n`
    : '';
  return [
    '---',
    `id: ${id}`,
    `title: Synthetic ${id}`,
    `status: ${status}`,
    'author: Test',
    'created: 2026-01-01',
    'updated: 2026-01-01',
    requiresDocsBlock,
    deferredBlock.trim(),
    '---',
    `# ${id}`,
    '',
    'body',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n')
    .concat('\n');
}

describe('checkAllRfcs (integration)', () => {
  const tempRoots = [];
  after(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
  });

  it('passes on a clean project: enforced + skipped + deferred all coexist', () => {
    const { root, rfcsDir, docsDir } = makeTempProject(
      {
        // Enforced and satisfied.
        'RFC-0100-clean.md': rfcFile('RFC-0100', {
          status: 'Approved',
          requiresDocs: ['tutorial', 'api-reference'],
        }),
        // Pre-sign-off — skipped, missing docs OK.
        'RFC-0101-draft.md': rfcFile('RFC-0101', {
          status: 'Draft',
          requiresDocs: ['tutorial'],
        }),
        // Strategic — passes vacuously.
        'RFC-0102-strategy.md': rfcFile('RFC-0102', {
          status: 'Approved',
          requiresDocs: [],
        }),
        // Deferred — warning.
        'RFC-0103-deferred.md': rfcFile('RFC-0103', {
          status: 'Final',
          requiresDocs: ['tutorial'],
          deferredDocs: true,
          deferredDocsDeadline: '2026-12-31',
        }),
      },
      {
        'tutorials/walk.md': '# Walk\n\nCovers RFC-0100 in detail.\n',
        'api-reference/api.md': '# API\n\nSee RFC-0100 reference.\n',
      },
    );
    tempRoots.push(root);
    const report = checkAllRfcs({ rfcsDir, docsDir });
    assert.deepEqual(report.failures, []);
    assert.equal(report.files.length, 4);
    // RFC-0101 is skipped (Draft); 0100, 0102, 0103 are enforced (last one defers).
    assert.equal(report.skippedCount, 1);
    assert.equal(report.enforcedCount, 3);
    assert.equal(report.warnings.length, 1);
    assert.equal(report.warnings[0].rfc, 'RFC-0103');
  });

  it('fails on a missing surface with named RFC + surface', () => {
    const { root, rfcsDir, docsDir } = makeTempProject(
      {
        'RFC-0200-missing.md': rfcFile('RFC-0200', {
          status: 'Approved',
          requiresDocs: ['tutorial', 'api-reference'],
        }),
      },
      {
        // Only the tutorial mentions it; api-reference does not.
        'tutorials/walk.md': '# Walk\n\nCovers RFC-0200.\n',
        'api-reference/other.md': '# Other\n\nNothing relevant.\n',
      },
    );
    tempRoots.push(root);
    const report = checkAllRfcs({ rfcsDir, docsDir });
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].rfc, 'RFC-0200');
    assert.equal(report.failures[0].surface, 'api-reference');
    assert.match(report.failures[0].reason, /docs\/api-reference\//);
  });

  it('does NOT fail on Draft RFCs with no docs (status: Draft is skipped)', () => {
    const { root, rfcsDir, docsDir } = makeTempProject(
      {
        'RFC-0300-draft.md': rfcFile('RFC-0300', {
          status: 'Draft',
          requiresDocs: ['tutorial', 'api-reference', 'operator-runbook'],
        }),
      },
      {},
    );
    tempRoots.push(root);
    const report = checkAllRfcs({ rfcsDir, docsDir });
    assert.deepEqual(report.failures, []);
    assert.equal(report.skippedCount, 1);
  });

  it('passes vacuously when requiresDocs is []', () => {
    const { root, rfcsDir, docsDir } = makeTempProject(
      {
        'RFC-0400-vacuous.md': rfcFile('RFC-0400', {
          status: 'Approved',
          requiresDocs: [],
        }),
      },
      {},
    );
    tempRoots.push(root);
    const report = checkAllRfcs({ rfcsDir, docsDir });
    assert.deepEqual(report.failures, []);
    assert.equal(report.enforcedCount, 1);
  });

  it('rejects malformed frontmatter with a clear error', () => {
    const { root, rfcsDir, docsDir } = makeTempProject(
      {
        // Opens fence but never closes it.
        'RFC-0500-broken.md': '---\nid: RFC-0500\ntitle: Broken\n# closing fence missing\n',
      },
      {},
    );
    tempRoots.push(root);
    const report = checkAllRfcs({ rfcsDir, docsDir });
    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].reason, /malformed frontmatter/);
  });

  it('skips the template even if it would fail (placeholder values)', () => {
    const { root, rfcsDir, docsDir } = makeTempProject(
      {
        // The template carries placeholder `id: RFC-NNNN` and `created: YYYY-MM-DD`
        // which would fail the schema. The script must skip it by filename.
        'RFC-0001-template.md': '---\nid: RFC-NNNN\nstatus: Draft\nrequiresDocs: []\n---\n',
        'RFC-0600-real.md': rfcFile('RFC-0600', {
          status: 'Approved',
          requiresDocs: [],
        }),
      },
      {},
    );
    tempRoots.push(root);
    const report = checkAllRfcs({ rfcsDir, docsDir });
    assert.deepEqual(report.failures, []);
    assert.equal(report.files.length, 1);
  });
});

// ------------------------------------------------------- reportAndExit + CLI

describe('reportAndExit', () => {
  it('returns 0 on a clean report', () => {
    const code = reportAndExit({
      files: ['x'],
      failures: [],
      warnings: [],
      enforcedCount: 1,
      skippedCount: 0,
    });
    assert.equal(code, 0);
  });

  it('returns 1 when failures present', () => {
    const code = reportAndExit({
      files: ['x'],
      failures: [{ rfc: 'RFC-0001', surface: 'tutorial', reason: 'no doc' }],
      warnings: [],
      enforcedCount: 1,
      skippedCount: 0,
    });
    assert.equal(code, 1);
  });
});

describe('CLI', () => {
  it('exits 0 against the real workspace (regression safety net for this repo)', () => {
    // Run without args; defaults to the repo's spec/rfcs and docs/. Per
    // AISDLC-69.3 task spec this should pass (RFC-0006 deferred, RFC-0008
    // covered, all others Draft and skipped).
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf-8' });
    assert.equal(
      r.status,
      0,
      `expected current workspace to pass; stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.match(r.stdout, /\[rfc-check\] OK:/);
  });

  it('exits 1 against a project with a missing surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc-check-cli-'));
    const rfcsDir = join(root, 'spec', 'rfcs');
    const docsDir = join(root, 'docs');
    mkdirSync(rfcsDir, { recursive: true });
    mkdirSync(join(docsDir, 'tutorials'), { recursive: true });
    writeFileSync(
      join(rfcsDir, 'RFC-0700-missing.md'),
      rfcFile('RFC-0700', { status: 'Approved', requiresDocs: ['tutorial'] }),
    );
    writeFileSync(join(docsDir, 'tutorials', 'unrelated.md'), '# Unrelated\n');
    const r = spawnSync('node', [SCRIPT, '--rfcs-dir', rfcsDir, '--docs-dir', docsDir], {
      encoding: 'utf-8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[rfc-check\] FAIL/);
    assert.match(r.stderr, /RFC-0700/);
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 2 on unknown argument', () => {
    const r = spawnSync('node', [SCRIPT, '--bogus'], { encoding: 'utf-8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown argument/);
  });

  it('--help prints usage and exits 0', () => {
    const r = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf-8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/);
  });
});

// ---------------------------------------------------------- Module hygiene

describe('module exports', () => {
  it('exports the surface→subdir map matching the schema enum', () => {
    assert.deepEqual(Object.keys(SURFACE_TO_SUBDIR).sort(), [
      'api-reference',
      'example',
      'getting-started',
      'operator-runbook',
      'tutorial',
    ]);
  });

  it('exports the known statuses set matching the RFC schema enum', () => {
    assert.deepEqual([...KNOWN_STATUSES].sort(), [
      'Approved',
      'Draft',
      'Final',
      'Implemented',
      'Rejected',
      'Under Review',
      'Withdrawn',
    ]);
  });
});
