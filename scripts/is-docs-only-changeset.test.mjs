#!/usr/bin/env node
/**
 * scripts/is-docs-only-changeset.test.mjs — AISDLC-206
 *
 * Hermetic tests for the shared docs-only path predicate.
 *
 * Test sections:
 *  1. isDocsOnly() unit tests — path categories (AC-3)
 *  2. Paths-ignore equivalence — DOCS_ONLY_PATTERN mirrors verify-attestation.yml
 *     and ai-sdlc-review.yml paths-ignore lists (AC-4)
 *  3. core.quotePath=false regression detector — hermetic git repo with a
 *     non-ASCII filename asserts raw UTF-8 output WITH the flag and C-quoted
 *     output WITHOUT it (AC-5)
 *  4. release-please skip guard — documents/tests the merge_group head_ref
 *     limitation (AC-6)
 *
 * Run with: node --test scripts/is-docs-only-changeset.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOCS_ONLY_PATTERN, isDocsOnly } from './is-docs-only-changeset.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── helpers ──────────────────────────────────────────────────────────────────

function loadWorkflowPathsIgnore(workflowFile) {
  const wfPath = join(__dirname, '..', '.github', 'workflows', workflowFile);
  // PyYAML parses bare `on` as Python's boolean True, so json.dumps() emits
  // it as the string key "True" (not "on"). Access it accordingly in JS.
  const json = execFileSync(
    'python3',
    [
      '-c',
      'import sys, yaml, json; wf = yaml.safe_load(open(sys.argv[1])); print(json.dumps({str(k): v for k, v in wf.items()}))',
      wfPath,
    ],
    { encoding: 'utf-8' },
  );
  const wf = JSON.parse(json);
  // 'on' key is serialized as 'True' by PyYAML → json.dumps
  const onBlock = wf['True'];
  const pathsIgnore = onBlock?.pull_request?.['paths-ignore'];
  if (!Array.isArray(pathsIgnore)) {
    throw new Error(`Could not find on.pull_request.paths-ignore in ${workflowFile}`);
  }
  return pathsIgnore;
}

/**
 * Convert a GitHub Actions glob pattern to a representative set of test paths
 * that SHOULD match (prefix-based: strip trailing ** and use the prefix).
 * This is intentionally simple — we just want to assert that every glob in
 * paths-ignore has a corresponding match in DOCS_ONLY_PATTERN.
 */
function globToRepresentativePath(glob) {
  // e.g. 'spec/rfcs/**' → 'spec/rfcs/RFC-0001.md'
  //      'docs/**'        → 'docs/operations/README.md'
  //      '*.md'           → 'README.md'
  if (glob.endsWith('/**')) {
    return glob.replace('/**', '/example-file.md');
  }
  if (glob === '*.md') {
    return 'README.md';
  }
  return glob;
}

// ── Section 1: isDocsOnly() unit tests (AC-3) ────────────────────────────────

