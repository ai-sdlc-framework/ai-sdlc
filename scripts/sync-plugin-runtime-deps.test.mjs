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
  nextMajorUpperBound,
  applyPinsToManifest,
  findManifestMismatches,
  REPO_ROOT,
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
      '@ai-sdlc/orchestrator': '>=0.19.0 <1.0.0',
      '@ai-sdlc/pipeline-cli': '>=0.19.0 <1.0.0',
    });
  });

  it('returns {} when pins already match the workspace version (forward-floating format)', () => {
    const desired = computeDesiredPins(root, {
      '@ai-sdlc/orchestrator': '>=0.19.0 <1.0.0',
      '@ai-sdlc/pipeline-cli': '>=0.19.0 <1.0.0',
    });
    assert.deepEqual(desired, {});
  });

  it('flags a package still pinned in the legacy caret format even when the floor matches (AISDLC-600)', () => {
    // The caret string itself is the caret-0.x trap this task closes — even
    // when its floor equals the workspace version, it must be rewritten to
    // the forward-floating range so future 0.x minors self-heal.
    const desired = computeDesiredPins(root, {
      '@ai-sdlc/orchestrator': '^0.19.0',
      '@ai-sdlc/pipeline-cli': '>=0.19.0 <1.0.0',
    });
    assert.deepEqual(desired, { '@ai-sdlc/orchestrator': '>=0.19.0 <1.0.0' });
  });

  it('flags only the package that drifted', () => {
    const desired = computeDesiredPins(root, {
      '@ai-sdlc/orchestrator': '>=0.19.0 <1.0.0',
      '@ai-sdlc/pipeline-cli': '^0.14.0',
    });
    assert.deepEqual(desired, { '@ai-sdlc/pipeline-cli': '>=0.19.0 <1.0.0' });
  });
});

