/**
 * MCP server setup — detect coding agents and install MCP config.
 *
 * AISDLC-78 changes:
 *  - The `npx -y` arg list now pins `@ai-sdlc/mcp-advisor@<version>` so
 *    fresh installs don't silently jump to whatever is published when
 *    the orchestrator binary itself was last updated. Each generated
 *    config file carries a single top-level `_aiSdlcComment` documenting
 *    how to opt back into floating-tag behaviour.
 *  - Cursor is no longer detected by binary-on-PATH alone; the user
 *    must either have a `.cursor/` directory present (real signal of
 *    use) or pass `--cursor` to opt in. This avoids writing
 *    `.cursor/mcp.json` into projects whose author has Cursor
 *    installed but is not using it on this repo.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

export interface DetectedAgent {
  name: string; // "Claude Code", "Cursor", etc.
  configPath: string; // relative path to MCP config file
  configKey: string; // "mcpServers" or "servers" (VS Code)
  serverEntry: Record<string, unknown>; // the ai-sdlc server config object
  /** File format of the config; defaults to JSON. Codex uses TOML. */
  format?: 'json' | 'toml';
}

/**
 * The opt-out comment we write alongside the pinned mcp-advisor entry.
 * Lives at the top level of the generated MCP config under a leading-
 * underscore key so JSON parsers and MCP clients ignore it; humans
 * editing by hand see exactly how to re-enable floating-latest behaviour.
 */
const PIN_OPT_OUT_COMMENT =
  'Pinned to the orchestrator version that ran `ai-sdlc init`. ' +
  'To always pull the latest published mcp-advisor, change args to ["-y", "@ai-sdlc/mcp-advisor"].';

function pinnedSpec(version: string | undefined): string {
  return version && version !== '0.0.0'
    ? `@ai-sdlc/mcp-advisor@${version}`
    : '@ai-sdlc/mcp-advisor';
}

function standardEntry(
  version: string | undefined,
  env?: Record<string, string>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    command: 'npx',
    args: ['-y', pinnedSpec(version)],
  };
  if (env) entry.env = env;
  return entry;
}

function vscodeEntry(
  version: string | undefined,
  env?: Record<string, string>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', pinnedSpec(version)],
  };
  if (env) entry.env = env;
  return entry;
}

/**
 * Render the ai-sdlc server as a Codex `config.toml` table. Documented in
 * docs/getting-started/mcp-advisor-setup.md; a test keeps both in sync.
 */
export function renderCodexToml(entry: Record<string, unknown>): string {
  const q = (v: unknown) => JSON.stringify(String(v));
  const args = ((entry.args as unknown[]) ?? []).map(q).join(', ');
  let out = `[mcp_servers.ai-sdlc]\ncommand = ${q(entry.command)}\nargs = [${args}]\n`;
  const env = entry.env as Record<string, string> | undefined;
  if (env && Object.keys(env).length > 0) {
    out += `\n[mcp_servers.ai-sdlc.env]\n`;
    for (const [k, v] of Object.entries(env)) out += `${k} = ${q(v)}\n`;
  }
  return out;
}

const CODEX_TOML_HEADER = /^\s*\[mcp_servers\.(?:ai-sdlc|"ai-sdlc")(?:\.[^\]]*)?\]/m;

function installTomlMcpServer(
  projectDir: string,
  agent: DetectedAgent,
  dryRun: boolean,
): 'created' | 'merged' | 'skipped' {
  const fullPath = join(projectDir, agent.configPath);
  const block = renderCodexToml(agent.serverEntry);
  if (existsSync(fullPath)) {
    const existing = readFileSync(fullPath, 'utf-8');
    if (CODEX_TOML_HEADER.test(existing)) return 'skipped';
    if (!dryRun) {
      const sep =
        existing.length === 0 || existing.endsWith('\n\n')
          ? ''
          : existing.endsWith('\n')
            ? '\n'
            : '\n\n';
      writeFileSync(fullPath, existing + sep + block, 'utf-8');
    }
    return 'merged';
  }
  if (!dryRun) {
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `# ${PIN_OPT_OUT_COMMENT}\n${block}`, 'utf-8');
  }
  return 'created';
}

interface AgentSpec {
  format?: 'json' | 'toml';
  name: string;
  configPath: string;
  configKey: string;
  entryFn: (version: string | undefined, env?: Record<string, string>) => Record<string, unknown>;
  configDir?: string; // directory signal (e.g. ".cursor")
  binary?: string; // binary to check on PATH
  alwaysDetect?: boolean;
  /** Requires explicit opt-in (e.g. --cursor) even if signals are present. */
  requiresOptIn?: boolean;
}