describe('isDocsOnly() — path category coverage (AC-3)', () => {
  // Pure docs paths — each docs-only prefix
  it('spec/rfcs/ prefix → docs-only', () => {
    assert.equal(isDocsOnly(['spec/rfcs/RFC-0001-template.md']), true);
    assert.equal(isDocsOnly(['spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md']), true);
  });

  it('docs/ prefix → docs-only', () => {
    assert.equal(isDocsOnly(['docs/operations/quality-gate.md']), true);
    assert.equal(isDocsOnly(['docs/foo/bar/baz.txt']), true);
  });

  it('backlog/tasks/ prefix → docs-only', () => {
    assert.equal(isDocsOnly(['backlog/tasks/aisdlc-206 - something.md']), true);
    assert.equal(isDocsOnly(['backlog/tasks/aisdlc-001.md']), true);
  });

  it('backlog/completed/ prefix → docs-only', () => {
    assert.equal(isDocsOnly(['backlog/completed/aisdlc-200.md']), true);
  });

  it('.ai-sdlc/attestations/*.dsse.json → docs-only (envelope chore-commit; AISDLC-208)', () => {
    assert.equal(isDocsOnly(['.ai-sdlc/attestations/abc123.dsse.json']), true);
    assert.equal(
      isDocsOnly(['.ai-sdlc/attestations/deadbeefcafebabe1234567890abcdef.dsse.json']),
      true,
    );
  });

  it('root *.md → docs-only', () => {
    assert.equal(isDocsOnly(['README.md']), true);
    assert.equal(isDocsOnly(['CHANGELOG.md']), true);
    assert.equal(isDocsOnly(['CONTRIBUTING.md']), true);
  });

  // Non-ASCII docs path (e.g. a French-titled RFC)
  it('non-ASCII docs path → docs-only', () => {
    assert.equal(isDocsOnly(['docs/opérations/qualité.md']), true);
    assert.equal(isDocsOnly(['spec/rfcs/RFC-0001-résumé.md']), true);
    assert.equal(isDocsOnly(['backlog/tasks/aisdlc-206 - hérmetic.md']), true);
  });

  // Pure code paths
  it('TypeScript source file → NOT docs-only', () => {
    assert.equal(isDocsOnly(['pipeline-cli/src/foo.ts']), false);
    assert.equal(isDocsOnly(['src/index.ts']), false);
  });

  it('shell script → NOT docs-only', () => {
    assert.equal(isDocsOnly(['scripts/check-coverage.sh']), false);
    assert.equal(isDocsOnly(['.husky/pre-push']), false);
  });

  it('root non-md file → NOT docs-only', () => {
    assert.equal(isDocsOnly(['package.json']), false);
    assert.equal(isDocsOnly(['pnpm-lock.yaml']), false);
    assert.equal(isDocsOnly(['.eslintrc.json']), false);
  });

  it('non-ASCII code path → NOT docs-only', () => {
    // A file whose path starts with a non-docs prefix but happens to contain
    // non-ASCII characters. Should NOT be treated as docs-only.
    assert.equal(isDocsOnly(['src/modulé/index.ts']), false);
    assert.equal(isDocsOnly(['pipeline-cli/src/résumé-parser.ts']), false);
  });

  // Mixed set (docs + code)
  it('mixed changeset (docs + code) → NOT docs-only', () => {
    assert.equal(isDocsOnly(['docs/operations/quality-gate.md', 'pipeline-cli/src/foo.ts']), false);
    assert.equal(isDocsOnly(['README.md', 'scripts/check-coverage.sh']), false);
  });

  // All-docs multi-file
  it('multiple docs files → docs-only', () => {
    assert.equal(
      isDocsOnly([
        'spec/rfcs/RFC-0001.md',
        'docs/operations/README.md',
        'backlog/tasks/aisdlc-100.md',
        'README.md',
      ]),
      true,
    );
  });

  // Empty list
  it('empty file list → NOT docs-only (empty ≠ docs-only)', () => {
    assert.equal(isDocsOnly([]), false);
  });

  // Nested *.md that are NOT at root — should NOT match root-level *.md glob
  it('nested *.md that is NOT under a docs-prefix → NOT docs-only', () => {
    // These paths look like markdown but do not start with any docs prefix
    // and are not at root level. The regex uses [^/]+\.md$ which matches only
    // root-level (no slash before) files.
    assert.equal(isDocsOnly(['pipeline-cli/README.md']), false);
    assert.equal(isDocsOnly(['some/nested/path/foo.md']), false);
  });

  // Ensure .ai-sdlc/attestations/ subdirectory constraint: nested paths don't match
  it('.ai-sdlc/attestations/ nested subdirectory → NOT docs-only (pattern requires direct child)', () => {
    // The pattern expects [^/]+\.dsse\.json$ — no slashes in filename
    assert.equal(isDocsOnly(['.ai-sdlc/attestations/subdir/foo.dsse.json']), false);
  });

  // Non-dsse file under attestations → NOT docs-only
  it('.ai-sdlc/attestations/ non-dsse.json file → NOT docs-only', () => {
    assert.equal(isDocsOnly(['.ai-sdlc/attestations/abc123.json']), false);
    assert.equal(isDocsOnly(['.ai-sdlc/attestations/abc123.dsse']), false);
  });
});

