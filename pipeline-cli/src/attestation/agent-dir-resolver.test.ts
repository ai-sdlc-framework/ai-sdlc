/**
 * AISDLC-583 — unit tests for `resolveInstalledPluginAgentDir`, the
 * driver-side resolver injected into `runVerifier({ agentDir })` so
 * `cli-attestation verify` resolves reviewer agent-definition files from
 * the INSTALLED plugin instead of a monorepo-only, unguarded path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveInstalledPluginAgentDir,
  highestVersionCacheAgentsDir,
  isInsideRepoRoot,
} from './agent-dir-resolver.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  delete process.env['CLAUDE_PLUGIN_DIR'];
  delete process.env['CLAUDE_PLUGIN_ROOT'];
}

describe('resolveInstalledPluginAgentDir (AISDLC-583)', () => {
  let base: string;

  beforeEach(() => {
    resetEnv();
    base = mkdtempSync(join(tmpdir(), 'agent-dir-resolver-'));
  });

  afterEach(() => {
    removeFixtureDir(base);
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns null when neither env var is set and the injected cache root does not exist', () => {
    // No env vars set + a cache root that does not exist → the whole
    // resolver degrades to null. Injecting a nonexistent cacheRoot keeps this
    // deterministic regardless of the machine's real ~/.claude/plugins/cache.
    const missingCache = join(base, 'no-such-cache');
    expect(resolveInstalledPluginAgentDir(missingCache)).toBeNull();
  });

  it('resolves from $CLAUDE_PLUGIN_ROOT/agents when it exists', () => {
    const pluginDir = join(base, 'plugin-root');
    const agentsDir = join(pluginDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'code-reviewer.md'), 'body\n');
    process.env['CLAUDE_PLUGIN_ROOT'] = pluginDir;

    expect(resolveInstalledPluginAgentDir()).toBe(agentsDir);
  });

  it('resolves from $CLAUDE_PLUGIN_DIR/agents when $CLAUDE_PLUGIN_ROOT/agents does not exist', () => {
    const rootDir = join(base, 'plugin-root-missing');
    process.env['CLAUDE_PLUGIN_ROOT'] = rootDir; // does not exist on disk

    const pluginDir = join(base, 'plugin-dir');
    const agentsDir = join(pluginDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'code-reviewer.md'), 'body\n');
    process.env['CLAUDE_PLUGIN_DIR'] = pluginDir;

    expect(resolveInstalledPluginAgentDir()).toBe(agentsDir);
  });

  it('prefers $CLAUDE_PLUGIN_ROOT over $CLAUDE_PLUGIN_DIR when both resolve', () => {
    const rootAgents = join(base, 'root', 'agents');
    mkdirSync(rootAgents, { recursive: true });
    process.env['CLAUDE_PLUGIN_ROOT'] = join(base, 'root');

    const dirAgents = join(base, 'dir', 'agents');
    mkdirSync(dirAgents, { recursive: true });
    process.env['CLAUDE_PLUGIN_DIR'] = join(base, 'dir');

    expect(resolveInstalledPluginAgentDir()).toBe(rootAgents);
  });

  it('never throws when env vars point at nonexistent paths', () => {
    process.env['CLAUDE_PLUGIN_ROOT'] = join(base, 'does-not-exist-root');
    process.env['CLAUDE_PLUGIN_DIR'] = join(base, 'does-not-exist-dir');

    expect(() => resolveInstalledPluginAgentDir()).not.toThrow();
  });

  it('degrades to null (never throws) when nothing resolves and the default cache root is used', () => {
    // No env vars, no cacheRoot arg → falls back to the real
    // ~/.claude/plugins/cache default. Must be safe regardless of machine
    // state (the point is "never throws").
    expect(() => resolveInstalledPluginAgentDir()).not.toThrow();
  });
});

// ── cache-probe tier (highestVersionCacheAgentsDir) ────────────────────────
// Injectable cacheRoot makes the walk deterministic on any machine (CI
// runners have no real ~/.claude/plugins/cache; a dev machine with the plugin
// installed does — the AISDLC-583 local-vs-CI coverage divergence).
describe('highestVersionCacheAgentsDir (AISDLC-583)', () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), 'agent-dir-cache-'));
  });
  afterEach(() => {
    removeFixtureDir(cacheRoot);
  });

  /** Create `<cacheRoot>/<marketplace>/ai-sdlc/<version>/agents`. */
  function seed(marketplace: string, version: string): string {
    const agentsDir = join(cacheRoot, marketplace, 'ai-sdlc', version, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    return agentsDir;
  }

  it('returns null when the cache root does not exist', () => {
    expect(highestVersionCacheAgentsDir(join(cacheRoot, 'missing'))).toBeNull();
  });

  it('returns null when the cache root exists but has no ai-sdlc/*/agents dirs', () => {
    mkdirSync(join(cacheRoot, 'some-marketplace', 'other-plugin'), { recursive: true });
    expect(highestVersionCacheAgentsDir(cacheRoot)).toBeNull();
  });

  it('resolves the single installed version', () => {
    const agents = seed('acme-marketplace', '0.20.1');
    expect(highestVersionCacheAgentsDir(cacheRoot)).toBe(agents);
  });

  it('picks the highest version across multiple versions (numeric, not lexical)', () => {
    seed('acme-marketplace', '0.9.0');
    const newest = seed('acme-marketplace', '0.20.1'); // 0.20.1 > 0.9.0 numerically
    expect(highestVersionCacheAgentsDir(cacheRoot)).toBe(newest);
  });

  it('picks the highest version across multiple marketplaces', () => {
    seed('mp-a', '0.19.0');
    const newest = seed('mp-b', '0.21.0');
    expect(highestVersionCacheAgentsDir(cacheRoot)).toBe(newest);
  });

  it('skips a version dir that has no agents/ subdir', () => {
    // Higher version present but WITHOUT an agents/ subdir → must fall back
    // to the lower version that does have one.
    mkdirSync(join(cacheRoot, 'mp', 'ai-sdlc', '0.22.0'), { recursive: true }); // no agents/
    const withAgents = seed('mp', '0.20.0');
    expect(highestVersionCacheAgentsDir(cacheRoot)).toBe(withAgents);
  });

  it('skips a marketplace with no ai-sdlc/ subdir', () => {
    mkdirSync(join(cacheRoot, 'unrelated-mp', 'some-other-plugin', '1.0.0'), { recursive: true });
    const agents = seed('real-mp', '0.20.0');
    expect(highestVersionCacheAgentsDir(cacheRoot)).toBe(agents);
  });

  it('is reached via resolveInstalledPluginAgentDir when no env vars are set', () => {
    const agents = seed('acme-marketplace', '0.20.1');
    expect(resolveInstalledPluginAgentDir(cacheRoot)).toBe(agents);
  });
});

