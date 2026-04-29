/**
 * Version provenance — surface the running CLI, orchestrator runtime,
 * and (optionally) plugin versions in one place so users can spot drift.
 *
 * Why this exists: the original CLI hardcoded `0.1.0` in commander while
 * the published `@ai-sdlc/orchestrator` package was at 0.6.0+. Operators
 * who ran `ai-sdlc --version` saw the stale literal and assumed the
 * orchestrator itself was that old. AISDLC-78 anchors `--version` to
 * the package.json that ships with the binary and warns when components
 * disagree.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VersionTriple {
  /** The CLI binary's reported version. Tracks the orchestrator package. */
  cli: string;
  /** The orchestrator runtime version (from @ai-sdlc/orchestrator/package.json). */
  orchestrator: string;
  /** The plugin version, if discoverable in the workspace. */
  plugin?: string;
  /** Whether any of the discoverable components disagree on version. */
  drift: boolean;
}

const FALLBACK_VERSION = '0.0.0';

function readPackageVersion(pkgPath: string): string | undefined {
  try {
    if (!existsSync(pkgPath)) return undefined;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the orchestrator package's own package.json. The CLI bundle
 * lives at `dist/cli/index.js` so we walk up two levels.
 */
function findOrchestratorPackageJson(): string {
  // import.meta.url points at the compiled CLI module location.
  const here = dirname(fileURLToPath(import.meta.url));
  // Try ../package.json (when running from dist/cli/) and ../../package.json
  // (when running from src/cli/ in tests via tsx).
  const candidates = [
    resolve(here, '..', 'package.json'),
    resolve(here, '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
        if (pkg.name === '@ai-sdlc/orchestrator') return candidate;
      } catch {
        // continue
      }
    }
  }
  return candidates[0];
}

/**
 * Best-effort search for the plugin manifest. We look in the project
 * working directory first (the common case for a co-located checkout),
 * then a few well-known parent paths. Returns undefined silently when
 * not found — the plugin is optional metadata.
 */
function findPluginVersion(workDir: string): string | undefined {
  const tries = [
    join(workDir, 'ai-sdlc-plugin', 'plugin.json'),
    join(workDir, '..', 'ai-sdlc-plugin', 'plugin.json'),
    join(workDir, '..', '..', 'ai-sdlc-plugin', 'plugin.json'),
  ];
  for (const t of tries) {
    const v = readPackageVersion(t);
    if (v) return v;
  }
  return undefined;
}

export interface ResolveVersionsOptions {
  /** Override the working directory used to discover the plugin. */
  workDir?: string;
  /** Inject an orchestrator package.json path (testing). */
  orchestratorPackageJsonPath?: string;
  /** Inject a plugin version (testing). */
  pluginVersionOverride?: string;
}

/**
 * Compute the active CLI/orchestrator/plugin versions.
 *
 * Drift detection: when at least two known components disagree on
 * version string (case-insensitive), `drift` is set. The plugin is
 * compared only when discovered.
 */
export function resolveVersions(opts: ResolveVersionsOptions = {}): VersionTriple {
  const orchPath = opts.orchestratorPackageJsonPath ?? findOrchestratorPackageJson();
  const orchestrator = readPackageVersion(orchPath) ?? FALLBACK_VERSION;
  // The CLI ships from the same package.json today, so cli === orchestrator
  // by construction. Drift detection between cli/orchestrator is therefore
  // a no-op until the CLI is split out (planned: a thinner veneer that
  // versions independently of the runtime). We keep them logically
  // separate so callers and tests don't have to change shape on that day.
  const cli = orchestrator;
  const plugin = opts.pluginVersionOverride ?? findPluginVersion(opts.workDir ?? process.cwd());

  const observed = [cli, orchestrator, plugin].filter((v): v is string => Boolean(v));
  const drift = new Set(observed.map((v) => v.toLowerCase())).size > 1;

  return { cli, orchestrator, plugin, drift };
}

/**
 * Render the canonical 3-line version block. Always emits a
 * trailing newline. When drift is detected, appends a warning line
 * pointing at the upgrade hint.
 *
 * The CLI and orchestrator rows are rendered separately even though
 * today they always show the same number — both ship from the same
 * `@ai-sdlc/orchestrator` package.json. The shape is intentionally
 * future-proofed: when the CLI is split into a thinner veneer with
 * its own version it will start to differ from the orchestrator
 * runtime, and operators are then trained to read both rows. Until
 * then a duplicate value is the honest answer.
 */
export function formatVersionBlock(versions: VersionTriple): string {
  const lines = [
    `ai-sdlc CLI:       ${versions.cli}`,
    `orchestrator:      ${versions.orchestrator}`,
    `plugin:            ${versions.plugin ?? '(not detected)'}`,
  ];
  if (versions.drift) {
    lines.push(
      '',
      'WARN  versions out of sync — components disagree.',
      '      Run `npm install -g @ai-sdlc/orchestrator@latest` (or pnpm equivalent) to align.',
    );
  }
  return lines.join('\n');
}

/**
 * Return the upgrade hint shown by unknown-subcommand handler and by
 * version drift warnings. Centralised so tests can assert one string.
 */
export function upgradeHint(versions: VersionTriple): string {
  if (versions.drift) {
    return `Detected version drift (cli=${versions.cli}, orchestrator=${versions.orchestrator}${
      versions.plugin ? `, plugin=${versions.plugin}` : ''
    }). Run \`npm install -g @ai-sdlc/orchestrator@latest\` to align.`;
  }
  return `Run \`ai-sdlc --version\` to confirm you are on the latest @ai-sdlc/orchestrator (currently ${versions.orchestrator}).`;
}