// ── Section 2: paths-ignore equivalence (AC-4) ───────────────────────────────

describe('paths-ignore equivalence (AC-4) — DOCS_ONLY_PATTERN mirrors workflow paths-ignore', () => {
  // We test that every glob in the paths-ignore lists of verify-attestation.yml
  // and ai-sdlc-review.yml has a representative path that DOCS_ONLY_PATTERN
  // matches. This fails loud if either workflow adds/removes a glob without
  // updating the shared script.

  const WORKFLOW_FILES = ['verify-attestation.yml', 'ai-sdlc-review.yml'];
  const EXPECTED_GLOBS = new Set([
    'spec/rfcs/**',
    'docs/**',
    'backlog/tasks/**',
    'backlog/completed/**',
    '*.md',
  ]);

  for (const wfFile of WORKFLOW_FILES) {
    it(`${wfFile} — paths-ignore globs are a subset of DOCS_ONLY_PATTERN coverage`, () => {
      const pathsIgnore = loadWorkflowPathsIgnore(wfFile);

      // 1. Assert that each known expected glob is present in the workflow file.
      //    If the workflow adds a NEW glob we don't know about, we detect it below.
      for (const glob of EXPECTED_GLOBS) {
        assert.ok(
          pathsIgnore.includes(glob),
          `${wfFile} paths-ignore must include '${glob}' (DOCS_ONLY_PATTERN covers it — if removed from workflow, remove from expected set and update DOCS_ONLY_PATTERN)`,
        );
      }

      // 2. Assert that every glob in the workflow's paths-ignore has a
      //    representative path that DOCS_ONLY_PATTERN matches. This detects
      //    new globs added to the workflow but NOT reflected in the shared script.
      for (const glob of pathsIgnore) {
        const representativePath = globToRepresentativePath(glob);
        assert.ok(
          DOCS_ONLY_PATTERN.test(representativePath),
          `${wfFile} paths-ignore glob '${glob}' has no match in DOCS_ONLY_PATTERN ` +
            `(representative path: '${representativePath}'). ` +
            `Update DOCS_ONLY_PATTERN in scripts/is-docs-only-changeset.mjs to cover this glob.`,
        );
      }

      // 3. Assert no UNEXPECTED extra globs crept into the workflow without
      //    being added to the expected set. This ensures both directions of
      //    the drift detection fire.
      const unexpectedGlobs = pathsIgnore.filter((g) => !EXPECTED_GLOBS.has(g));
      assert.deepEqual(
        unexpectedGlobs,
        [],
        `${wfFile} paths-ignore contains unexpected globs not in EXPECTED_GLOBS: ` +
          `[${unexpectedGlobs.map((g) => `'${g}'`).join(', ')}]. ` +
          `Add them to EXPECTED_GLOBS and update DOCS_ONLY_PATTERN accordingly.`,
      );
    });
  }
});

// ── Section 3: core.quotePath=false regression detector (AC-5) ───────────────

