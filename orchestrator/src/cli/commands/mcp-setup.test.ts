/**
 * Tests for MCP server auto-detection and installation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectAgents, installMcpServer, type DetectedAgent } from './mcp-setup.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-setup-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── detectAgents ────────────────────────────────────────────────────

describe('detectAgents', () => {
  it('always detects Claude Code', () => {
    const agents = detectAgents(tmpDir);
    const names = agents.map((a) => a.name);
    expect(names).toContain('Claude Code');
  });

  it('detects Cursor when .cursor/ directory exists in the project', () => {
    mkdirSync(join(tmpDir, '.cursor'));
    const agents = detectAgents(tmpDir);
    const names = agents.map((a) => a.name);
    expect(names).toContain('Cursor');
  });

  it('detects Cursor when --cursor opt-in is passed even without .cursor/', () => {
    const agents = detectAgents(tmpDir, { cursorOptIn: true });
    const names = agents.map((a) => a.name);
    expect(names).toContain('Cursor');
  });

  it('detects VS Code when .vscode/ directory exists', () => {
    mkdirSync(join(tmpDir, '.vscode'));
    const agents = detectAgents(tmpDir);
    const names = agents.map((a) => a.name);
    expect(names).toContain('VS Code');
  });

  it('detects Windsurf when .windsurf/ directory exists', () => {
    mkdirSync(join(tmpDir, '.windsurf'));
    const agents = detectAgents(tmpDir);
    const names = agents.map((a) => a.name);
    expect(names).toContain('Windsurf');
  });

  it('does not detect Cursor without .cursor/ directory or opt-in', () => {
    // Cursor now requires explicit --cursor flag, project .cursor/ dir, or
    // a user-global ~/.cursor/. Binary-on-PATH alone is no longer enough,
    // so we ensure HOME points at a Cursor-free temp dir for the test.
    const prevHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const agents = detectAgents(tmpDir);
      const names = agents.map((a) => a.name);
      expect(names).not.toContain('Cursor');
      expect(names).toContain('Claude Code');
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('returns correct config paths and keys', () => {
    mkdirSync(join(tmpDir, '.cursor'));
    mkdirSync(join(tmpDir, '.vscode'));

    const agents = detectAgents(tmpDir);
    const map = new Map(agents.map((a) => [a.name, a]));

    expect(map.get('Claude Code')?.configPath).toBe('.mcp.json');
    expect(map.get('Claude Code')?.configKey).toBe('mcpServers');

    expect(map.get('Cursor')?.configPath).toBe('.cursor/mcp.json');
    expect(map.get('Cursor')?.configKey).toBe('mcpServers');

    expect(map.get('VS Code')?.configPath).toBe('.vscode/mcp.json');
    expect(map.get('VS Code')?.configKey).toBe('servers');
  });

  it('pins mcp-advisor to the supplied version in the npx args', () => {
    const agents = detectAgents(tmpDir, { pinVersion: '0.6.0', cursorOptIn: true });
    const claude = agents.find((a) => a.name === 'Claude Code');
    expect(claude).toBeDefined();
    const args = (claude!.serverEntry as { args: string[] }).args;
    expect(args).toEqual(['-y', '@ai-sdlc/mcp-advisor@0.6.0']);
    // The pin-opt-out comment is now written at the top level of the MCP
    // config file (see installMcpServer tests below), not inside each
    // server entry. So the entry itself must NOT carry the comment.
    expect((claude!.serverEntry as { _aiSdlcComment?: string })._aiSdlcComment).toBeUndefined();
  });

  it('omits the pin when no version is supplied (back-compat)', () => {
    const agents = detectAgents(tmpDir);
    const claude = agents.find((a) => a.name === 'Claude Code');
    expect(claude).toBeDefined();
    const args = (claude!.serverEntry as { args: string[] }).args;
    expect(args).toEqual(['-y', '@ai-sdlc/mcp-advisor']);
  });
});

// ── installMcpServer ────────────────────────────────────────────────

describe('installMcpServer', () => {
  const claudeAgent: DetectedAgent = {
    name: 'Claude Code',
    configPath: '.mcp.json',
    configKey: 'mcpServers',
    serverEntry: { command: 'npx', args: ['-y', '@ai-sdlc/mcp-advisor'] },
  };

  const cursorAgent: DetectedAgent = {
    name: 'Cursor',
    configPath: '.cursor/mcp.json',
    configKey: 'mcpServers',
    serverEntry: { command: 'npx', args: ['-y', '@ai-sdlc/mcp-advisor'] },
  };

  const vscodeAgent: DetectedAgent = {
    name: 'VS Code',
    configPath: '.vscode/mcp.json',
    configKey: 'servers',
    serverEntry: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@ai-sdlc/mcp-advisor'],
    },
  };

  it('creates new config file from scratch', () => {
    const result = installMcpServer(tmpDir, claudeAgent, false);
    expect(result).toBe('created');

    const content = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf-8'));
    expect(content.mcpServers['ai-sdlc']).toEqual({
      command: 'npx',
      args: ['-y', '@ai-sdlc/mcp-advisor'],
    });
  });

  it('creates parent directory when needed', () => {
    const result = installMcpServer(tmpDir, cursorAgent, false);
    expect(result).toBe('created');
    expect(existsSync(join(tmpDir, '.cursor', 'mcp.json'))).toBe(true);
  });

  it('merges into existing config file preserving other servers', () => {
    mkdirSync(join(tmpDir, '.cursor'));
    const existing = {
      mcpServers: {
        'other-server': { command: 'node', args: ['server.js'] },
      },
    };
    writeFileSync(join(tmpDir, '.cursor/mcp.json'), JSON.stringify(existing), 'utf-8');

    const result = installMcpServer(tmpDir, cursorAgent, false);
    expect(result).toBe('merged');

    const content = JSON.parse(readFileSync(join(tmpDir, '.cursor/mcp.json'), 'utf-8'));
    expect(content.mcpServers['other-server']).toEqual({
      command: 'node',
      args: ['server.js'],
    });
    expect(content.mcpServers['ai-sdlc']).toEqual({
      command: 'npx',
      args: ['-y', '@ai-sdlc/mcp-advisor'],
    });
  });

  it('skips when ai-sdlc entry already exists', () => {
    const existing = {
      mcpServers: {
        'ai-sdlc': { command: 'npx', args: ['-y', '@ai-sdlc/mcp-advisor'] },
      },
    };
    writeFileSync(join(tmpDir, '.mcp.json'), JSON.stringify(existing), 'utf-8');

    const result = installMcpServer(tmpDir, claudeAgent, false);
    expect(result).toBe('skipped');
  });

  it('uses servers key for VS Code config', () => {
    mkdirSync(join(tmpDir, '.vscode'));

    const result = installMcpServer(tmpDir, vscodeAgent, false);
    expect(result).toBe('created');

    const content = JSON.parse(readFileSync(join(tmpDir, '.vscode/mcp.json'), 'utf-8'));
    expect(content.servers['ai-sdlc']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@ai-sdlc/mcp-advisor'],
    });
    expect(content.mcpServers).toBeUndefined();
  });

  it('dry-run does not write files', () => {
    const result = installMcpServer(tmpDir, claudeAgent, true);
    expect(result).toBe('created');
    expect(existsSync(join(tmpDir, '.mcp.json'))).toBe(false);
  });

  it('dry-run returns merged for existing file without ai-sdlc', () => {
    const existing = {
      mcpServers: {
        'other-server': { command: 'node', args: ['server.js'] },
      },
    };
    writeFileSync(join(tmpDir, '.mcp.json'), JSON.stringify(existing), 'utf-8');

    const result = installMcpServer(tmpDir, claudeAgent, true);
    expect(result).toBe('merged');

    // File should not have been modified
    const content = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf-8'));
    expect(content.mcpServers['ai-sdlc']).toBeUndefined();
  });

  it('handles malformed JSON file gracefully', () => {
    writeFileSync(join(tmpDir, '.mcp.json'), '{ not valid json', 'utf-8');

    const result = installMcpServer(tmpDir, claudeAgent, false);
    expect(result).toBe('merged');

    const content = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf-8'));
    expect(content.mcpServers['ai-sdlc']).toEqual({
      command: 'npx',
      args: ['-y', '@ai-sdlc/mcp-advisor'],
    });
  });

  it('merges into existing file that has no configKey section yet', () => {
    writeFileSync(join(tmpDir, '.mcp.json'), JSON.stringify({ someOtherKey: true }), 'utf-8');

    const result = installMcpServer(tmpDir, claudeAgent, false);
    expect(result).toBe('merged');

    const content = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf-8'));
    expect(content.someOtherKey).toBe(true);
    expect(content.mcpServers['ai-sdlc']).toEqual({
      command: 'npx',
      args: ['-y', '@ai-sdlc/mcp-advisor'],
    });
  });

  it('writes the pin-opt-out comment at the top level when creating a new file', () => {
    installMcpServer(tmpDir, claudeAgent, false);
    const content = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf-8'));
    expect(typeof content._aiSdlcComment).toBe('string');
    expect(content._aiSdlcComment).toMatch(/Pinned to the orchestrator/);
    // And the per-entry comment must NOT be present.
    expect(content.mcpServers['ai-sdlc']._aiSdlcComment).toBeUndefined();
  });

  it('adds the top-level comment when merging into a file that lacks it', () => {
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
      'utf-8',
    );
    installMcpServer(tmpDir, claudeAgent, false);
    const content = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf-8'));
    expect(content._aiSdlcComment).toMatch(/Pinned to the orchestrator/);
    expect(content.mcpServers.other).toEqual({ command: 'x' });
  });

  it('preserves an existing top-level _aiSdlcComment instead of overwriting', () => {
    const userCustomised = 'My custom note about why this is pinned.';
    writeFileSync(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        _aiSdlcComment: userCustomised,
        mcpServers: { other: { command: 'x' } },
      }),
      'utf-8',
    );
    installMcpServer(tmpDir, claudeAgent, false);
    const content = JSON.parse(readFileSync(join(tmpDir, '.mcp.json'), 'utf-8'));
    expect(content._aiSdlcComment).toBe(userCustomised);
  });
});