describe('nextMajorUpperBound (AISDLC-600 code-review MAJOR)', () => {
  it('returns <1.0.0 for 0.x versions (float across all 0.x minors)', () => {
    assert.equal(nextMajorUpperBound('0.23.0'), '<1.0.0');
    assert.equal(nextMajorUpperBound('0.0.1'), '<1.0.0');
  });

  it('derives the next major for 1.x+ so the range never becomes empty at 1.0.0', () => {
    // The regression: a hardcoded `<1.0.0` would make computeDesiredPins emit
    // `>=1.0.0 <1.0.0` (empty/unsatisfiable) the moment a synced package hits
    // 1.0.0, breaking the self-heal `npm install`. Deriving the bound fixes it.
    assert.equal(nextMajorUpperBound('1.0.0'), '<2.0.0');
    assert.equal(nextMajorUpperBound('1.4.2'), '<2.0.0');
    assert.equal(nextMajorUpperBound('2.9.9'), '<3.0.0');
  });

  it('produces a satisfiable range at the 1.0.0 boundary via computeDesiredPins', () => {
    const root = buildFixtureRepo({
      orchestratorVersion: '1.0.0',
      pipelineCliVersion: '1.0.0',
      pins: { orchestrator: '>=0.23.0 <1.0.0', pipelineCli: '>=0.23.0 <1.0.0' },
    });
    try {
      const desired = computeDesiredPins(root, {
        '@ai-sdlc/orchestrator': '>=0.23.0 <1.0.0',
        '@ai-sdlc/pipeline-cli': '>=0.23.0 <1.0.0',
      });
      assert.deepEqual(desired, {
        '@ai-sdlc/orchestrator': '>=1.0.0 <2.0.0',
        '@ai-sdlc/pipeline-cli': '>=1.0.0 <2.0.0',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws on a malformed version rather than emitting a garbage pin', () => {
    assert.throws(() => nextMajorUpperBound('not-a-version'));
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
      '@ai-sdlc/orchestrator': '>=0.19.0 <1.0.0',
      '@ai-sdlc/pipeline-cli': '>=0.19.0 <1.0.0',
    });
    assert.equal(changed, true);
    const rewritten = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    assert.equal(rewritten.runtimeDependencies['@ai-sdlc/orchestrator'], '>=0.19.0 <1.0.0');
    assert.equal(rewritten.runtimeDependencies['@ai-sdlc/pipeline-cli'], '>=0.19.0 <1.0.0');
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

/**
 * The ONLY place this file shells out to the script. It always passes an
 * explicit fixture `--root`, so no case can depend on the repository's live
 * pins (AISDLC-1114).
 */
function runScript(root, args, env = {}) {
  assert.ok(root && root !== REPO_ROOT, 'runScript requires an explicit fixture root');
  return spawnSync(process.execPath, [SCRIPT, ...args, '--root', root], {
    encoding: 'utf-8',
    env: { ...process.env, GITHUB_HEAD_REF: '', GITHUB_REF_NAME: '', ...env },
  });
}

describe('CLI end-to-end (--check and write modes, fixture roots only)', () => {
  it('--check exits 0 on an in-sync fixture', () => {
    const root = buildFixtureRepo({
      orchestratorVersion: '0.20.5',
      pipelineCliVersion: '0.20.5',
      pins: { orchestrator: '>=0.20.5 <1.0.0', pipelineCli: '>=0.20.5 <1.0.0' },
    });
    try {
      assert.equal(runScript(root, ['--check']).status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--check exits 1 on a drifted fixture and names the drifted pin', () => {
    const root = buildFixtureRepo({
      orchestratorVersion: '0.20.5',
      pipelineCliVersion: '0.20.5',
      pins: { orchestrator: '>=0.20.5 <1.0.0', pipelineCli: '>=0.19.0 <1.0.0' },
    });
    try {
      const res = runScript(root, ['--check']);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /@ai-sdlc\/pipeline-cli pin drifted/);
      assert.doesNotMatch(res.stderr, /@ai-sdlc\/orchestrator pin drifted/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--check tolerates pin drift only on the release-please branch (AISDLC-956)', () => {
    const root = buildFixtureRepo({
      orchestratorVersion: '0.20.5',
      pipelineCliVersion: '0.20.5',
      pins: { orchestrator: '>=0.19.0 <1.0.0', pipelineCli: '>=0.19.0 <1.0.0' },
    });
    try {
      assert.equal(runScript(root, ['--check']).status, 1);
      assert.equal(runScript(root, ['--check'], { GITHUB_HEAD_REF: 'feat/other' }).status, 1);
      assert.equal(
        runScript(root, ['--check'], { GITHUB_HEAD_REF: 'release-please--branches--main' }).status,
        0,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write mode rewrites a drifted fixture, after which --check passes', () => {
    const root = buildFixtureRepo({
      orchestratorVersion: '0.20.5',
      pipelineCliVersion: '0.20.5',
      pins: { orchestrator: '^0.19.0', pipelineCli: '^0.19.0' },
    });
    try {
      assert.equal(runScript(root, []).status, 0);
      for (const p of MANIFEST_PATHS) {
        const m = JSON.parse(readFileSync(join(root, p), 'utf-8'));
        assert.equal(m.runtimeDependencies['@ai-sdlc/orchestrator'], '>=0.20.5 <1.0.0');
        assert.equal(m.runtimeDependencies['@ai-sdlc/pipeline-cli'], '>=0.20.5 <1.0.0');
      }
      assert.equal(runScript(root, ['--check']).status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--root without a directory exits 2', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--check', '--root'], { encoding: 'utf-8' });
    assert.equal(res.status, 2);
  });

  it('no case runs the script without an explicit fixture root (AISDLC-1114 guard)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
    const spawns = src.match(/spawnSync\(/g) ?? [];
    // runScript + the deliberate --root-missing case above.
    assert.equal(spawns.length, 2, 'shell out only through runScript(root, ...)');
    const helper = src.slice(src.indexOf('function runScript'), src.indexOf("describe('CLI end"));
    assert.match(helper, /'--root', root/);
  });
});

describe('findManifestMismatches / --pr (AISDLC-1068)', () => {
  const pins = { orchestrator: '>=0.20.5 <1.0.0', pipelineCli: '>=0.20.5 <1.0.0' };

  it('real repo manifests agree', () => {
    assert.deepEqual(findManifestMismatches(REPO_ROOT), []);
  });

  it('returns an entry when the two manifests differ', () => {
    const root = buildFixtureRepo({
      orchestratorVersion: '0.20.5',
      pipelineCliVersion: '0.20.5',
      pins,
    });
    try {
      const alt = join(root, 'ai-sdlc-plugin', '.claude-plugin', 'plugin.json');
      const m = JSON.parse(readFileSync(alt, 'utf-8'));
      m.runtimeDependencies['@ai-sdlc/orchestrator'] = '>=0.20.4 <1.0.0';
      writeFileSync(alt, JSON.stringify(m));
      const out = findManifestMismatches(root);
      assert.equal(out.length, 1);
      assert.match(out[0], /@ai-sdlc\/orchestrator/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const runPr = (root) => runScript(root, ['--pr']);

  it('CLI --pr exits 0 on agreement even when pins lag the workspace', () => {
    const root = buildFixtureRepo({
      orchestratorVersion: '0.20.5',
      pipelineCliVersion: '0.20.5',
      pins: { orchestrator: '>=0.19.0 <1.0.0', pipelineCli: '>=0.19.0 <1.0.0' },
    });
    try {
      assert.equal(runPr(root).status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CLI --pr exits 1 when the manifests disagree', () => {
    const root = buildFixtureRepo({
      orchestratorVersion: '0.20.5',
      pipelineCliVersion: '0.20.5',
      pins,
    });
    try {
      const alt = join(root, 'ai-sdlc-plugin', '.claude-plugin', 'plugin.json');
      const m = JSON.parse(readFileSync(alt, 'utf-8'));
      m.runtimeDependencies['@ai-sdlc/pipeline-cli'] = '>=0.1.0 <1.0.0';
      writeFileSync(alt, JSON.stringify(m));
      const res = runPr(root);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /manifests disagree/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CLI --pr exits 2 when a manifest is missing', () => {
    const root = buildFixtureRepo({
      orchestratorVersion: '0.20.5',
      pipelineCliVersion: '0.20.5',
      pins,
    });
    try {
      rmSync(join(root, 'ai-sdlc-plugin', '.claude-plugin', 'plugin.json'));
      assert.equal(runPr(root).status, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