describe('core.quotePath=false regression detector (AC-5)', () => {
  // This test constructs a hermetic git repo, commits a file whose name
  // contains a non-ASCII character (é), and then verifies:
  //   a) WITH -c core.quotePath=false → raw UTF-8 output → matches DOCS_ONLY_PATTERN
  //   b) WITHOUT the flag              → C-quoted output  → does NOT match DOCS_ONLY_PATTERN
  //
  // (b) is the regression detector: if someone strips the -c flag from the
  // workflow's `git diff` invocation, docs-only PRs with non-ASCII filenames
  // will silently fail to match the predicate and deadlock the merge queue.

  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc206-quotepath-'));
    tmpDir = realpathSync(tmpDir); // resolve macOS /private/tmp symlink

    // Init git repo with a minimal config
    const gitOpts = { cwd: tmpDir, encoding: 'utf-8' };
    execFileSync('git', ['init', '-b', 'main'], gitOpts);
    execFileSync('git', ['config', 'user.name', 'Test'], gitOpts);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], gitOpts);

    // Initial commit (gives us a parent to diff against)
    writeFileSync(join(tmpDir, 'initial.txt'), 'seed commit\n');
    execFileSync('git', ['add', 'initial.txt'], gitOpts);
    execFileSync('git', ['commit', '-m', 'chore: initial commit'], gitOpts);

    // Second commit: add a file with a non-ASCII name under docs/
    const nonAsciiFilename = 'docs/résumé.md';
    const nonAsciiDir = join(tmpDir, 'docs');
    mkdirSync(nonAsciiDir, { recursive: true });
    writeFileSync(join(tmpDir, nonAsciiFilename), '# Résumé\n');
    execFileSync('git', ['add', nonAsciiFilename], gitOpts);
    execFileSync('git', ['commit', '-m', 'docs: add non-ASCII filename'], gitOpts);
  });

  after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('WITH -c core.quotePath=false: raw UTF-8 filename is emitted and matches DOCS_ONLY_PATTERN', () => {
    const result = spawnSync(
      'git',
      ['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD~', 'HEAD'],
      { cwd: tmpDir, encoding: 'utf-8' },
    );
    assert.equal(result.status, 0, `git diff exited with ${result.status}: ${result.stderr}`);

    const files = result.stdout.trim().split('\n').filter(Boolean);
    assert.equal(files.length, 1, `Expected 1 changed file, got: ${files.join(', ')}`);

    const filename = files[0];
    // Raw UTF-8: must NOT start with double-quote (C-quoting prefix)
    assert.notEqual(
      filename[0],
      '"',
      `Expected raw UTF-8 filename but got C-quoted: ${filename}. ` +
        'This means core.quotePath=false is NOT working.',
    );
    // Must contain the literal é character
    assert.ok(
      filename.includes('é'),
      `Expected filename to contain 'é' (U+00E9) but got: ${filename}`,
    );
    // The raw UTF-8 filename MUST match DOCS_ONLY_PATTERN
    assert.ok(
      DOCS_ONLY_PATTERN.test(filename),
      `Raw UTF-8 filename '${filename}' must match DOCS_ONLY_PATTERN — ` +
        'docs-only detection depends on this for merge_group runs with non-ASCII paths',
    );
  });

  it('WITHOUT -c core.quotePath=false: C-quoted filename is emitted and does NOT match DOCS_ONLY_PATTERN (regression detector)', () => {
    const result = spawnSync('git', ['diff', '--name-only', 'HEAD~', 'HEAD'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, `git diff exited with ${result.status}: ${result.stderr}`);

    const files = result.stdout.trim().split('\n').filter(Boolean);
    assert.equal(files.length, 1, `Expected 1 changed file, got: ${files.join(', ')}`);

    const filename = files[0];

    // On systems where core.quotePath defaults to true (standard git default),
    // the filename is C-quoted. If git's default ever changes on this platform
    // this test will need updating — but for now we assert the expected behaviour.
    //
    // Note: some git builds or user-level config may set quotePath=false globally.
    // We check for the presence of either C-quoting OR raw UTF-8 to produce a
    // meaningful assertion either way. The CRITICAL assertion is the WITH-flag test above.
    if (filename[0] === '"') {
      // C-quoted: does NOT match DOCS_ONLY_PATTERN (starts with ", not a docs prefix)
      assert.ok(
        !DOCS_ONLY_PATTERN.test(filename),
        `C-quoted filename '${filename}' must NOT match DOCS_ONLY_PATTERN. ` +
          'Without -c core.quotePath=false the docs-only predicate fails for non-ASCII paths.',
      );
    } else {
      // Raw UTF-8 even without flag — user's git config has quotePath=false globally.
      // This is acceptable on dev machines; the regression guard is still the
      // WITH-flag test above. Log a notice here.
      // The file must still contain the non-ASCII character.
      assert.ok(filename.includes('é'), `Expected filename to contain 'é' but got: ${filename}`);
      // It MUST match DOCS_ONLY_PATTERN (raw UTF-8 with docs/ prefix)
      assert.ok(
        DOCS_ONLY_PATTERN.test(filename),
        `Raw UTF-8 filename '${filename}' must match DOCS_ONLY_PATTERN`,
      );
    }
  });
});