const AGENT_SPECS: AgentSpec[] = [
  {
    name: 'Claude Code',
    configPath: '.mcp.json',
    configKey: 'mcpServers',
    entryFn: standardEntry,
    binary: 'claude',
    alwaysDetect: true,
  },
  {
    name: 'Cursor',
    configPath: '.cursor/mcp.json',
    configKey: 'mcpServers',
    entryFn: standardEntry,
    configDir: '.cursor',
    binary: 'cursor',
    requiresOptIn: true,
  },
  {
    name: 'VS Code',
    configPath: '.vscode/mcp.json',
    configKey: 'servers',
    entryFn: vscodeEntry,
    configDir: '.vscode',
    binary: 'code',
  },
  {
    name: 'Windsurf',
    configPath: '.windsurf/mcp.json',
    configKey: 'mcpServers',
    entryFn: standardEntry,
    configDir: '.windsurf',
    binary: 'windsurf',
  },
  {
    name: 'Codex',
    configPath: '.codex/config.toml',
    configKey: 'mcp_servers',
    format: 'toml',
    entryFn: standardEntry,
    configDir: '.codex',
    binary: 'codex',
  },
];

function hasBinary(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasUserCursorDir(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return false;
  return existsSync(join(home, '.cursor'));
}

export interface DetectAgentsOptions {
  /** When true, adds AI_SDLC_WORKSPACE env to server entries. */
  isWorkspace?: boolean;
  /** Pin the mcp-advisor to this version in generated configs. */
  pinVersion?: string;
  /** User explicitly asked for Cursor MCP install. */
  cursorOptIn?: boolean;
}

/**
 * Returned alongside detected agents to log skip decisions.
 */
export interface DetectAgentsResult {
  detected: DetectedAgent[];
  /** Per-spec skip explanations for human-readable logging. */
  skipped: Array<{ name: string; reason: string }>;
}

export function detectAgentsDetailed(
  projectDir: string,
  options?: DetectAgentsOptions,
): DetectAgentsResult {
  const detected: DetectedAgent[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const env = options?.isWorkspace ? { AI_SDLC_WORKSPACE: '.' } : undefined;
  const pinVersion = options?.pinVersion;

  for (const spec of AGENT_SPECS) {
    if (spec.alwaysDetect) {
      detected.push({
        name: spec.name,
        configPath: spec.configPath,
        configKey: spec.configKey,
        serverEntry: spec.entryFn(pinVersion, env),
        ...(spec.format ? { format: spec.format } : {}),
      });
      continue;
    }

    const hasDir = spec.configDir ? existsSync(join(projectDir, spec.configDir)) : false;
    const hasBin = spec.binary ? hasBinary(spec.binary) : false;

    if (spec.requiresOptIn) {
      // For Cursor specifically: explicit --cursor flag, OR a project-local
      // .cursor/ dir, OR a user-global ~/.cursor/ presence. Just having
      // `cursor` on PATH is no longer sufficient (too noisy on dev boxes
      // where Cursor is installed but not used per-project).
      const userOptIn = options?.cursorOptIn === true;
      if (userOptIn || hasDir || hasUserCursorDir()) {
        detected.push({
          name: spec.name,
          configPath: spec.configPath,
          configKey: spec.configKey,
          serverEntry: spec.entryFn(pinVersion, env),
          ...(spec.format ? { format: spec.format } : {}),
        });
      } else {
        skipped.push({
          name: spec.name,
          reason:
            'no .cursor/ directory in project or $HOME; pass --cursor to install Cursor MCP config',
        });
      }
      continue;
    }

    if (hasDir || hasBin) {
      detected.push({
        name: spec.name,
        configPath: spec.configPath,
        configKey: spec.configKey,
        serverEntry: spec.entryFn(pinVersion, env),
        ...(spec.format ? { format: spec.format } : {}),
      });
    }
  }

  return { detected, skipped };
}

/**
 * Backwards-compatible wrapper. New code should prefer detectAgentsDetailed.
 */
export function detectAgents(projectDir: string, options?: DetectAgentsOptions): DetectedAgent[] {
  return detectAgentsDetailed(projectDir, options).detected;
}

export function installMcpServer(
  projectDir: string,
  agent: DetectedAgent,
  dryRun: boolean,
): 'created' | 'merged' | 'skipped' {
  if (agent.format === 'toml') return installTomlMcpServer(projectDir, agent, dryRun);
  const fullPath = join(projectDir, agent.configPath);

  if (existsSync(fullPath)) {
    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(readFileSync(fullPath, 'utf-8'));
    } catch {
      // If the file is malformed JSON, treat as new
      existing = {};
    }

    const section = (existing[agent.configKey] ?? {}) as Record<string, unknown>;

    if (section['ai-sdlc']) {
      return 'skipped';
    }

    if (!dryRun) {
      section['ai-sdlc'] = agent.serverEntry;
      existing[agent.configKey] = section;
      // Top-level pin-comment: standard convention is a single
      // `_aiSdlcComment` key at the root of the document, not inside each
      // server entry. We add it on first write but never overwrite an
      // existing top-level value (caller may have customised it).
      if (!('_aiSdlcComment' in existing)) {
        existing._aiSdlcComment = PIN_OPT_OUT_COMMENT;
      }
      writeFileSync(fullPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    }
    return 'merged';
  }

  if (!dryRun) {
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const config = {
      _aiSdlcComment: PIN_OPT_OUT_COMMENT,
      [agent.configKey]: {
        'ai-sdlc': agent.serverEntry,
      },
    };
    writeFileSync(fullPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }
  return 'created';
}