describe('containment guard (AISDLC-584)', () => {
  let base: string;
  beforeEach(() => {
    resetEnv();
    base = mkdtempSync(join(tmpdir(), 'agent-dir-guard-'));
  });
  afterEach(() => {
    removeFixtureDir(base);
    process.env = { ...ORIGINAL_ENV };
  });

  it('rejects a CLAUDE_PLUGIN_ROOT agents dir that lives inside repoRoot', () => {
    const repo = join(base, 'repo');
    const inside = join(repo, 'plugin', 'agents');
    mkdirSync(inside, { recursive: true });
    process.env['CLAUDE_PLUGIN_ROOT'] = join(repo, 'plugin');
    expect(resolveInstalledPluginAgentDir(join(base, 'no-cache'), repo)).toBeNull();
  });

  it('accepts an agents dir outside repoRoot', () => {
    const repo = join(base, 'repo');
    mkdirSync(repo, { recursive: true });
    const outside = join(base, 'plugin', 'agents');
    mkdirSync(outside, { recursive: true });
    process.env['CLAUDE_PLUGIN_ROOT'] = join(base, 'plugin');
    expect(resolveInstalledPluginAgentDir(join(base, 'no-cache'), repo)).toBe(outside);
  });

  it('rejects a cache hit inside repoRoot', () => {
    const repo = join(base, 'repo');
    const cacheRoot = join(repo, 'cache');
    mkdirSync(join(cacheRoot, 'mkt', 'ai-sdlc', '1.0.0', 'agents'), { recursive: true });
    expect(resolveInstalledPluginAgentDir(cacheRoot, repo)).toBeNull();
  });

  it('isInsideRepoRoot treats the root itself and nested paths as inside, siblings as outside', () => {
    const repo = join(base, 'repo');
    mkdirSync(repo, { recursive: true });
    expect(isInsideRepoRoot(repo, repo)).toBe(true);
    expect(isInsideRepoRoot(join(repo, 'a', 'b'), repo)).toBe(true);
    expect(isInsideRepoRoot(join(base, 'other'), repo)).toBe(false);
  });
});
