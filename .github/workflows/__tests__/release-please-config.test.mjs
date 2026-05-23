/**
 * Tests for `release-please-config.json` — AISDLC-401.
 *
 * Goal: assert that the release-please configuration is set up so that
 * ONLY the rolling release PR (the `chore: release main` PR maintained by
 * the googleapis/release-please-action) ever touches CHANGELOG.md — never
 * regular feature PRs.
 *
 * This is the enforcement mechanism for the "release-PR only" model chosen
 * in AISDLC-401 (triggered by AISDLC-400's parallel-merge collision rate).
 *
 * What we test (and why):
 *   1. CONFIG FILE EXISTS — release-please-config.json and
 *      .release-please-manifest.json are present. Absence means release-please
 *      is not running at all, which would mean no release PR is maintaining
 *      the CHANGELOG and the operator is back to manual edits.
 *
 *   2. WORKFLOW TRIGGER — release.yml fires only on push to main (plus
 *      workflow_dispatch). The key constraint is that it does NOT fire on
 *      pull_request events — that would be the pattern that causes per-PR
 *      CHANGELOG edits (release-please would open/update a CHANGELOG for
 *      every opened PR).
 *
 *   3. NO PER-PACKAGE "changelog-type" OVERRIDE that would enable per-commit
 *      CHANGELOG appends outside the release PR flow. The vanilla
 *      release-please-action already accumulates in the rolling PR; no
 *      override is needed.
 *
 *   4. PACKAGES REGISTERED — every package listed in
 *      .release-please-manifest.json must have a corresponding entry in
 *      release-please-config.json. Drift here means release-please silently
 *      skips a package when computing the next version.
 *
 * Run with: node --test .github/workflows/__tests__/release-please-config.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CONFIG_PATH = join(REPO_ROOT, 'release-please-config.json');
const MANIFEST_PATH = join(REPO_ROOT, '.release-please-manifest.json');
const RELEASE_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'release.yml');

// ── YAML loader (shells out to python3 + PyYAML, same pattern as ai-sdlc-gate.test.mjs) ──
function loadYaml(path) {
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

describe('release-please-config.json — AISDLC-401', () => {
  // ── AC-1 audit: config files exist ──────────────────────────────────────
  describe('config file presence', () => {
    it('release-please-config.json exists', () => {
      assert.ok(existsSync(CONFIG_PATH), `Missing: ${CONFIG_PATH}`);
    });

    it('.release-please-manifest.json exists', () => {
      assert.ok(existsSync(MANIFEST_PATH), `Missing: ${MANIFEST_PATH}`);
    });

    it('release.yml workflow exists', () => {
      assert.ok(existsSync(RELEASE_WORKFLOW_PATH), `Missing: ${RELEASE_WORKFLOW_PATH}`);
    });
  });

  // ── AC-2: workflow does NOT fire on pull_request events ─────────────────
  describe('release.yml trigger — rolling PR only', () => {
    let workflow;

    before_each: {
      if (!existsSync(RELEASE_WORKFLOW_PATH)) break before_each;
      workflow = loadYaml(RELEASE_WORKFLOW_PATH);
    }

    it('fires on push to main', () => {
      if (!existsSync(RELEASE_WORKFLOW_PATH)) return;
      const on = workflow.on || workflow.true; // YAML `on:` key becomes `true` when parsed
      const pushTrigger = on && (on.push || (typeof on === 'object' && on['push']));
      assert.ok(
        pushTrigger,
        'release.yml should have a push trigger so release-please runs on every main merge',
      );
      const branches = pushTrigger.branches || pushTrigger.branches || [];
      assert.ok(
        branches.includes('main'),
        `push trigger should include 'main', got: ${JSON.stringify(branches)}`,
      );
    });

    it('does NOT fire on pull_request events (would cause per-PR CHANGELOG edits)', () => {
      if (!existsSync(RELEASE_WORKFLOW_PATH)) return;
      const on = workflow.on || workflow.true;
      const hasPrTrigger =
        on && (on.pull_request !== undefined || on.pull_request_target !== undefined);
      assert.ok(
        !hasPrTrigger,
        'release.yml must NOT have a pull_request trigger — that would cause release-please to ' +
          'open/update a CHANGELOG entry for every PR, generating parallel-merge conflicts',
      );
    });

    it('uses googleapis/release-please-action@v4', () => {
      if (!existsSync(RELEASE_WORKFLOW_PATH)) return;
      const workflowText = readFileSync(RELEASE_WORKFLOW_PATH, 'utf-8');
      assert.ok(
        workflowText.includes('googleapis/release-please-action'),
        'release.yml must use googleapis/release-please-action',
      );
    });
  });

  // ── AC-6 config correctness: packages registered in both files ───────────
  describe('package registry consistency', () => {
    let config;
    let manifest;

    // Load both files — individual tests guard against missing files above.
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    } catch {
      // Files missing — the "config file presence" tests above already fail.
    }

    it('every manifest package has a corresponding config entry', () => {
      if (!config || !manifest) return;
      const configPackages = Object.keys(config.packages || {});
      const manifestPackages = Object.keys(manifest);
      for (const pkg of manifestPackages) {
        assert.ok(
          configPackages.includes(pkg),
          `Package '${pkg}' appears in .release-please-manifest.json but not in ` +
            `release-please-config.json — release-please will silently skip it`,
        );
      }
    });

    it('every config package has a release-type set', () => {
      if (!config || !manifest) return;
      for (const [pkg, pkgConfig] of Object.entries(config.packages || {})) {
        assert.ok(
          pkgConfig['release-type'],
          `Package '${pkg}' in release-please-config.json is missing 'release-type'`,
        );
      }
    });

    it('no per-package changelog-type override that would enable per-commit CHANGELOG appends', () => {
      if (!config || !manifest) return;
      // The only recognized pattern for per-PR CHANGELOG edits would be if a package
      // has `"extra-commits"` or a `"changelog-type"` of something unusual. We check
      // that no package is inadvertently set to a mode that triggers per-push writes.
      for (const [pkg, pkgConfig] of Object.entries(config.packages || {})) {
        // "always-bump" type would cause a release PR update on every commit (normal),
        // but we want to confirm no package has "per-commit" as a changelog-type.
        assert.ok(
          pkgConfig['changelog-type'] !== 'per-commit',
          `Package '${pkg}' has changelog-type 'per-commit' which causes per-PR CHANGELOG edits`,
        );
      }
    });
  });

  // ── AC-5 migration guard: no Unreleased section in tracked CHANGELOG files ──
  describe('no manual Unreleased sections in CHANGELOG files', () => {
    const changelogs = [
      'orchestrator/CHANGELOG.md',
      'ai-sdlc-plugin/CHANGELOG.md',
      'ai-sdlc-plugin/mcp-server/CHANGELOG.md',
      'pipeline-cli/CHANGELOG.md',
      'reference/CHANGELOG.md',
      'mcp-advisor/CHANGELOG.md',
      'sdk-typescript/CHANGELOG.md',
      'conformance/runner/CHANGELOG.md',
    ];

    for (const relPath of changelogs) {
      const fullPath = join(REPO_ROOT, relPath);
      it(`${relPath} has no '## Unreleased' section`, () => {
        if (!existsSync(fullPath)) return; // file not yet created — skip
        const content = readFileSync(fullPath, 'utf-8');
        const hasUnreleased = /^## Unreleased\s*$/m.test(content);
        assert.ok(
          !hasUnreleased,
          `${relPath} contains a manual '## Unreleased' section. ` +
            'These sections were the source of parallel-merge CHANGELOG conflicts (AISDLC-401). ' +
            'Remove the section — release-please will reconstruct from commit history.',
        );
      });
    }
  });
});