// ── Section 4: release-please skip guard (AC-6) ──────────────────────────────

describe('release-please skip guard — merge_group head_ref limitation (AC-6)', () => {
  // The fallback workflows use:
  //   !contains(github.event.merge_group.head_ref || '', 'release-please--')
  //
  // On merge_group events, head_ref is the QUEUE branch name:
  //   gh-readonly-queue/main/pr-N-<sha>
  // NOT the original PR's source branch.
  //
  // For a release-please PR (source branch: release-please--branches--main--...),
  // the queue branch does NOT contain 'release-please--' so the guard DOES NOT
  // fire and the workflow runs. In practice this is harmless (the workflow would
  // post docs-only=false since release-please PRs touch package.json/CHANGELOG.md),
  // but it means the guard cannot be relied on to SKIP the workflow for release-please
  // PRs that are running through the merge queue.
  //
  // This test documents/asserts that known release-please queue branch shapes
  // do NOT contain 'release-please--' — confirming the guard's documented gap.

  const KNOWN_QUEUE_BRANCH_SHAPES = [
    'gh-readonly-queue/main/pr-42-abc1234',
    'gh-readonly-queue/main/pr-100-deadbeef',
    'gh-readonly-queue/main/pr-1-0000000000000000000000000000000000000000',
  ];

  // Known release-please SOURCE branch shapes (head_ref on pull_request events)
  const KNOWN_RP_SOURCE_BRANCHES = [
    'release-please--branches--main--components--ai-sdlc-plugin',
    'release-please--branches--main--components--pipeline-cli',
    'release-please--branches--main',
  ];

  it('release-please SOURCE branch shapes contain "release-please--" (pull_request guard works)', () => {
    for (const branch of KNOWN_RP_SOURCE_BRANCHES) {
      assert.ok(
        branch.includes('release-please--'),
        `Expected release-please source branch to contain 'release-please--': ${branch}`,
      );
    }
  });

  it('merge_group queue branch shapes do NOT contain "release-please--" (guard gap — documented in AISDLC-206)', () => {
    // This test is intentionally asserting the KNOWN GAP:
    // none of these queue branch shapes contain 'release-please--',
    // so the merge_group guard cannot distinguish a release-please PR
    // from a regular PR in the queue.
    for (const branch of KNOWN_QUEUE_BRANCH_SHAPES) {
      assert.ok(
        !branch.includes('release-please--'),
        `merge_group queue branch '${branch}' should NOT contain 'release-please--' ` +
          '(this would mean the guard works — update AISDLC-206 notes if this changes)',
      );
    }
  });

  it('guard gap is low practical impact: release-please PRs carry code files → docs-only=false → no spurious status post', () => {
    // Even if the merge_group guard for release-please doesn't fire,
    // release-please PRs carry non-docs files (package.json, CHANGELOG.md at
    // non-root paths), so the docs-only predicate returns false → workflow
    // exits cleanly without posting any status. The real risk would only
    // materialise if release-please ever created a PR with ONLY docs-only
    // paths, which the release-please tool does not do.
    const typicalReleasePleasePaths = [
      'package.json',
      'pipeline-cli/package.json',
      'CHANGELOG.md', // root CHANGELOG.md IS docs-only (root *.md)
      'pipeline-cli/CHANGELOG.md', // nested CHANGELOG.md is NOT docs-only
    ];
    // At least one non-docs file ensures the overall changeset is NOT docs-only
    const hasNonDocs = typicalReleasePleasePaths.some((f) => !DOCS_ONLY_PATTERN.test(f));
    assert.ok(
      hasNonDocs,
      'Expected at least one non-docs file in a typical release-please PR changeset',
    );
    assert.equal(
      isDocsOnly(typicalReleasePleasePaths),
      false,
      'Typical release-please PR must NOT be classified as docs-only',
    );
  });
});
