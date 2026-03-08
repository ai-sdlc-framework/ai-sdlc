/**
 * MCP server setup — detect coding agents and install MCP config.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

export interface DetectedAgent {
  name: string; // "Claude Code", "Cursor", etc.
  configPath: string; // relative path to MCP config file
  configKey: string; // "mcpServers" or "servers" (VS Code)
  serverEntry: Record<string, unknown>; // the ai-sdlc server config object
}

function standardEntry(env?: Record<string, string>): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    command: 'npx',
    args: ['-y', '@ai-sdlc/mcp-advisor'],
  };
  if (env) entry.env = env;
  return entry;
}

function vscodeEntry(env?: Record<string, string>): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@ai-sdlc/mcp-advisor'],
  };
  if (env) entry.env = env;
  return entry;
}

interface AgentSpec {
  name: string;
  configPath: string;
  configKey: string;
  entryFn: (env?: Record<string, string>) => Record<string, unknown>;
  configDir?: string; // directory signal (e.g. ".cursor")
  binary?: string; // binary to check on PATH
  alwaysDetect?: boolean;
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
];

function hasBinary(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface DetectAgentsOptions {
  /** When true, adds AI_SDLC_WORKSPACE env to server entries. */
  isWorkspace?: boolean;
}

export function detectAgents(projectDir: string, options?: DetectAgentsOptions): DetectedAgent[] {
  const detected: DetectedAgent[] = [];
  const env = options?.isWorkspace ? { AI_SDLC_WORKSPACE: '.' } : undefined;

  for (const spec of AGENT_SPECS) {
    if (spec.alwaysDetect) {
      detected.push({
        name: spec.name,
        configPath: spec.configPath,
        configKey: spec.configKey,
        serverEntry: spec.entryFn(env),
      });
      continue;
    }

    const hasDir = spec.configDir ? existsSync(join(projectDir, spec.configDir)) : false;
    const hasBin = spec.binary ? hasBinary(spec.binary) : false;

    if (hasDir || hasBin) {
      detected.push({
        name: spec.name,
        configPath: spec.configPath,
        configKey: spec.configKey,
        serverEntry: spec.entryFn(env),
      });
    }
  }

  return detected;
}

export function installMcpServer(
  projectDir: string,
  agent: DetectedAgent,
  dryRun: boolean,
): 'created' | 'merged' | 'skipped' {
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
      [agent.configKey]: {
        'ai-sdlc': agent.serverEntry,
      },
    };
    writeFileSync(fullPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }
  return 'created';
}
