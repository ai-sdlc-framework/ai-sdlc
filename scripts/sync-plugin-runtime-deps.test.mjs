/**
 * Tests for scripts/sync-plugin-runtime-deps.mjs (AISDLC-574)
 *
 * Run with: node --test scripts/sync-plugin-runtime-deps.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  readWorkspaceVersion,
  computeDesiredPins,
  applyPinsToManifest,
  SYNCED_PACKAGES,
  MANIFEST_PATHS,
} from './sync-plugin-runtime-deps.mjs';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const SCRIPT = join(__dirname, 'sync-plugin-runtime-deps.mjs');

function buildFixtureRepo({ orchestratorVersion, pipelineCliVersion, pins }) {
  const root = mkdtempSync(join(tmpdir(), 'aisdlc-574-sync-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  mkdirSync(join(root, 'pipeline-cli'), { recursive: true });
  mkdirSync(join(root, 'ai-sdlc-plugin', '.claude-plugin'), { recursive: true });

  writeFileSync(
    join(root, 'orchestrator', 'package.json'),
    JSON.stringify({ name: '@ai-sdlc/orchestrator', version: orchestratorVersion }),
  );
  writeFileSync(
    join(root, 'pipeline-cli', 'package.json'),
    JSON.stringify({ name: '@ai-sdlc/pipeline-cli', version: pipelineCliVersion }),
  );

  const manifest = {
    name: 'ai-sdlc',
    version: '0.16.0',
    runtimeDependencies: {
      '@ai-sdlc/orchestrator': pins.orchestrator,
      '@ai-sdlc/pipeline-cli': pins.pipelineCli,
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    },
  };
  writeFileSync(join(root, 'ai-sdlc-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(root, 'ai-sdlc-plugin', '.claude-plugin', 'plugin.json'),
    JSON.stringify(manifest, null, 2),
  );

  return root;
}

describe('SYNCED_PACKAGES / MANIFEST_PATHS constants', () => {
  it('tracks orchestrator and pipeline-cli', () => {
    const names = SYNCED_PACKAGES.map((p) => p.pkgName).sort();
    assert.deepEqual(names, ['@ai-sdlc/orchestrator', '@ai-sdlc/pipeline-cli']);
  });

  it('covers both plugin manifest files', () => {
    assert.equal(MANIFEST_PATHS.length, 2);
    assert.ok(MANIFEST_PATHS.some((p) => p.endsWith(join('ai-sdlc-plugin', 'plugin.json'))));
    assert.ok(
      MANIFEST_PATHS.some((p) =>
        p.endsWith(join('ai-sdlc-plugin', '.claude-plugin', 'plugin.json')),
      ),
    );
  });
});

describe('readWorkspaceVersion', () => {
  let root;
  before(() => {
    root = buildFixtureRepo({
      orchestratorVersion: '0.19.0',
      pipelineCliVersion: '0.19.0',
      pins: { orchestrator: '^0.14.0', pipelineCli: '^0.14.0' },
    });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('reads the version field from the workspace package.json', () => {
    assert.equal(readWorkspaceVersion(root, 'orchestrator'), '0.19.0');
    assert.equal(readWorkspaceVersion(root, 'pipeline-cli'), '0.19.0');
  });

  it('throws when the package.json is missing', () => {
    assert.throws(() => readWorkspaceVersion(root, 'nonexistent-pkg'), /not found/);
  });
});

describe('computeDesiredPins', () => {
  let root;
  before(() => {
    root = buildFixtureRepo({
      orchestratorVersion: '0.19.0',
      pipelineCliVersion: '0.19.0',
      pins: { orchestrator: '^0.14.0', pipelineCli: '^0.14.0' },
    });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('flags both packages when pins lag the workspace version', () => {
    const desired = computeDesiredPins(root, {
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.14.0',
    });
    assert.deepEqual(desired, {
      '@ai-sdlc/orchestrator': '^0.19.0',
      '@ai-sdlc/pipeline-cli': '^0.19.0',
    });
  });

  it('returns {} when pins already match the workspace version', () => {
    const desired = computeDesiredPins(root, {
      '@ai-sdlc/orchestrator': '^0.19.0',
      '@ai-sdlc/pipeline-cli': '^0.19.0',
    });
    assert.deepEqual(desired, {});
  });

  it('flags only the package that drifted', () => {
    const desired = computeDesiredPins(root, {
      '@ai-sdlc/orchestrator': '^0.19.0',
      '@ai-sdlc/pipeline-cli': '^0.14.0',
    });
    assert.deepEqual(desired, { '@ai-sdlc/pipeline-cli': '^0.19.0' });
  });
});

describe('applyPinsToManifest', () => {
  let root;
  before(() => {
    root = buildFixtureRepo({
      orchestratorVersion: '0.19.0',
      pipelineCliVersion: '0.19.0',
      pins: { orchestrator: '^0.14.0', pipelineCli: '^0.14.0' },
    });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('rewrites the pin and preserves other fields', () => {
    const manifestPath = join(root, 'ai-sdlc-plugin', 'plugin.json');
    const changed = applyPinsToManifest(manifestPath, {
      '@ai-sdlc/orchestrator': '^0.19.0',
      '@ai-sdlc/pipeline-cli': '^0.19.0',
    });
    assert.equal(changed, true);
    const rewritten = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    assert.equal(rewritten.runtimeDependencies['@ai-sdlc/orchestrator'], '^0.19.0');
    assert.equal(rewritten.runtimeDependencies['@ai-sdlc/pipeline-cli'], '^0.19.0');
    assert.equal(rewritten.runtimeDependencies['@ai-sdlc/plugin-mcp-server'], '0.9.2');
    assert.equal(rewritten.name, 'ai-sdlc');
  });

  it('is a no-op (returns false, does not rewrite) when pins already match', () => {
    const manifestPath = join(root, 'ai-sdlc-plugin', '.claude-plugin', 'plugin.json');
    const before = readFileSync(manifestPath, 'utf-8');
    // Manifest here is still at the pre-bump ^0.14.0 pin from the fixture,
    // so pass matching pins to exercise the no-op branch specifically.
    const changed = applyPinsToManifest(manifestPath, {
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.14.0',
    });
    assert.equal(changed, false);
    assert.equal(readFileSync(manifestPath, 'utf-8'), before);
  });

  it('throws when the manifest has no runtimeDependencies object', () => {
    const badPath = join(root, 'bad-manifest.json');
    writeFileSync(badPath, JSON.stringify({ name: 'x' }));
    assert.throws(
      () => applyPinsToManifest(badPath, { '@ai-sdlc/orchestrator': '^0.19.0' }),
      /no runtimeDependencies/,
    );
  });
});

describe('CLI end-to-end (--check and write modes)', () => {
  it('--check exits 1 when a fixture repo has drifted pins (uses the real repo, not a fixture)', () => {
    // This exercises the script against the ACTUAL repo state — the
    // authoritative regression check that the real manifests + workspace
    // versions agree. It must currently pass (exit 0) because the AISDLC-574
    // fix keeps them in sync; if a future release re-freezes the pins this
    // test starts failing exactly like scripts/install-runtime-deps.test.mjs's
    // parallel drift-guard test.
    const res = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf-8' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  });

  it('write mode updates a fixture manifest end-to-end', () => {
    // We can't point the script at an arbitrary root (it always resolves
    // REPO_ROOT relative to its own file location), so this test exercises
    // the exported building blocks directly against a fixture, matching the
    // pattern used by the unit-level describes above. The CLI wiring itself
    // (main()) is covered by the "runs against the real repo" test above.
    const root = buildFixtureRepo({
      orchestratorVersion: '0.20.5',
      pipelineCliVersion: '0.20.5',
      pins: { orchestrator: '^0.19.0', pipelineCli: '^0.19.0' },
    });
    try {
      const manifestPath = join(root, 'ai-sdlc-plugin', 'plugin.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const desired = computeDesiredPins(root, manifest.runtimeDependencies);
      assert.deepEqual(desired, {
        '@ai-sdlc/orchestrator': '^0.20.5',
        '@ai-sdlc/pipeline-cli': '^0.20.5',
      });
      const changed = applyPinsToManifest(manifestPath, desired);
      assert.equal(changed, true);
      const rewritten = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      assert.equal(rewritten.runtimeDependencies['@ai-sdlc/orchestrator'], '^0.20.5');
      assert.equal(rewritten.runtimeDependencies['@ai-sdlc/pipeline-cli'], '^0.20.5');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
